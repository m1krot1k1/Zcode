import { z } from "zod";
import { zcodeStorageStartupStateSchema } from "./schema-telemetry.js";
import {
  zcodeMcpConnectParamsSchema,
  zcodeMcpConnectResultSchema,
  zcodeMcpListParamsSchema,
  zcodeMcpListResultSchema,
  zcodeMcpReadResourceParamsSchema,
  zcodeMcpReadResourceResultSchema,
  zcodeMcpUiAppToolAcceptedResultSchema,
  zcodeMcpUiCallToolParamsSchema,
  zcodeMcpUiCallToolResultSchema,
  zcodeMcpUiCancelCallParamsSchema,
  zcodeMcpUiCancelCallResultSchema,
  zcodeMcpUiCancelSamplingParamsSchema,
  zcodeMcpUiClaimAppToolCallParamsSchema,
  zcodeMcpUiCloseInstanceParamsSchema,
  zcodeMcpUiCloseInstanceResultSchema,
  zcodeMcpUiListResourcesParamsSchema,
  zcodeMcpUiListResourcesResultSchema,
  zcodeMcpUiListResourceTemplatesResultSchema,
  zcodeMcpUiOpenInstanceParamsSchema,
  zcodeMcpUiOpenInstanceResultSchema,
  zcodeMcpUiReadResourceParamsSchema,
  zcodeMcpUiReadResourceResultSchema,
  zcodeMcpUiRegisterAppToolsParamsSchema,
  zcodeMcpUiRegisterAppToolsResultSchema,
  zcodeMcpUiResolveAppToolCallParamsSchema,
  zcodeMcpUiResourceSubscriptionParamsSchema,
  zcodeMcpUiResourceSubscriptionResultSchema,
  zcodeMcpUiSamplingParamsSchema,
  zcodeMcpUiSamplingResultSchema,
  zcodeMcpUiUnregisterAppToolsParamsSchema,
  zcodeMcpUiUnregisterAppToolsResultSchema,
} from "./schema-mcp.js";
import {
  zcodeCodeIndexQueryParamsSchema,
  zcodeCodeIndexQueryResultSchema,
} from "./schema-session-commands.js";
import {
  zcodeWorkspaceHookTrustGrantParamsSchema,
  zcodeWorkspaceHookTrustGrantResultSchema,
} from "./schema-workspace.js";
import {
  zcodeBrowserExecuteParamsSchema,
  zcodeBrowserExecuteResultSchema,
  zcodeBrowserListParamsSchema,
  zcodeBrowserListResultSchema,
} from "./schema-interaction.js";
import {
  zcodeOpenCodeAgentRunRequestSchema,
  zcodeOpenCodeAgentRunResultSchema,
} from "./schema-opencode-agent.js";

