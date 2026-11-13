import type { ZCodeAgentServiceAccountHelpers } from "./zcodeAgentServiceAccountHelpers.js";
import type { ZCodeAgentServiceSessionHelpers } from "./zcodeAgentServiceSessionHelpers.js";
import type { ZCodeAgentServiceState } from "./zcodeAgentServiceState.js";
import type { ZCodeAgentWorkspaceTarget } from "./zcodeAgent.js";
import type { ZCodeProtocolClient } from "./zcodeProtocolClient.js";
import {
  OFF_PEAK_PROVIDER_IDS,
  resolveWorkspaceKey,
  type ZCodeProtocolRequest,
  zcodeAutomationCheckTaskBindingParamsSchema,
  zcodeAutomationCreateParamsSchema,
  zcodeAutomationDeleteParamsSchema,
  zcodeAutomationListParamsSchema,
  zcodeAutomationUpdateParamsSchema,
  zcodeBrowserExecuteParamsSchema,
  zcodeBrowserListParamsSchema,
  zcodeOffPeakCreateParamsSchema,
  zcodeOffPeakListParamsSchema,
} from "@zcode/shared";
import {
  resolveOffPeakAllowedModels,
  resolveOffPeakCreateModel,
  resolveOffPeakToolSelection,
  respondOffPeakInternalError,
  toProtocolAutomation,
  toProtocolOffPeakTaskSnapshot,
} from "./zcodeAgentServiceParams.js";

