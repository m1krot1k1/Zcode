import type { HostOpenCodeRun } from "./zcodeAgentServiceParams.js";
import type { ZCodeAgentServiceAccountHelpers } from "./zcodeAgentServiceAccountHelpers.js";
import type { ZCodeAgentServiceSessionHelpers } from "./zcodeAgentServiceSessionHelpers.js";
import type { ZCodeAgentServiceState } from "./zcodeAgentServiceState.js";
import type { ZCodeAgentWorkspaceTarget } from "./zcodeAgent.js";
import type { ZCodeProtocolClient } from "./zcodeProtocolClient.js";
import {
  channelReplyRequestSchema,
  resolveWorkspaceKey,
  subagentRuntimeConfigSchema,
  type SubagentRuntimeConfig,
  type ZCodeCodeIndexResult,
  type ZCodeProtocolRequest,
  zcodeCodeIndexQueryParamsSchema,
  zcodeCodeIndexQueryResultSchema,
  zcodeOpenCodeAgentRunRequestSchema,
  zcodeOpenCodeAgentRunResultSchema,
  zcodeSubagentsReadRuntimeConfigParamsSchema,
} from "@zcode/shared";
import { logger } from "./zcodeAgentServiceSupport.js";

export function createRequestHandlersA(
  ctx: ZCodeAgentServiceState & ZCodeAgentServiceSessionHelpers & ZCodeAgentServiceAccountHelpers,
) {
  const {
    activeClientsByWorkspaceKey,
    closeOpenCodeRun,
    emitOpenCodeRunEvent,
    mutable,
    normalizeOpenCodePermission,
    normalizeOpenCodeUpdate,
    openCodeRunKey,
    openCodeRuns,
    options,
  } = ctx;

  function handleInteractionRequestOpenCodeAgentRunRequest(
    client: ZCodeProtocolClient,
    workspace: ZCodeAgentWorkspaceTarget,
    request: ZCodeProtocolRequest,
  ): void {
    void (async () => {
      const parsed = zcodeOpenCodeAgentRunRequestSchema.safeParse(request.params);
      if (!parsed.success) {
        await client.respondError(request.id, {
          code: -32602,
          message: "Invalid OpenCode ACP run request",
        });
        return;
      }
      const params = parsed.data;
      const active = activeClientsByWorkspaceKey.get(resolveWorkspaceKey(workspace));
      if (mutable.serviceDisposing || active?.client !== client || client.isDisposed) {
        await client.respondError(request.id, {
          code: -32001,
          message: "OpenCode ACP request is not from the active workspace client",
        });
        return;
      }
      const currentWorkspace = active.workspace;
      const workspaceKey = resolveWorkspaceKey(currentWorkspace);
      const key = openCodeRunKey(workspaceKey, params.zcodeSessionId, params.commandId);
      const run = openCodeRuns.get(key);
      const runtime = options?.openCodeAcpRuntime;
      const toStatus = (current: HostOpenCodeRun) =>
        zcodeOpenCodeAgentRunResultSchema.parse({
          status: current.status,
          ...(current.opencodeSessionId ? { opencodeSessionId: current.opencodeSessionId } : {}),
          ...(current.diagnosticCode ? { diagnosticCode: current.diagnosticCode } : {}),
          ...(current.stopReason ? { stopReason: current.stopReason } : {}),
          ...(current.finalText ? { finalText: current.finalText } : {}),
        });

      if (params.operation === "getRunStatus") {
        await client.respond(
          request.id,
          run && run.client === client
            ? toStatus(run)
            : {
                status: "interrupted",
                diagnosticCode: run ? "host_connection_changed" : "host_run_not_found",
              },
        );
        return;
      }

      if (params.operation === "startRun") {
        if (run) {
          await client.respond(
            request.id,
            run.client === client
              ? toStatus(run)
              : {
                  status: "interrupted",
                  diagnosticCode: "host_connection_changed",
                },
          );
          return;
        }
        const existingActiveRun = [...openCodeRuns.values()].find(
          (item) =>
            item.workspaceKey === workspaceKey &&
            item.zcodeSessionId === params.zcodeSessionId &&
            !["completed", "cancelled", "failed", "interrupted"].includes(item.status),
        );
        if (existingActiveRun) {
          await client.respond(request.id, {
            status: "failed",
            diagnosticCode: "session_already_running",
          });
          return;
        }
        if (!runtime || !currentWorkspace.workspacePath.trim()) {
          await client.respond(request.id, {
            status: "failed",
            diagnosticCode: runtime ? "workspace_unavailable" : "acp_unavailable",
          });
          return;
        }
        if (openCodeRuns.size >= 128) {
          const terminalKey = [...openCodeRuns.entries()].find(([, item]) =>
            ["completed", "cancelled", "failed", "interrupted"].includes(item.status),
          )?.[0];
          if (terminalKey) openCodeRuns.delete(terminalKey);
          else {
            await client.respond(request.id, {
              status: "failed",
              diagnosticCode: "host_run_capacity",
            });
            return;
          }
        }
        const created: HostOpenCodeRun = {
          client,
          workspaceKey,
          zcodeSessionId: params.zcodeSessionId,
          commandId: params.commandId,
          runId: params.runId,
          status: "starting",
          permissions: new Map(),
          disposables: [],
          eventSequence: 0,
          eventDelivery: Promise.resolve(),
        };
        openCodeRuns.set(key, created);
        const startupCompletion = Promise.withResolvers<void>();
        created.startupPromise = startupCompletion.promise;
        created.disposables.push(
          client.onClose(() => {
            if (["completed", "cancelled", "failed", "interrupted"].includes(created.status))
              return;
            created.disconnectRequested = true;
            created.cancelRequested = true;
            created.status = "cancelling";
            void (async () => {
              if (created.opencodeSessionId) {
                await runtime
                  .cancel({ sessionId: created.opencodeSessionId })
                  .catch(() => undefined);
                await closeOpenCodeRun(created, "interrupted", {
                  diagnosticCode: "host_disconnected",
                });
              }
            })();
          }),
        );
        try {
          const session = await runtime.startSession({
            cwd: currentWorkspace.workspacePath,
          });
          created.opencodeSessionId = session.sessionId;
          if (created.disconnectRequested) {
            await closeOpenCodeRun(created, "interrupted", {
              diagnosticCode: "host_disconnected",
            });
            await client.respond(request.id, toStatus(created)).catch(() => undefined);
            return;
          }
          if (created.cancelRequested) {
            await closeOpenCodeRun(created, "cancelled", {
              diagnosticCode: "cancelled_before_prompt",
            });
            await client.respond(request.id, toStatus(created));
            return;
          }
          if (
            activeClientsByWorkspaceKey.get(workspaceKey)?.client !== client ||
            client.isDisposed
          ) {
            await closeOpenCodeRun(created, "interrupted", {
              diagnosticCode: "host_disconnected",
            });
            await client.respond(request.id, toStatus(created));
            return;
          }
          if (params.model.kind === "catalog") {
            const requestedModelId = params.model.modelId;
            const candidates = session.configOptions.filter((option) => {
              const select = option as {
                id: string;
                type?: string;
                options?: Array<{ value: string }>;
              };
              return (
                select.type === "select" &&
                select.options?.some((item) => item.value === requestedModelId)
              );
            });
            if (candidates.length !== 1) {
              await closeOpenCodeRun(created, "failed", {
                diagnosticCode: "model_option_unavailable",
              });
              await client.respond(request.id, toStatus(created));
              return;
            }
            const candidate = candidates[0] as { id: string };
            const updated = await runtime.setConfigOption({
              sessionId: session.sessionId,
              configId: candidate.id,
              value: requestedModelId,
            });
            if (created.disconnectRequested) {
              await closeOpenCodeRun(created, "interrupted", {
                diagnosticCode: "host_disconnected",
              });
              await client.respond(request.id, toStatus(created)).catch(() => undefined);
              return;
            }
            if (created.cancelRequested) {
              await closeOpenCodeRun(created, "cancelled", {
                diagnosticCode: "cancelled_before_prompt",
              });
              await client.respond(request.id, toStatus(created));
              return;
            }
            const applied = updated.configOptions.some((option) => {
              const select = option as {
                id: string;
                currentValue?: unknown;
              };
              return select.id === candidate.id && select.currentValue === requestedModelId;
            });
            if (!applied) {
              await closeOpenCodeRun(created, "failed", {
                diagnosticCode: "model_option_rejected",
              });
              await client.respond(request.id, toStatus(created));
              return;
            }
            created.modelOptionId = candidate.id;
            created.modelValue = requestedModelId;
          }
          created.disposables.push(
            runtime.onDynamicSessionUpdate({
              sessionId: session.sessionId,
            })((update) => normalizeOpenCodeUpdate(created, update)),
            runtime.onDynamicPermissionEvent({
              sessionId: session.sessionId,
            })((event) => normalizeOpenCodePermission(created, event)),
          );
          await emitOpenCodeRunEvent(created, {
            type: "started",
            ...(created.modelOptionId
              ? {
                  modelOptionId: created.modelOptionId,
                  modelValue: created.modelValue,
                }
              : {}),
          });
          if (created.disconnectRequested) {
            await closeOpenCodeRun(created, "interrupted", {
              diagnosticCode: "host_disconnected",
            });
            await client.respond(request.id, toStatus(created)).catch(() => undefined);
            return;
          }
          // Bug 原因：取消可能发生在 session/new 或模型选项 RPC 等待期间；仅调用 session/cancel
          // 会因尚无 prompt 而成为空操作。发送第一个 prompt 前再次读取同一 run 的取消所有权。
          if (created.cancelRequested) {
            await closeOpenCodeRun(created, "cancelled", {
              diagnosticCode: "cancelled_before_prompt",
            });
            await client.respond(request.id, toStatus(created));
            return;
          }
          if (
            activeClientsByWorkspaceKey.get(workspaceKey)?.client !== client ||
            client.isDisposed
          ) {
            await closeOpenCodeRun(created, "interrupted", {
              diagnosticCode: "host_disconnected",
            });
            await client.respond(request.id, toStatus(created));
            return;
          }
          // prompt() sends ACP session/prompt before its first await; retain its terminal promise,
          // but release CommandInbox as soon as dispatch has been initiated.
          const prompt = runtime.prompt({
            sessionId: session.sessionId,
            text: params.text,
          });
          created.status = "running";
          created.terminalPromise = prompt
            .then((result) =>
              closeOpenCodeRun(created, created.cancelRequested ? "cancelled" : "completed", {
                stopReason: result.stopReason,
                finalText: created.finalText,
              }),
            )
            .catch((error: unknown) =>
              closeOpenCodeRun(
                created,
                created.cancelRequested || /cancel/i.test(String(error)) ? "cancelled" : "failed",
                { diagnosticCode: "acp_request_failed" },
              ),
            );
          await client.respond(request.id, {
            status: "accepted",
            opencodeSessionId: session.sessionId,
          });
        } catch (error) {
          logger.warn(undefined, "OpenCode ACP delegated run failed to start", {
            workspaceKey,
            runId: created.runId,
            error: String(error),
          });
          await closeOpenCodeRun(
            created,
            created.disconnectRequested
              ? "interrupted"
              : created.cancelRequested
                ? "cancelled"
                : "failed",
            {
              diagnosticCode: created.disconnectRequested
                ? "host_disconnected"
                : created.cancelRequested
                  ? "cancelled_before_prompt"
                  : "acp_request_failed",
            },
          );
          await client.respond(request.id, toStatus(created)).catch(() => undefined);
        } finally {
          created.startupSettled = true;
          startupCompletion.resolve();
        }
        return;
      }

      if (!run || run.client !== client || !runtime) {
        await client.respond(request.id, {
          status: "interrupted",
          diagnosticCode: "host_run_not_found",
        });
        return;
      }
      if (params.operation === "cancelRun") {
        if (
          params.opencodeSessionId !== undefined &&
          params.opencodeSessionId !== run.opencodeSessionId
        ) {
          await client.respondError(request.id, {
            code: -32602,
            message: "OpenCode session identity mismatch",
          });
          return;
        }
        if (["completed", "cancelled", "failed", "interrupted"].includes(run.status)) {
          await client.respond(request.id, toStatus(run));
          return;
        }
        run.cancelRequested = true;
        run.status = "cancelling";
        if (!run.opencodeSessionId) {
          await client.respond(request.id, { status: "cancelling" });
          return;
        }
        try {
          await runtime.cancel({ sessionId: run.opencodeSessionId });
          await client.respond(request.id, {
            status: "cancelling",
            opencodeSessionId: run.opencodeSessionId,
          });
        } catch {
          await closeOpenCodeRun(run, "interrupted", {
            diagnosticCode: "acp_cancel_failed",
          });
          await client.respond(request.id, toStatus(run));
        }
        return;
      }
      if (!run.opencodeSessionId) {
        await client.respond(request.id, {
          status: "interrupted",
          diagnosticCode: "host_run_not_found",
        });
        return;
      }
      if (params.opencodeSessionId !== run.opencodeSessionId) {
        await client.respondError(request.id, {
          code: -32602,
          message: "OpenCode session identity mismatch",
        });
        return;
      }
      if (run.status !== "running" && run.status !== "cancelling") {
        await client.respondError(request.id, {
          code: -32602,
          message: "OpenCode run is not accepting permission responses",
        });
        return;
      }
      const optionsForRequest = run.permissions.get(params.requestId);
      if (!optionsForRequest?.has(params.optionId)) {
        await client.respondError(request.id, {
          code: -32602,
          message: "OpenCode permission option is not active",
        });
        return;
      }
      await runtime.respondToPermission({
        sessionId: run.opencodeSessionId,
        requestId: params.requestId,
        optionId: params.optionId,
      });
      run.permissions.delete(params.requestId);
      await client.respond(request.id, { status: "responded" });
    })().catch(async (error: unknown) => {
      logger.warn(undefined, "OpenCode ACP Host bridge request failed", {
        workspaceKey: resolveWorkspaceKey(workspace),
        error: String(error),
      });
      await client
        .respondError(request.id, {
          code: -32603,
          message: "OpenCode ACP Host bridge operation failed",
        })
        .catch(() => undefined);
    });
    return;
  }

  function handleCodeIndexQueryRequest(
    client: ZCodeProtocolClient,
    workspace: ZCodeAgentWorkspaceTarget,
    request: ZCodeProtocolRequest,
  ): void {
    void (async () => {
      const parsed = zcodeCodeIndexQueryParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        await client.respondError(request.id, {
          code: -32602,
          message: "Invalid code index query",
        });
        return;
      }
      const service = options?.codeIntelligenceService;
      if (!service) {
        await client.respondError(request.id, {
          code: -32603,
          message: "Local code index is unavailable on this Host",
        });
        return;
      }
      const workspaceRef = {
        workspacePath: workspace.workspacePath,
        ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
      };
      try {
        let result: ZCodeCodeIndexResult;
        switch (parsed.data.action) {
          case "status": {
            const status = await service.getStatus(workspaceRef);
            result = {
              action: "status",
              status: {
                state: status.state,
                ...(status.partial === undefined ? {} : { partial: status.partial }),
                generation: status.generation,
                ...(status.updatedAt === undefined ? {} : { updatedAt: status.updatedAt }),
                counts: status.counts,
                ...(status.progress === undefined ? {} : { progress: status.progress }),
                embedding: {
                  configured: status.embedding.configured,
                  ...(status.embedding.model === undefined
                    ? {}
                    : { model: status.embedding.model }),
                  available: status.embedding.available,
                },
                diagnostics: status.diagnostics,
              },
            };
            break;
          }
          case "search": {
            const search = await service.search({
              ...workspaceRef,
              query: parsed.data.query,
              limit: parsed.data.limit ?? 12,
              ...(parsed.data.lexicalOnly ? { lexicalOnly: true } : {}),
            });
            result = { action: "search", ...search };
            break;
          }
          case "context":
            result = {
              action: "context",
              context: await service.getSymbolContext({
                ...workspaceRef,
                symbol: parsed.data.symbol,
              }),
            };
            break;
          case "impact":
            result = {
              action: "impact",
              impact: await service.getImpact({
                ...workspaceRef,
                changedPaths: parsed.data.changedPaths,
              }),
            };
            break;
          case "trace":
            result = {
              action: "trace",
              trace: await service.trace({
                ...workspaceRef,
                fromSymbol: parsed.data.fromSymbol,
                toSymbol: parsed.data.toSymbol,
              }),
            };
            break;
        }
        await client.respond(request.id, zcodeCodeIndexQueryResultSchema.parse(result));
      } catch (error) {
        logger.warn(undefined, "Local code index query failed", {
          workspaceKey: resolveWorkspaceKey(workspace),
          error: String(error),
        });
        await client.respondError(request.id, {
          code: -32603,
          message: "Code index query failed",
        });
      }
    })().catch((error) => {
      logger.warn(undefined, "Local code index response failed", {
        workspaceKey: resolveWorkspaceKey(workspace),
        error: String(error),
      });
    });
    return;
  }

  function handleSubagentsReadRuntimeConfigRequest(
    client: ZCodeProtocolClient,
    workspace: ZCodeAgentWorkspaceTarget,
    request: ZCodeProtocolRequest,
  ): void {
    void (async () => {
      const parsed = zcodeSubagentsReadRuntimeConfigParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        await client.respondError(request.id, {
          code: -32602,
          message: "Invalid subagent runtime config request",
        });
        return;
      }
      let configuration: SubagentRuntimeConfig;
      try {
        if (!options?.readSubagentRuntimeConfig)
          throw new Error("Subagent runtime config is unavailable on this Host");
        configuration = subagentRuntimeConfigSchema.parse(
          await options.readSubagentRuntimeConfig(workspace),
        );
      } catch (error) {
        await client.respondError(request.id, {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      await client.respond(request.id, configuration);
    })().catch((error) =>
      logger.debug(undefined, "Subagent 配置响应发送失败", {
        error: String(error),
      }),
    );
    return;
  }

  function handleChannelReplyRequest(
    client: ZCodeProtocolClient,
    workspace: ZCodeAgentWorkspaceTarget,
    request: ZCodeProtocolRequest,
  ): void {
    void (async () => {
      const params = channelReplyRequestSchema.parse(request.params);
      if (!options?.channelReplyExecutor) throw new Error("Channel reply unavailable");
      const active = activeClientsByWorkspaceKey.get(resolveWorkspaceKey(workspace));
      if (active?.client !== client) throw new Error("Channel reply client is no longer active");
      const currentWorkspace = active.workspace;
      const result = await options.channelReplyExecutor({
        ...params,
        // 活跃连接还携带 V4 envelope 等内部字段；跨回复契约只能投影工作区身份，不能展开整个对象。
        workspacePath: currentWorkspace.workspacePath,
        workspaceIdentity: currentWorkspace.workspaceIdentity,
        remoteSessionId: currentWorkspace.remoteSessionId,
        trace: request.trace,
      });
      await client.respond(request.id, result);
    })().catch((error: unknown) =>
      client.respondError(request.id, {
        code: -32603,
        message: error instanceof Error ? error.message : "Channel reply failed",
      }),
    );
    return;
  }

  return {
    handleInteractionRequestOpenCodeAgentRunRequest,
    handleCodeIndexQueryRequest,
    handleSubagentsReadRuntimeConfigRequest,
    handleChannelReplyRequest,
  };
}

export type ZCodeAgentServiceRequestHandlersA = ReturnType<typeof createRequestHandlersA>;