export const zcodeProtocolMethods = {
  runtimeCapabilities: "runtime/capabilities",
  computerUseOperationEvent: "computer-use/operation-event",
  sessionCreate: "session/create",
  sessionResume: "session/resume",
  sessionList: "session/list",
  sessionSubagents: "session/subagents",
  sessionRequestRuntimePreferences: "session/requestRuntimePreferences",
  subagentsReadRuntimeConfig: "subagents/readRuntimeConfig",
  codeIndexQuery: "code-index/query",
  sessionRead: "session/read",
  sessionMessages: "session/messages",
  sessionEvents: "session/events",
  sessionDebug: "session/debug",
  sessionSubscribe: "session/subscribe",
  // @deprecated（部分）：send 主路径已收敛 v4 sendText；仅剩 adapter 附件
  // 回退分支消费（v4 attachmentRef 上传/寄存命令面未建模），待附件命令面落地后移除。
  sessionSend: "session/send",
  // @deprecated：host 客户端方法已删（stop 已收敛 v4 stop 命令）。
  // wire case 留兼容（transport bypass 名单仍引用），随旧词整体删除时一并移除。
  sessionStop: "session/stop",
  // @deprecated：host 客户端方法已删（已收敛 v4 cancelBackgroundWork 命令）。
  // wire case 留兼容，随旧词整体删除时一并移除。
  sessionCancelBackgroundTask: "session/cancelBackgroundTask",
  // @deprecated：host 客户端方法已删（v4 forkAssistant 原生 handler 经
  // forkSessionAtMessage 钩子直调 server-operations.forkSession op）。wire case 与
  // fork params/result schema 保留＝op 存活面；fork record 归 v4 原生重写。
  sessionFork: "session/fork",
  sessionCompact: "session/compact",
  sessionGoal: "session/goal",
  sessionClose: "session/close",
  // setModel 仍被 zcodeSessionService 的 desktop 旧链路消费；replayable
  // switchModelConfig 已直接由目标 Environment Registry 解析 Selection。
  sessionSetModel: "session/setModel",
  // replayable facade 的思考深度/模式已收敛 v4 switchModelConfig/
  // switchCollaborationMode；剩余消费 = zcodeSessionService（desktop 旧链路，随
  // 桌面 v4 UI 收口清零）与 setMode 的 auto 值残留（v4 值域刻意排除 auto）。
  sessionSetThoughtLevel: "session/setThoughtLevel",
  sessionSetMode: "session/setMode",
  workspaceReadPresentation: "workspace/readPresentation",
  workspaceHookTrustGrant: "workspace/hooks/trustGrant",
  // 进程级 Account Provider Config 与 workspace 运行目录分离。
  providerUpdateAccountConfig: "provider/updateAccountConfig",
  providerUpdateRuntimeCatalog: "provider/updateRuntimeCatalog",
  providerRefreshRegistry: "provider/refreshRegistry",
  workspaceUpdateInteractionPreferences: "workspace/updateInteractionPreferences",
  workspaceUpdateModelIoPreferences: "workspace/updateModelIoPreferences",
  // Off-Peak 工具面门禁是 workspace 级事实（灰度 + 本地/远程），由 host 在 agent 就绪时同步；
  // CLI 对 legacy create/resume 与 v4 冷恢复统一读取。旧 CLI method-not-found → host 降级忽略。
  workspaceUpdateOffPeakToolPolicy: "workspace/updateOffPeakToolPolicy",
  // 动态工作流灰度门禁：同 Off-Peak 的同步模式。
  workspaceUpdateDynamicWorkflowPolicy: "workspace/updateDynamicWorkflowPolicy",
  // LLM 执行面在 CLI，直连不可行；消费仅 services 内部
  // （commit message），待 v4 workspace 查询/命令面覆盖后移除。
  workspaceGenerateText: "workspace/generateText",
  workspaceCancelGenerateText: "workspace/cancelGenerateText",
  providerTestModelConnectivity: "provider/testModelConnectivity",
  mcpList: "mcp/list",
  mcpConnect: "mcp/connect",
  mcpReadResource: "mcp/readResource",
  mcpUiOpenInstance: "mcp/uiOpenInstance",
  mcpUiCloseInstance: "mcp/uiCloseInstance",
  mcpUiValidateInstance: "mcp/uiValidateInstance",
  mcpUiSampling: "mcp/uiSampling",
  mcpUiCancelSampling: "mcp/uiCancelSampling",
  mcpUiCallTool: "mcp/uiCallTool",
  mcpUiCancelCall: "mcp/uiCancelCall",
  mcpUiReadResource: "mcp/uiReadResource",
  mcpUiListResources: "mcp/uiListResources",
  mcpUiListResourceTemplates: "mcp/uiListResourceTemplates",
  mcpUiSubscribeResource: "mcp/uiSubscribeResource",
  mcpUiUnsubscribeResource: "mcp/uiUnsubscribeResource",
  // App-Provided Tools：页面工具登记 / 注销，与模型调用的认领 / 回传（信箱投递走 v4 live 增量）。
  mcpUiRegisterAppTools: "mcp/uiRegisterAppTools",
  mcpUiUnregisterAppTools: "mcp/uiUnregisterAppTools",
  mcpUiClaimAppToolCall: "mcp/uiClaimAppToolCall",
  mcpUiResolveAppToolCall: "mcp/uiResolveAppToolCall",
  pluginsList: "plugins/list",
  pluginsReferenceCatalog: "plugins/referenceCatalog",
  pluginsListUiSurfaces: "plugins/listUiSurfaces",
  pluginsReferenceCatalogWithCategory: "plugins/referenceCatalogWithCategory",
  skillsReferenceCatalog: "skills/referenceCatalog",
  // 已保存工作流的 GUI 中枢：workspace 级、无会话。
  workflowsList: "workflows/list",
  workflowsGet: "workflows/get",
  workflowsUpdateMeta: "workflows/updateMeta",
  workflowsDelete: "workflows/delete",
  workflowsRuns: "workflows/runs",
  // 在项目档 / 全局档之间移动同名文件。
  workflowsMove: "workflows/move",
  // 完成卡的「直接保存」与「已保存」判定（docs/dynamic-workflow/transcript-and-notifications.md）：
  // 前者按 runId 从 journal 取脚本落盘，后者回答「这次 run 对应哪个已保存工作流」。
  workflowsSave: "workflows/save",
  workflowsForRun: "workflows/forRun",
  pluginsResolveSuggestedReference: "plugins/resolveSuggestedReference",
  pluginsSetEnabled: "plugins/setEnabled",
  pluginsOverview: "plugins/overview",
  pluginsMarketplaceAdd: "plugins/marketplace/add",
  pluginsMarketplaceRemove: "plugins/marketplace/remove",
  pluginsMarketplaceUpdate: "plugins/marketplace/update",
  pluginsInstall: "plugins/install",
  pluginsCancelOperation: "plugins/cancelOperation",
  pluginsUninstall: "plugins/uninstall",
  pluginsUpdate: "plugins/update",
  pluginsRestoreBuiltin: "plugins/restoreBuiltin",
  pluginsConfigure: "plugins/configure",
  pluginsResetConfig: "plugins/resetConfig",
  pluginsValidate: "plugins/validate",
  pluginsDescribe: "plugins/describe",
  automationCreate: "automation/create",
  topicResourceRead: "topic/resource/read",
  channelReply: "bot/channel/reply",
  topicResourceCancel: "topic/resource/cancel",
  automationUpdate: "automation/update",
  automationCheckTaskBinding: "automation/checkTaskBinding",
  automationList: "automation/list",
  automationDelete: "automation/delete",
  // Off-Peak 会话内创建：与 automation 兄弟并列的独立方法族。
  offPeakCreate: "offPeak/create",
  offPeakList: "offPeak/list",
  // @deprecated：host 消费已清零（zcodeAgentService 改走 v4/usage/stats）。
  // 仅剩 CLI server 的 wire 兼容 case；随旧词整体删除时一并移除。
  usageStats: "usage/stats",
  // ZCode Protocol 对 agent 只暴露 session-first 方法；task 是 UI 投影概念，不能泄露进协议方法名。
  // @deprecated：host 已改走 v4/conversation/usage；后续与 usage/stats 一并移除。
  sessionUsage: "session/usage",
  // 资源管理器：CLI 回报其 MCP 子进程 pid 与插件归属（纯内存，无 I/O），采样在 Host 侧完成。
  processChildProcesses: "process/childProcesses",
  processNetworkCapture: "process/networkCapture",
  interactionRequestPermission: "interaction/requestPermission",
  interactionRequestUserInput: "interaction/requestUserInput",
  interactionRequestProviderRuntimeHeaders: "interaction/requestProviderRuntimeHeaders",
  interactionRequestOfficialMcpAuthHeaders: "interaction/requestOfficialMcpAuthHeaders",
  interactionRequestOpenCodeAgentRun: "interaction/requestOpenCodeAgentRun",
  interactionOpenCodeAgentRunEvent: "interaction/openCodeAgentRunEvent",
  // browser-use 反向请求由 agent 发起，host 转给 main 中的 CDP executor。
  interactionBrowserList: "interaction/browserList",
  interactionBrowserExecute: "interaction/browserExecute",
} as const;

