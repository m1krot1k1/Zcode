import { isAbsolute } from "node:path";
import type { AmendWorkflowRunSettingsInput } from "@zcode/core";
import type { MessageId } from "@zcode/contracts";
import {
  ZCODE_ATTACHMENT_FAULT_CODES,
  ZCodeAttachmentFaultError,
} from "@zcode/shared/zcode-protocol-v4";

import {
  loadEvaluationCatalogForEvaluate,
  resolveZCodeBuiltinPromptCommandInvocation,
} from "../builtin-prompt-command.js";
import { BUILTIN_WORKFLOW_COMMAND_NAME } from "../builtin-workflow-command.js";
import { resolveZCodeCustomCommandPrompt } from "../custom-command-prompt.js";
import { resolveEffectiveLocale } from "./app-config-options.js";
import type { AppEnvironment } from "./create-app-env.js";
import type {
  CreateAppDeps,
  CreateAppState,
  SessionBoundary,
} from "./create-app-contracts.js";
import type { AppModels } from "./create-app-models.js";
import type { AppPorts } from "./create-app-ports.js";
import type { AppSession } from "./create-app-session.js";
import { createInputFacade } from "./input-facade.js";
import { createPluginFacadeForApp } from "./plugin-facade.js";
import { grantProjectMcpServerApproval } from "./runtime-config.js";
import { createSessionFacade } from "./session-facade.js";
import { createWorkflowFacade } from "./workflow-facade.js";
import type { ZCodeApp } from "./types.js";

function decodePromptAttachmentDataUrl(
  content: string,
  fallbackMime: string,
  maxBytes: number,
): { bytes: Uint8Array; mediaType: string } {
  const commaIndex = content.indexOf(",");
  const headerParts =
    content.slice(0, "data:".length).toLowerCase() === "data:" && commaIndex >= 0
      ? content.slice("data:".length, commaIndex).split(";")
      : [];
  const mediaType = (headerParts.shift()?.trim() || fallbackMime).split(";", 1)[0]!.toLowerCase();
  const payload = commaIndex >= 0 ? content.slice(commaIndex + 1) : "";
  if (
    headerParts.at(-1)?.trim().toLowerCase() !== "base64" ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(payload) ||
    payload.length % 4 !== 0
  ) {
    throw new Error("fault.attachment.previewArtifactInvalid");
  }
  if (
    !mediaType.startsWith("image/") &&
    !mediaType.startsWith("video/") &&
    mediaType !== "application/pdf" &&
    // 根因：文本材料复用上传 artifact，但原 data URL 解码器仅接受媒体，合法预览被二次拒绝。
    !(
      mediaType === "text/plain" &&
      fallbackMime.split(";", 1)[0]?.trim().toLowerCase() === "text/plain"
    )
  ) {
    throw new Error("fault.attachment.previewNotMedia");
  }
  const bytes = Buffer.from(payload, "base64");
  if (bytes.byteLength > maxBytes) {
    throw new Error("fault.attachment.previewTooLarge");
  }
  return { bytes, mediaType };
}

export interface CreateAppSurfaceInput {
  deps: CreateAppDeps;
  env: AppEnvironment;
  ports: AppPorts;
  models: AppModels;
  session: AppSession;
  boundary: SessionBoundary;
  state: CreateAppState;
}