export function createRequestHandlersC(
  ctx: ZCodeAgentServiceState & ZCodeAgentServiceSessionHelpers & ZCodeAgentServiceAccountHelpers,
) {
  const { automationService, automationTaskIndexRepo, options } = ctx;

  // browser-use discovery：backend 在线状态与 plugin/skill 是否暴露是两层状态。
  // executor 缺省时返回空列表，禁止 facade 伪造 IAB available。
  function handleInteractionBrowserListRequest(
    client: ZCodeProtocolClient,
    workspace: ZCodeAgentWorkspaceTarget,
    request: ZCodeProtocolRequest,
  ): void {
    const parsed = zcodeBrowserListParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      void client.respondError(request.id, {
        code: -32602,
        message: "Invalid interaction/browserList params",
        data: parsed.error.flatten(),
      });
      return;
    }
    const executor = options?.browserControlExecutor;
    if (!executor) {
      void client.respond(request.id, { browsers: [] });
      return;
    }
    void executor
      .list(parsed.data)
      .then((browsers) => client.respond(request.id, { browsers }))
      .catch((error: unknown) => {
        void client.respondError(request.id, {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return;
  }

  // browser-use：agent 的 agent.browsers.* 经 interaction/browserExecute 到达这里。
  // 纯 RPC 中继——转发给 main（WebContentsView+CDP）执行后 respondResult，不 emitSessionEvent、
  // 不进 pending map（区别于 permission 的 UI 阻塞语义）。executor 缺省则 backend_unavailable。
  function handleInteractionBrowserExecuteRequest(
    client: ZCodeProtocolClient,
    workspace: ZCodeAgentWorkspaceTarget,
    request: ZCodeProtocolRequest,
  ): void {
    const parsed = zcodeBrowserExecuteParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      void client.respondError(request.id, {
        code: -32602,
        message: "Invalid interaction/browserExecute params",
        data: parsed.error.flatten(),
      });
      return;
    }
    const executor = options?.browserControlExecutor;
    if (!executor) {
      void client.respond(request.id, {
        ok: false,
        error: {
          code: "backend_unavailable",
          message: "browser control not available",
        },
        elapsedMs: 0,
      });
      return;
    }
    void executor
      .execute({
        requestId: parsed.data.requestId,
        ...(parsed.data.browserId ? { browserId: parsed.data.browserId } : {}),
        ...(parsed.data.browserGeneration !== undefined
          ? { browserGeneration: parsed.data.browserGeneration }
          : {}),
        sessionId: parsed.data.sessionId,
        ...(parsed.data.turnId ? { turnId: parsed.data.turnId } : {}),
        workspaceKey: parsed.data.workspaceKey ?? resolveWorkspaceKey(workspace),
        workspacePath: parsed.data.workspacePath ?? workspace.workspacePath,
        ...((parsed.data.workspaceIdentity ?? workspace.workspaceIdentity)
          ? {
              workspaceIdentity: parsed.data.workspaceIdentity ?? workspace.workspaceIdentity,
            }
          : {}),
        ...(parsed.data.remoteSessionId ? { remoteSessionId: parsed.data.remoteSessionId } : {}),
        clientMode: parsed.data.clientMode ?? "desktop-continuous",
        sessionContext: parsed.data.sessionContext ?? "live",
        command: parsed.data.command,
      })
      .then((result) => client.respond(request.id, result))
      .catch((error: unknown) => {
        void client.respond(request.id, {
          ok: false,
          error: {
            code: "execution_error",
            message: error instanceof Error ? error.message : String(error),
          },
          elapsedMs: 0,
        });
      });
    return;
  }

  function handleAutomationCreateRequest(
    client: ZCodeProtocolClient,
    workspace: ZCodeAgentWorkspaceTarget,
    request: ZCodeProtocolRequest,
  ): void {
    const parsed = zcodeAutomationCreateParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      void client.respondError(request.id, {
        code: -32602,
        message: "Invalid automation create params",
        data: parsed.error.flatten(),
      });
      return;
    }
    void (async () => {
      try {
        const automation = await automationService.create({
          title: parsed.data.title ?? "",
          cronExpr: parsed.data.cronExpr,
          relativeDelayMinutes: parsed.data.relativeDelayMinutes,
          // 会话侧长间隔 carrier（intervalUnit+interval）透传给 service 归一化为权威 scheduleRule。
          intervalUnit: parsed.data.intervalUnit,
          interval: parsed.data.interval,
          prompt: parsed.data.prompt,
          modelSelection: parsed.data.modelSelection,
          mode: parsed.data.mode,
          targetTaskId: parsed.data.targetTaskId,
          botDeliveryTarget: parsed.data.botDeliveryTarget,
          workspacePath: workspace.workspacePath,
          workspaceIdentity: workspace.workspaceIdentity,
          recurring: parsed.data.recurring ?? true,
          maxRuns: parsed.data.maxRuns,
        });
        if (automation.targetTaskId) {
          const taskMeta = await automationTaskIndexRepo
            .getTaskMeta({
              workspacePath: automation.workspacePath,
              workspaceIdentity: automation.workspaceIdentity,
              taskId: automation.targetTaskId,
            })
            .catch(() => null);
          if (taskMeta) {
            await automationTaskIndexRepo.updateTaskPresentation({
              ...taskMeta,
              presentation: {
                // 会话内创建的 automation 复用当前 session；显式写入标记供 V4 侧栏展示。
                cronAutomationId: automation.automationId,
              },
            });
          }
        }
        await client.respond(request.id, {
          automation: toProtocolAutomation(automation),
        });
      } catch (error) {
        await client.respondError(request.id, {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return;
  }

  function handleOffPeakCreateRequest(
    client: ZCodeProtocolClient,
    workspace: ZCodeAgentWorkspaceTarget,
    request: ZCodeProtocolRequest,
  ): void {
    const parsed = zcodeOffPeakCreateParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      void client.respondError(request.id, {
        code: -32602,
        message: "Invalid off-peak create params",
        data: parsed.error.flatten(),
      });
      return;
    }
    void (async () => {
      try {
        const offPeakTaskService = options?.resolveOffPeakTaskService?.();
        if (!offPeakTaskService) {
          await client.respondError(request.id, {
            code: -32601,
            message: "Off-peak task service is unavailable on this host",
          });
          return;
        }
        const grayConfig = await options?.resolveOffPeakClientConfig?.().catch(() => undefined);
        // 工具注册后灰度被关闭/配置解析失败时，不能继续走"白名单为空"的推导
        // （显式 model 会误报 model_not_allowed，省略 model 会以空模型落库）；直接返回稳定分类。
        // 模型视图可同时包含两个域；必须用已有支持快照确认归属，不能从首个 Provider 猜。
        const support =
          resolveOffPeakAllowedModels(grayConfig).length > 0
            ? await offPeakTaskService.getCodingPlanSupport()
            : undefined;
        const providerId = support?.supported
          ? OFF_PEAK_PROVIDER_IDS[support.providerFamily]
          : undefined;
        const allowedModels = providerId ? resolveOffPeakAllowedModels(grayConfig, providerId) : [];
        if (allowedModels.length === 0) {
          await client.respond(request.id, {
            ok: false,
            failureStage: "client_validation",
            errorCategory: "client_validation",
            errorCode: "offpeak_disabled",
          });
          return;
        }
        // model 白名单预校：显式入参不在白名单返回稳定分类，
        // 复用 client_validation 分类 + 专用 errorCode，不扩分类枚举。
        // 匹配与 thoughtLevel/UI 同语义（trim + 大小写不敏感），命中后回写白名单原写法。
        const model = resolveOffPeakCreateModel(allowedModels, parsed.data.model);
        if (model === null) {
          await client.respond(request.id, {
            ok: false,
            failureStage: "client_validation",
            errorCategory: "client_validation",
            errorCode: "model_not_allowed",
          });
          return;
        }
        const modelSelection =
          grayConfig && providerId
            ? resolveOffPeakToolSelection(
                grayConfig.modelSelectionView,
                providerId,
                model,
                parsed.data.thoughtLevel,
              )
            : undefined;
        if (!modelSelection) {
          await client.respond(request.id, {
            ok: false,
            failureStage: "client_validation",
            errorCategory: "client_validation",
            errorCode: "model_not_allowed",
          });
          return;
        }
        const result = await offPeakTaskService.createTask({
          title: parsed.data.title,
          prompt: parsed.data.prompt,
          permissionMode: parsed.data.permissionMode ?? "yolo",
          modelSelection,
          // 会话内创建绑定当前会话，派发时 resume 该会话执行。
          ...(parsed.data.boundSessionId ? { boundSessionId: parsed.data.boundSessionId } : {}),
          // workspace 由 host 从当前 session 注入（对称 automation/create），不进协议参数。
          workspacePath: workspace.workspacePath,
          ...(workspace.workspaceIdentity
            ? { workspaceIdentity: workspace.workspaceIdentity }
            : {}),
        });
        if (!result.ok) {
          // 失败分类原样过协议（不 respondError），供 CLI handler 翻译为稳定错误。
          await client.respond(request.id, {
            ok: false,
            failureStage: result.failureStage,
            errorCategory: result.errorCategory,
            errorCode: result.errorCode,
          });
          return;
        }
        await client.respond(request.id, {
          ok: true,
          task: toProtocolOffPeakTaskSnapshot(result.task),
        });
      } catch (error) {
        await respondOffPeakInternalError(client, request, workspace, error);
      }
    })();
    return;
  }

  function handleOffPeakListRequest(
    client: ZCodeProtocolClient,
    workspace: ZCodeAgentWorkspaceTarget,
    request: ZCodeProtocolRequest,
  ): void {
    const parsed = zcodeOffPeakListParamsSchema.safeParse(request.params ?? {});
    if (!parsed.success) {
      void client.respondError(request.id, {
        code: -32602,
        message: "Invalid off-peak list params",
        data: parsed.error.flatten(),
      });
      return;
    }
    void (async () => {
      try {
        const offPeakTaskService = options?.resolveOffPeakTaskService?.();
        if (!offPeakTaskService) {
          await client.respondError(request.id, {
            code: -32601,
            message: "Off-peak task service is unavailable on this host",
          });
          return;
        }
        const workspaceKey = resolveWorkspaceKey(workspace);
        const tasks = (await offPeakTaskService.list())
          .filter((task) => task.workspaceKey === workspaceKey)
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 20);
        await client.respond(request.id, {
          tasks: tasks.map(toProtocolOffPeakTaskSnapshot),
        });
      } catch (error) {
        await respondOffPeakInternalError(client, request, workspace, error);
      }
    })();
    return;
  }

  function handleAutomationListRequest(
    client: ZCodeProtocolClient,
    workspace: ZCodeAgentWorkspaceTarget,
    request: ZCodeProtocolRequest,
  ): void {
    const parsed = zcodeAutomationListParamsSchema.safeParse(request.params ?? {});
    if (!parsed.success) {
      void client.respondError(request.id, {
        code: -32602,
        message: "Invalid automation list params",
        data: parsed.error.flatten(),
      });
      return;
    }
    void (async () => {
      try {
        const automations = await automationService.list(workspace);
        await client.respond(request.id, {
          automations: automations.map(toProtocolAutomation),
        });
      } catch (error) {
        await client.respondError(request.id, {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return;
  }

  function handleAutomationCheckTaskBindingRequest(
    client: ZCodeProtocolClient,
    workspace: ZCodeAgentWorkspaceTarget,
    request: ZCodeProtocolRequest,
  ): void {
    const parsed = zcodeAutomationCheckTaskBindingParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      void client.respondError(request.id, {
        code: -32602,
        message: "Invalid automation task binding params",
        data: parsed.error.flatten(),
      });
      return;
    }
    void (async () => {
      try {
        const bound = await automationService.hasTaskBinding({
          workspacePath: workspace.workspacePath,
          workspaceIdentity: workspace.workspaceIdentity,
          targetTaskId: parsed.data.targetTaskId,
        });
        await client.respond(request.id, { bound });
      } catch (error) {
        await client.respondError(request.id, {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return;
  }

  function handleAutomationUpdateRequest(
    client: ZCodeProtocolClient,
    workspace: ZCodeAgentWorkspaceTarget,
    request: ZCodeProtocolRequest,
  ): void {
    const parsed = zcodeAutomationUpdateParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      void client.respondError(request.id, {
        code: -32602,
        message: "Invalid automation update params",
        data: parsed.error.flatten(),
      });
      return;
    }
    void (async () => {
      try {
        const automation = await automationService.update(
          parsed.data.automationId,
          {
            title: parsed.data.title,
            cronExpr: parsed.data.cronExpr,
            prompt: parsed.data.prompt,
            recurring: parsed.data.recurring,
            maxRuns: parsed.data.maxRuns,
            // 会话侧长间隔 carrier（intervalUnit+interval）透传给 service 归一化为权威 scheduleRule。
            intervalUnit: parsed.data.intervalUnit,
            interval: parsed.data.interval,
          },
          workspace,
        );
        if (!automation) {
          throw new Error("Scheduled task not found in the current workspace.");
        }
        await client.respond(request.id, {
          automation: toProtocolAutomation(automation),
        });
      } catch (error) {
        await client.respondError(request.id, {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return;
  }

  function handleAutomationDeleteRequest(
    client: ZCodeProtocolClient,
    workspace: ZCodeAgentWorkspaceTarget,
    request: ZCodeProtocolRequest,
  ): void {
    const parsed = zcodeAutomationDeleteParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      void client.respondError(request.id, {
        code: -32602,
        message: "Invalid automation delete params",
        data: parsed.error.flatten(),
      });
      return;
    }
    void (async () => {
      try {
        const deleted = await automationService.delete(parsed.data.automationId, workspace);
        await client.respond(request.id, { deleted });
      } catch (error) {
        await client.respondError(request.id, {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return;
  }

  return {
    handleInteractionBrowserListRequest,
    handleInteractionBrowserExecuteRequest,
    handleAutomationCreateRequest,
    handleOffPeakCreateRequest,
    handleOffPeakListRequest,
    handleAutomationListRequest,
    handleAutomationCheckTaskBindingRequest,
    handleAutomationUpdateRequest,
    handleAutomationDeleteRequest,
  };
}

export type ZCodeAgentServiceRequestHandlersC = ReturnType<typeof createRequestHandlersC>;