export type ZCodeProtocolMethod = (typeof zcodeProtocolMethods)[keyof typeof zcodeProtocolMethods];

export const zcodeProtocolEmptyResultSchema = z.object({}).strict();

// 最新 V4 主链已不再依赖旧版全量方法表；这里仅保留仍被兼容测试和 browser broker
// 消费的最小契约集合，避免重新引入已移除的 legacy 方法。
export const zcodeProtocolSessionMethodContracts = {
  [zcodeProtocolMethods.codeIndexQuery]: {
    params: zcodeCodeIndexQueryParamsSchema,
    result: zcodeCodeIndexQueryResultSchema,
  },
  [zcodeProtocolMethods.interactionRequestOpenCodeAgentRun]: {
    params: zcodeOpenCodeAgentRunRequestSchema,
    result: zcodeOpenCodeAgentRunResultSchema,
  },
  [zcodeProtocolMethods.mcpUiOpenInstance]: {
    params: zcodeMcpUiOpenInstanceParamsSchema,
    result: zcodeMcpUiOpenInstanceResultSchema,
  },
  [zcodeProtocolMethods.mcpUiCloseInstance]: {
    params: zcodeMcpUiCloseInstanceParamsSchema,
    result: zcodeMcpUiCloseInstanceResultSchema,
  },
  [zcodeProtocolMethods.mcpUiValidateInstance]: {
    params: zcodeMcpUiCloseInstanceParamsSchema,
    result: zcodeMcpUiResourceSubscriptionResultSchema,
  },
  [zcodeProtocolMethods.workspaceHookTrustGrant]: {
    params: zcodeWorkspaceHookTrustGrantParamsSchema,
    result: zcodeWorkspaceHookTrustGrantResultSchema,
  },
  [zcodeProtocolMethods.mcpList]: {
    params: zcodeMcpListParamsSchema,
    result: zcodeMcpListResultSchema,
  },
  [zcodeProtocolMethods.mcpConnect]: {
    params: zcodeMcpConnectParamsSchema,
    result: zcodeMcpConnectResultSchema,
  },
  [zcodeProtocolMethods.mcpReadResource]: {
    params: zcodeMcpReadResourceParamsSchema,
    result: zcodeMcpReadResourceResultSchema,
  },
  [zcodeProtocolMethods.mcpUiSampling]: {
    params: zcodeMcpUiSamplingParamsSchema,
    result: zcodeMcpUiSamplingResultSchema,
  },
  [zcodeProtocolMethods.mcpUiCancelSampling]: {
    params: zcodeMcpUiCancelSamplingParamsSchema,
    result: zcodeMcpUiCancelCallResultSchema,
  },
  [zcodeProtocolMethods.mcpUiCallTool]: {
    params: zcodeMcpUiCallToolParamsSchema,
    result: zcodeMcpUiCallToolResultSchema,
  },
  [zcodeProtocolMethods.mcpUiCancelCall]: {
    params: zcodeMcpUiCancelCallParamsSchema,
    result: zcodeMcpUiCancelCallResultSchema,
  },
  [zcodeProtocolMethods.mcpUiReadResource]: {
    params: zcodeMcpUiReadResourceParamsSchema,
    result: zcodeMcpUiReadResourceResultSchema,
  },
  [zcodeProtocolMethods.mcpUiListResources]: {
    params: zcodeMcpUiListResourcesParamsSchema,
    result: zcodeMcpUiListResourcesResultSchema,
  },
  [zcodeProtocolMethods.mcpUiListResourceTemplates]: {
    params: zcodeMcpUiListResourcesParamsSchema,
    result: zcodeMcpUiListResourceTemplatesResultSchema,
  },
  [zcodeProtocolMethods.mcpUiSubscribeResource]: {
    params: zcodeMcpUiResourceSubscriptionParamsSchema,
    result: zcodeMcpUiResourceSubscriptionResultSchema,
  },
  [zcodeProtocolMethods.mcpUiUnsubscribeResource]: {
    params: zcodeMcpUiResourceSubscriptionParamsSchema,
    result: zcodeMcpUiResourceSubscriptionResultSchema,
  },
  [zcodeProtocolMethods.mcpUiRegisterAppTools]: {
    params: zcodeMcpUiRegisterAppToolsParamsSchema,
    result: zcodeMcpUiRegisterAppToolsResultSchema,
  },
  [zcodeProtocolMethods.mcpUiUnregisterAppTools]: {
    params: zcodeMcpUiUnregisterAppToolsParamsSchema,
    result: zcodeMcpUiUnregisterAppToolsResultSchema,
  },
  [zcodeProtocolMethods.mcpUiClaimAppToolCall]: {
    params: zcodeMcpUiClaimAppToolCallParamsSchema,
    result: zcodeMcpUiAppToolAcceptedResultSchema,
  },
  [zcodeProtocolMethods.mcpUiResolveAppToolCall]: {
    params: zcodeMcpUiResolveAppToolCallParamsSchema,
    result: zcodeMcpUiAppToolAcceptedResultSchema,
  },
  [zcodeProtocolMethods.interactionBrowserList]: {
    params: zcodeBrowserListParamsSchema,
    result: zcodeBrowserListResultSchema,
  },
  [zcodeProtocolMethods.interactionBrowserExecute]: {
    params: zcodeBrowserExecuteParamsSchema,
    result: zcodeBrowserExecuteResultSchema,
  },
} as const satisfies Partial<
  Record<ZCodeProtocolMethod, { params: z.ZodTypeAny; result: z.ZodTypeAny }>
>;

export type ZCodeProtocolSessionMethodContract =
  (typeof zcodeProtocolSessionMethodContracts)[keyof typeof zcodeProtocolSessionMethodContracts];

/** 仅存储准备子进程的私有控制帧，原始路径不进入业务事件或遥测。 */
export const zcodeStoragePreparationFrameSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("startup/storagePath"),
      params: z.object({ path: z.string().min(1).max(32768) }).strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal("startup/storagePrepared"),
      params: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal("startup/storageState"),
      params: zcodeStorageStartupStateSchema,
    })
    .strict(),
]);

export const zcodeStoragePathReadySchema = z
  .object({
    method: z.literal("startup/storagePathReady"),
    reuse: z.boolean().optional(),
  })
  .strict();