/** Публичная поверхность App: фасады ввода/workflow/session и операции вложений. */
export function createAppSurface(input: CreateAppSurfaceInput): ZCodeApp {
  const { deps, env, ports, models, session, boundary, state } = input;
  const {
    options,
    logger,
    loggerFactory,
    configResult,
    traceContext,
    sessionId,
    workingDirectory,
    appVersion,
    modelTelemetry,
  } = deps;
  const { runtime, scriptWorkflowFacade, dynamicWorkflowRunPort } = session;
  const {
    cliDefaultSelection,
    runtimeConfig,
    configuredMcpServers,
    untrustedProjectMcpServers,
    localSettingStore,
    projectID,
    mcpProjectTrustIdentity,
    pluginReferenceCatalog,
    storageRoot,
    sessionStore,
  } = env;
  const {
    artifactStore,
    executionPort,
    fileSystemPort,
    imageProcessorPort,
    pdfDocumentPort,
    mcpPort,
    permissionService,
    ownsExecutionPort,
    ownsMcpPort,
    closePtySessions,
  } = ports;
  const { modelAdapter, modelFactory, modelFacts } = models;
  const { prepareUserExecutionBoundary } = boundary;

  const inputFacade = createInputFacade({
    cliDefaultSelection,
    artifactStore,
    customCommandPromptResolver: async (text, resolverOptions) => {
      const builtin = resolveZCodeBuiltinPromptCommandInvocation(text, {
        // 动态工作流灰度关闭时内置 `/workflow` 不得展开（DWG-03）。目录侧已经把它从 `/` 面板
        // 剔除，但用户仍可手打命令名，两条路径必须给出同一个结论。独立 CLI 的 TUI 与 headless
        // 按 --workflow-mode 显式取值；缺席（进程内嵌入方）不设门禁，见 runtimeConfig 字段注释。
        dynamicWorkflowEnabled: runtimeConfig.dynamicWorkflowEnabled,
        evaluationCatalog: await loadEvaluationCatalogForEvaluate(text, workingDirectory),
        workingDirectory,
      });
      if (builtin !== undefined) {
        if (builtin.name === BUILTIN_WORKFLOW_COMMAND_NAME) {
          // `/workflow` 的展开处就是 onDemand 会话的激活点（launch.md「On demand: activation」）：
          // 它先于 executeTurn，本轮首个模型请求就带着十个工具。alwaysOn / 已激活会话里是 no-op。
          // 问的是 runtime 而不是闭包里的 runtimeConfig——构造时 config 被拷贝，闭包看不到翻转。
          await runtime?.activateDynamicWorkflowTools({
            source: "command",
            traceContext: resolverOptions?.traceContext ?? traceContext,
          });
        }
        return builtin.prompt;
      }
      return await resolveZCodeCustomCommandPrompt(text, {
        additionalDirectories: options.additionalDirectories,
        env: options.env,
        executionPort,
        logger,
        projectConfigPath: options.projectConfigPath,
        sessionId,
        signal: resolverOptions?.abortSignal,
        skipUserConfig: options.skipUserConfig,
        traceContext: resolverOptions?.traceContext ?? traceContext,
        userConfigPath: options.userConfigPath,
        workingDirectory,
      });
    },
    inputHistoryStore: ports.inputHistoryStore,
    logger,
    prepareUserExecutionBoundary,
    runtime,
    sessionId,
    traceContext,
  });
  const workflowFacade = createWorkflowFacade({
    agentTelemetry: modelTelemetry.agentExecution,
    appOptions: options,
    appVersion,
    artifactStore,
    cliStorageRoot: env.cliStorageRoot,
    configResult,
    eventSink: options.eventSink,
    imageProcessorPort,
    pdfDocumentPort,
    logger,
    mcpPort,
    modelFactory,
    modelFacts,
    permissionService,
    pluginSkillRoots: env.pluginOutcome.skillRoots,
    bundledSkillRoots: env.bundledSkillRoots,
    prepareUserExecutionBoundary,
    runtime,
    runtimeConfig,
    sessionId,
    sessionStore,
    storageRoot,
    traceContext,
    workingDirectory,
  });
  const sessionFacade = createSessionFacade({
    cliDefaultSelection,
    // project-scope MCP 的唯一写入口：显式 connect 才落 approval，且只保存定义 digest。
    // 写失败直接抛出，由 connectMcpServer 中止连接（不降级为临时放行）。
    approveProjectMcpServer: async ({ name, config }) => {
      await grantProjectMcpServerApproval({
        storageRoot,
        workspaceIdentity: mcpProjectTrustIdentity,
        serverName: name,
        config,
      });
      logger.info("Project MCP server approved", {
        event: "mcp.project.approved",
        module: "bootstrap",
        serverName: name,
        workspaceKey: mcpProjectTrustIdentity,
      });
    },
    // App 关闭时停下本会话拥有的 dwf run：
    // 引擎活在本 App 的闭包里，关掉 App 而不停它，journal 行会停在 running 等下一次孤儿收敛。
    ...(dynamicWorkflowRunPort === undefined
      ? {}
      : { closeDynamicWorkflowRuns: () => dynamicWorkflowRunPort.close() }),
    configResult,
    configuredMcpServers,
    ...(options.configuredDefaultModelSelection
      ? {
          configuredDefaultModelSelection: options.configuredDefaultModelSelection,
        }
      : {}),
    executionPort,
    localSettingStore,
    logger,
    loggerFactory,
    mcpPort,
    ownsExecutionPort,
    ownsMcpPort,
    closeNodeReplBrowserBroker: async () => {
      await state.ownedNodeReplBrowserBroker?.close();
    },
    ...(closePtySessions ? { closePtySessions } : {}),
    ownsSessionStore: env.ownsSessionStore,
    prepareUserExecutionBoundary,
    prepareResume: boundary.prepareResume,
    projectID,
    providerRegistry: options.providerRegistry,
    resolveUiLocale: (locale) => resolveEffectiveLocale(locale, options),
    runtime,
    sessionId,
    sessionStore,
    traceContext,
    untrustedProjectMcpServers,
    workingDirectory,
  });

  const closeSession = sessionFacade.close;
  const resolvePromptAttachment = async (input: {
    ref: string;
    mime: string;
    messageId?: string;
    attachmentIndex?: number;
  }): Promise<{ ref: string; mediaType: string; artifactUri?: string }> => {
    let ref = input.ref;
    let mediaType = input.mime;
    let artifactUri: string | undefined;
    if (input.messageId && input.attachmentIndex !== undefined) {
      // 预览单个附件曾通过 messages() 解码整段会话；长会话会同步扫描
      // 所有 parts，且无关坏行也会让目标预览失败。按 session/message 定点读取即可。
      const persistedMessage = await sessionStore.messageWithParts({
        sessionID: sessionId,
        messageID: input.messageId as MessageId,
      });
      const persistedAttachment = persistedMessage?.parts.filter((part) => part.type === "file")[
        input.attachmentIndex
      ];
      if (persistedAttachment?.type === "file") {
        mediaType = persistedAttachment.mime;
        // live row 的 ref 仍是原始路径；如果直接读取，源文件删除或覆盖后
        // 热态预览会和冷恢复 artifact 不一致。同一 message/index 必须优先取不可变副本。
        artifactUri =
          persistedAttachment.metadata?.artifactUri ??
          (persistedAttachment.url.startsWith("zcode-artifact://")
            ? persistedAttachment.url
            : undefined);
        ref =
          artifactUri ??
          (!persistedAttachment.url.startsWith("data:") ? persistedAttachment.url : input.ref);
      }
      // message row 会先于后续 FilePart 逐条落库；目标 part 尚未可见时仍应
      // 使用已经由当前 projection 授权的 input.ref，不能制造短暂的预览失败窗口。
    }
    return { ref, mediaType, ...(artifactUri ? { artifactUri } : {}) };
  };
  return {
    sessionId,
    traceId: traceContext.traceId,
    runtime,
    refreshPluginComponents: session.refreshPluginComponents,
    respondWorkspaceHookReview: (input) =>
      ports.workspaceHookRuntimeSecurity?.respond(
        {
          sessionId: input.sessionId,
          taskId: input.taskId,
          runId: input.runId,
          ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
          workspaceIdentity: input.workspaceIdentity,
          bundleDigest: input.bundleDigest,
          reviewFlowId: input.reviewFlowId,
          generation: input.generation,
          interactionId: input.interactionId,
        },
        input.decision,
      ) ??
      Promise.resolve({
        accepted: false as const,
        reasonCode: "workspace_hooks_require_trust_capable_host" as const,
      }),
    toggleWorkspaceHookReviewItem: (input) =>
      ports.workspaceHookRuntimeSecurity?.toggle(
        {
          sessionId: input.sessionId,
          taskId: input.taskId,
          runId: input.runId,
          ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
          workspaceIdentity: input.workspaceIdentity,
          bundleDigest: input.bundleDigest,
          reviewFlowId: input.reviewFlowId,
          generation: input.generation,
          interactionId: input.interactionId,
        },
        input.reviewItemId,
        input.enabled,
      ) ??
      Promise.resolve({
        accepted: false as const,
        reasonCode: "workspace_hooks_require_trust_capable_host" as const,
      }),
    revokeWorkspaceHookTrust: (input) =>
      ("hookDeclarationDigests" in input
        ? ports.workspaceHookRuntimeSecurity?.revokeCurrent(input)
        : ports.workspaceHookRuntimeSecurity?.revoke(
            {
              sessionId: input.sessionId,
              taskId: input.taskId,
              runId: input.runId,
              ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
              workspaceIdentity: input.workspaceIdentity,
              bundleDigest: input.bundleDigest,
              reviewFlowId: input.reviewFlowId,
              generation: input.generation,
              interactionId: input.interactionId,
            },
            input.reviewItemIds,
          )) ??
      Promise.resolve({
        accepted: false as const,
        reasonCode: "workspace_hooks_require_trust_capable_host" as const,
      }),
    requestWorkspaceHookReview: (input) =>
      ports.workspaceHookRuntimeSecurity?.requestReview({
        workspaceIdentity: input.workspaceIdentity,
        bundleDigest: input.bundleDigest,
      }) ??
      Promise.resolve({
        accepted: false as const,
        reasonCode: "workspace_hooks_require_trust_capable_host" as const,
      }),
    // Settings pretrust 写盘后由 server 按 workspace 调用：重载 Trust store 到本
    // session 的 coordinator 并重发 admission 状态（详见 types.ts 注释）。
    reloadWorkspaceHookTrust: () =>
      ports.workspaceHookRuntimeSecurity?.reloadTrust() ?? Promise.resolve(),
    setModelIoFullRetentionEnabled: (enabled) =>
      modelAdapter.setModelIoFullRetentionEnabled(enabled),
    readToolResultArtifact: (uri) =>
      artifactStore.readToolResultArtifact({ uri, trace: traceContext }),
    // wire/staging 全程是 decoded chunk；只有完整 checksum commit 后才在
    // CLI 进程内恢复既有 data-URL artifact 形态，保持 provider 读取链兼容。
    writePromptAttachment: async (input) => {
      const artifact = await artifactStore.writeToolResultArtifact({
        content: `data:${input.mime};base64,${Buffer.from(input.bytes).toString("base64")}`,
        contentType: "text/plain",
        retention: "session",
        sessionId,
        toolCallId: `prompt-attachment-upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        toolName: "prompt-attachment:upload",
        trace: traceContext,
      });
      if (
        input.mime.startsWith("image/") ||
        input.mime.startsWith("video/") ||
        input.mime.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf"
      ) {
        // 派生媒体只是可重建缓存；真实 IO 失败不破坏 durable data URL，最终请求投影会再次 ensure。
        void artifactStore
          .primeMediaAttachmentPath?.({
            bytes: input.bytes,
            mediaType: input.mime,
            uri: artifact.uri,
          })
          .catch(() => undefined);
      }
      return { ref: artifact.uri };
    },
    readPromptAttachment: async (input) => {
      const { ref, mediaType } = await resolvePromptAttachment(input);
      // 读取必须留在 session runtime 内：artifact 走 session store，路径走当前
      // FileSystemPort，SSH/WSL/Docker 才会命中正确的远端文件系统。
      if (ref.startsWith("zcode-artifact://")) {
        const artifact = await artifactStore.readToolResultArtifact({
          uri: ref,
          trace: traceContext,
        });
        return decodePromptAttachmentDataUrl(artifact.content, mediaType, input.maxBytes);
      }
      const read = await fileSystemPort.readBinaryFile({
        path: ref,
        maxBytes: input.maxBytes,
        trace: traceContext,
      });
      return { bytes: read.content, mediaType };
    },
    statPromptAttachment: async (input) => {
      const { ref, mediaType, artifactUri } = await resolvePromptAttachment(input);
      if (artifactUri) {
        if (!artifactStore.statToolResultArtifact) {
          throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.statUnsupported);
        }
        const result = await artifactStore.statToolResultArtifact({
          uri: artifactUri,
          trace: traceContext,
        });
        return {
          totalBytes: result.bytes,
          mediaType: result.contentType || mediaType,
          ...(result.mtimeMs === undefined ? {} : { mtimeMs: result.mtimeMs }),
        };
      }
      const result = await fileSystemPort.stat({ path: ref, trace: traceContext });
      if (result.kind !== "file") {
        // 目录/符号链接/已消失都意味着「这个附件不再是可分享的文件」，用稳定码上抛，
        // 让 share 预检按确定分类处理，而不是靠错误文本猜。
        throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.statNotFile);
      }
      return {
        totalBytes: result.sizeBytes,
        mediaType,
        ...(result.mtimeMs === undefined ? {} : { mtimeMs: result.mtimeMs }),
      };
    },
    resolvePromptAttachmentPreviewSource: async (input) => {
      const resolved = await resolvePromptAttachment(input);
      if (!resolved.mediaType.startsWith("video/")) return { kind: "chunked" };
      if (resolved.artifactUri) {
        if (!artifactStore.ensureMediaAttachmentPath) return { kind: "chunked" };
        try {
          const materialized = await artifactStore.ensureMediaAttachmentPath({
            uri: resolved.artifactUri,
            mediaType: resolved.mediaType,
          });
          if (materialized.status === "ready" && materialized.path.trim()) {
            return {
              kind: "local_path",
              path: materialized.path,
              mediaType: resolved.mediaType,
            };
          }
        } catch {
          // artifact 仍是不可变事实；派生文件失败只允许 gateway 回到 artifact chunk。
        }
        return { kind: "chunked" };
      }
      if (isAbsolute(resolved.ref)) {
        return {
          kind: "local_path",
          path: resolved.ref,
          mediaType: resolved.mediaType,
        };
      }
      return { kind: "chunked" };
    },
    ...sessionFacade,
    close: async () => {
      try {
        await closeSession?.();
      } finally {
        try {
          state.providerModelRuntime?.dispose();
        } finally {
          try {
            await state.ownedModelAdapter?.dispose();
          } finally {
            await modelTelemetry.shutdown();
          }
        }
      }
    },
    ...workflowFacade,
    ...scriptWorkflowFacade,
    // dwf 事件日志的读面。**可选能力**：journal 不可用时 run service 整个不构造，
    // 这个方法随之缺席，v4 网关据此回结构化的能力不支持错误——「没有事件」与
    // 「这个会话没有这个能力」必须能被 renderer 区分。
    ...(dynamicWorkflowRunPort === undefined
      ? {}
      : {
          listDynamicWorkflowRunEvents: async (input: {
            runId: string;
            afterSequence?: number;
            limit?: number;
            maxBytes?: number;
          }) =>
            dynamicWorkflowRunPort.listEvents(input.runId, {
              ...(input.afterSequence === undefined
                ? {}
                : { afterSequence: input.afterSequence }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
              ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
            }),
        }),
    // workflow run 的**用户面产物**读面。三条一起注册、
    // 一起缺席：它们是同一个 journal 读面的三个切片，部分在场只会让 UI 拿到一张有卡片
    // 却打不开的侧板。三个端口成员都是可选的（stub 端口不陪跑），所以逐个探测。
    // ⚠ 术语：artifact = 脚本发布给用户看的产出，不是端口上的 `output`（顶层返回值）。
    ...(dynamicWorkflowRunPort === undefined ||
    typeof dynamicWorkflowRunPort.listArtifacts !== "function" ||
    typeof dynamicWorkflowRunPort.listArtifactItems !== "function" ||
    typeof dynamicWorkflowRunPort.readArtifact !== "function"
      ? {}
      : {
          listDynamicWorkflowRunArtifacts: async (input: { runId: string }) =>
            dynamicWorkflowRunPort.listArtifacts!(input.runId),
          listDynamicWorkflowRunArtifactItems: async (input: {
            runId: string;
            artifactId: string;
            afterSequence?: number;
            limit: number;
            maxBytes: number;
            fields?: readonly string[];
          }) =>
            dynamicWorkflowRunPort.listArtifactItems!(input.runId, input.artifactId, {
              ...(input.afterSequence === undefined
                ? {}
                : { afterSequence: input.afterSequence }),
              limit: input.limit,
              maxBytes: input.maxBytes,
              ...(input.fields === undefined ? {} : { fields: input.fields }),
            }),
          readDynamicWorkflowRunArtifact: async (input: {
            runId: string;
            artifactId: string;
            version: number;
          }) =>
            dynamicWorkflowRunPort.readArtifact!(input.runId, input.artifactId, input.version),
        }),
    // workflow run 的工作区 transcript：两条一起
    // 注册、一起缺席，理由同产物的三条。
    ...(dynamicWorkflowRunPort === undefined ||
    typeof dynamicWorkflowRunPort.listWorkspaceNodes !== "function" ||
    typeof dynamicWorkflowRunPort.readWorkspaceNodeResult !== "function"
      ? {}
      : {
          listDynamicWorkflowRunWorkspaceNodes: async (input: { runId: string }) =>
            dynamicWorkflowRunPort.listWorkspaceNodes!(input.runId),
          readDynamicWorkflowRunNodeResult: async (input: {
            runId: string;
            siteId: string;
            ordinal: number;
            maxBytes: number;
          }) =>
            dynamicWorkflowRunPort.readWorkspaceNodeResult!(
              input.runId,
              input.siteId,
              input.ordinal,
              { maxBytes: input.maxBytes },
            ),
        }),
    // dwf run 的会话级生命周期读面（在飞计数 + 结算订阅）。消费者是宿主的 provider registry
    // 安全边界：子代理共用本会话的 live adapter，在飞 run 期间 replace registry 会 dispose
    // 它们绑定的请求资源。缺席条件同上。
    ...(dynamicWorkflowRunPort === undefined ? {} : {}),
    // dwf run 的枚举面（重启后的发现查询）。能力缺席条件同上；端口的 listRunsForSession
    // 是可选成员，方法缺席时本能力同样不注册。
    ...(dynamicWorkflowRunPort === undefined ||
    typeof dynamicWorkflowRunPort.listRunsForSession !== "function"
      ? {}
      : {
          listDynamicWorkflowRuns: async (input: { limit?: number }) =>
            dynamicWorkflowRunPort.listRunsForSession!(input.limit),
        }),
    // workflow run 的冷回放。能力缺席条件同上。
    ...(dynamicWorkflowRunPort === undefined ||
    typeof dynamicWorkflowRunPort.replayProgressForSession !== "function"
      ? {}
      : {
          replayDynamicWorkflowRuns: async (input: { excludeRunIds: ReadonlySet<string> }) =>
            dynamicWorkflowRunPort.replayProgressForSession!(input),
        }),
    // dwf run 的恢复。能力缺席条件同上；此外
    // 端口的 resume 是可选成员（stub 端口不陪跑），方法缺席时本能力同样不注册——
    // 对 renderer「端口缺席」与「方法缺席」是同一个业务事实。
    ...(dynamicWorkflowRunPort === undefined ||
    typeof dynamicWorkflowRunPort.resume !== "function"
      ? {}
      : {
          resumeWorkflowRun: async (input: { workId: string; name?: string }) => {
            const result = await dynamicWorkflowRunPort.resume!(input.workId);
            if (result.ok) {
              // 追踪重臂必须紧随成功的 resume：registry 登记（回收护栏）、backgroundWorks
              // 条目（cancellable）、终态通知。port.resume 已先替换注册表条目，
              // waiter 因此挂在新的结算 promise 上（run service 文件头不变式 5）。
              await runtime.trackResumedDynamicWorkflowRun({
                runId: result.runId,
                ...(result.toolCallId === undefined ? {} : { toolCallId: result.toolCallId }),
                ...(input.name === undefined ? {} : { name: input.name }),
                traceContext,
              });
            }
            return result;
          },
        }),
    // 中枢直接启动一个已保存的工作流。能力缺席条件与
    // resumeWorkflowRun 家族一致：dwf 端口整体缺席（stub / 单测宿主）时不注册——GUI 据此拿到
    // 能力不支持错误并原样显示，而不是把「不支持直接启动」误当成一次失败的启动。
    // 与 /goal 控制轮同构：先走统一用户执行边界（否则首次持久化前 shell selection 为空，
    // 冷恢复退回 legacy fallback），再由 runtime 解析 + 校验 + 编译 + 落启动轮 + submit。
    ...(dynamicWorkflowRunPort === undefined
      ? {}
      : {
          startSavedWorkflow: async (input: {
            name: string;
            scope?: "project" | "global";
            args?: Record<string, unknown>;
          }) => {
            await prepareUserExecutionBoundary({ traceContext });
            return await runtime.startSavedWorkflowRun({ ...input, traceContext });
          },
        }),
    // GUI「配置」。它
    // 沿用前驱的脚本，所以端口必须既能 amend 又能读回脚本；缺一就不注册，GUI 拿到能力不支持。
    // 与 startSavedWorkflow 同一条用户执行边界：冷恢复的会话先恢复 Session 边界再落设置轮。
    ...(dynamicWorkflowRunPort === undefined ||
    typeof dynamicWorkflowRunPort.amend !== "function" ||
    typeof dynamicWorkflowRunPort.getScript !== "function"
      ? {}
      : {
          amendWorkflowRunSettings: async (
            input: Omit<AmendWorkflowRunSettingsInput, "traceContext">,
          ) => {
            await prepareUserExecutionBoundary({ traceContext });
            return await runtime.amendWorkflowRunSettings({ ...input, traceContext });
          },
        }),
    ...createPluginFacadeForApp({ configResult, options, workingDirectory }),
    getPluginReferenceCatalog: () => pluginReferenceCatalog,
    getSkillCatalog: async () => {
      // Skill 目录属于 context 初始化结果。冷恢复必须先恢复 Session 边界，再读取
      // 新 runtime 的快照，不能绕开 resume 后用旧工作目录独立扫描。
      await prepareUserExecutionBoundary({ traceContext });
      return await runtime.getSkillCatalog(traceContext);
    },
    resume: boundary.resumeFromStore,
    ...inputFacade,
  };
}
