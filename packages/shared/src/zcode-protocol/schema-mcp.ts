import { z } from "zod";
import {
  MCP_APPS_APP_TOOL_CALL_ID_MAX_CHARS,
  MCP_APPS_APP_TOOL_ERROR_MESSAGE_MAX_CHARS,
  MCP_APPS_APP_TOOLS_MAX_PER_INSTANCE,
  mcpAppsAppToolCallResultSchema,
  mcpAppsAppToolDescriptorSchema,
} from "../mcp-apps/appTools.js";
import { mcpAppInstanceSchema } from "../mcp-apps/instance.js";
import { mcpAppsSamplingParamsSchema, mcpAppsSamplingResultSchema } from "../mcp-apps/sampling.js";
import {
  zcodeDeliveryKindSchema,
  zcodePermissionResponseSchema,
  zcodeSyntheticUserMessageSourceSchema as legacyZcodeSyntheticUserMessageSourceSchema,
  zcodeWorkspaceRefSchema,
} from "../zcode-protocol-legacy-types.js";
import { nonEmptyString } from "./schema-core.js";

export type ZCodeDeliveryKind = z.infer<typeof zcodeDeliveryKindSchema>;

// TurnStarted 与持久 message 必须共用同一来源词表；否则 live event 能通过而 cold
// message 在 app/agent 边界被拒绝，造成 continuous/replayable 语义分叉。
// 持久消息与输入沿用同一 source schema；agent_listing_delta 只作 provider context，不触发新 turn。
export const zcodeTurnInputSourceSchema = legacyZcodeSyntheticUserMessageSourceSchema;

export const zcodeSessionPersistenceSchema = z.enum(["immediate", "deferred"]);

export type ZCodeSessionPersistence = z.infer<typeof zcodeSessionPersistenceSchema>;

export type ZCodeWorkspaceRef = z.infer<typeof zcodeWorkspaceRefSchema>;

export const zcodePermissionOptionSchema = z
  .object({
    optionId: nonEmptyString,
    kind: nonEmptyString,
    name: nonEmptyString,
    description: z.string().optional(),
    response: zcodePermissionResponseSchema,
  })
  .strict();

const zcodeProtocolMcpEntrySchema = z
  .object({
    name: nonEmptyString,
    value: z.string(),
  })
  .strict();

const zcodeProtocolMcpOAuthSchema = z.union([
  z
    .object({
      type: z.literal("client_credentials"),
      clientId: nonEmptyString,
      clientSecret: nonEmptyString,
      clientName: nonEmptyString.optional(),
      scope: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("authorization_code"),
      clientId: nonEmptyString.optional(),
      clientSecret: nonEmptyString.optional(),
      clientName: nonEmptyString.optional(),
      redirectPath: nonEmptyString.optional(),
      scope: z.string().optional(),
    })
    .strict(),
]);

export const zcodeProtocolMcpServerSchema = z.union([
  z
    .object({
      name: nonEmptyString,
      command: nonEmptyString,
      args: z.array(z.string()),
      env: z.array(zcodeProtocolMcpEntrySchema),
      isolation: z.enum(["session", "workspace"]).optional(),
      protocolVersion: z.enum(["legacy", "auto", "2026-07-28"]).optional(),
      alwaysLoad: z.boolean().optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      name: nonEmptyString,
      type: z.enum(["http", "sse"]),
      url: nonEmptyString,
      headers: z.array(zcodeProtocolMcpEntrySchema),
      oauth: zcodeProtocolMcpOAuthSchema.optional(),
      isolation: z.enum(["session", "workspace"]).optional(),
      protocolVersion: z.enum(["legacy", "auto", "2026-07-28"]).optional(),
      alwaysLoad: z.boolean().optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
]);

export type ZCodeProtocolMcpServer = z.infer<typeof zcodeProtocolMcpServerSchema>;

export const zcodeMcpServerStatusKindSchema = z.enum([
  "connecting",
  "connected",
  "disabled",
  "disconnected",
  "failed",
  "untrusted",
]);

export const MCP_SERVER_FAILURE_KINDS = [
  "config_invalid",
  "runtime_unavailable",
  "process_start_failed",
  "network_unreachable",
  "connection_timeout",
  "protocol_negotiation_failed",
  "tool_list_failed",
  "unexpected_disconnect",
  "oauth_authorization_failed",
  "official_origin_untrusted",
  "not_authenticated",
  "coding_plan_required",
  "server_not_found",
  "server_unavailable",
  "rate_limited",
  "server_internal_error",
  "protocol_error",
  "status_unavailable",
  "connection_failed",
] as const;

export const mcpServerFailureKindSchema = z.enum(MCP_SERVER_FAILURE_KINDS);

export type McpServerFailureKind = z.infer<typeof mcpServerFailureKindSchema>;

export const zcodeMcpServerStatusSnapshotSchema = z
  .object({
    status: zcodeMcpServerStatusKindSchema,
    transport: z.enum(["stdio", "http", "sse"]),
    toolCount: z.number().int().nonnegative(),
    updatedAt: nonEmptyString,
    error: z.string().optional(),
    failureKind: mcpServerFailureKindSchema.optional(),
    serverRequestId: nonEmptyString.optional(),
    protocolEra: z.enum(["legacy", "modern"]).optional(),
    authorization: z
      .object({
        type: z.literal("oauth_authorization_code"),
        authorizationUrl: nonEmptyString,
        startedAt: nonEmptyString,
      })
      .strict()
      .optional(),
  })
  .strict();

export type ZCodeMcpServerStatusSnapshot = z.infer<typeof zcodeMcpServerStatusSnapshotSchema>;

export const zcodeMcpListModeSchema = z.enum(["connect", "status"]);

export type ZCodeMcpListMode = z.infer<typeof zcodeMcpListModeSchema>;

export const zcodeMcpListParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    mcpServers: z.array(zcodeProtocolMcpServerSchema).optional(),
    mode: zcodeMcpListModeSchema.default("connect"),
  })
  .strict();

export const zcodeMcpListResultSchema = z
  .object({
    statuses: z.record(z.string(), zcodeMcpServerStatusSnapshotSchema),
  })
  .strict();

export type ZCodeMcpListResult = z.infer<typeof zcodeMcpListResultSchema>;

/**
 * project-scope MCP 显式连接（`mcp/connect`）。
 *
 * 请求只带 server 名和用户同意位，不带 command/args/env/url/headers：待批准的定义
 * 必须由 Agent 从当前生效配置重新读取并与随后 connect 使用的是同一个对象，
 * 避免 UI 构造/替换定义或把凭据经协议回传。多余字段由 `.strict()` 直接拒绝。
 */
export const zcodeMcpConnectApprovalSchema = z.enum(["granted", "not_required", "not_requested"]);

export type ZCodeMcpConnectApproval = z.infer<typeof zcodeMcpConnectApprovalSchema>;

export const zcodeMcpConnectParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    serverName: nonEmptyString,
    mcpServers: z.array(zcodeProtocolMcpServerSchema).optional(),
    /** 显式用户同意；缺失/false 时 project-scope server 保持 fail closed。 */
    approveProjectScope: z.boolean().default(false),
  })
  .strict();

export const zcodeMcpConnectResultSchema = z
  .object({
    connected: z.boolean(),
    requiresApproval: z.boolean(),
    approval: zcodeMcpConnectApprovalSchema,
    status: zcodeMcpServerStatusSnapshotSchema,
  })
  .strict();

export type ZCodeMcpConnectResult = z.infer<typeof zcodeMcpConnectResultSchema>;

// 插件 UI：UI 发起的 MCP 资源读取与工具调用，
// 按 pluginId 限定 server 归属，agent 侧 fail closed。
export const zcodeMcpUiOpenInstanceParamsSchema = z
  .object({
    accountContext: z.string().max(256).optional(),
    workspace: zcodeWorkspaceRefSchema,
    sessionId: nonEmptyString,
    pluginId: nonEmptyString,
    serverName: nonEmptyString,
    scopeId: nonEmptyString.max(4096),
    resourceUri: nonEmptyString.max(2048),
    ownerWebContentsId: z.number().int().positive(),
  })
  .strict();

export const zcodeMcpUiOpenInstanceResultSchema = mcpAppInstanceSchema;

export type ZCodeMcpUiOpenInstanceParams = z.infer<typeof zcodeMcpUiOpenInstanceParamsSchema>;

const zcodeMcpUiPluginScopeShape = {
  instance: mcpAppInstanceSchema,

  workspace: zcodeWorkspaceRefSchema,
  sessionId: nonEmptyString,
  pluginId: nonEmptyString,
  serverName: nonEmptyString,
};

export const zcodeMcpUiCloseInstanceParamsSchema = z
  .object({ ...zcodeMcpUiPluginScopeShape, onlyIfIdle: z.boolean().optional() })
  .strict();

export const zcodeMcpUiCloseInstanceResultSchema = z.object({ closed: z.boolean() }).strict();

export const zcodeMcpReadResourceParamsSchema = z
  .object({ ...zcodeMcpUiPluginScopeShape, uri: nonEmptyString.max(2048) })
  .strict();

export type ZCodeMcpReadResourceParams = z.infer<typeof zcodeMcpReadResourceParamsSchema>;

export const zcodeMcpResourceContentSchema = z
  .object({
    uri: z.string(),
    mimeType: z.string().optional(),
    text: z.string().optional(),
    blob: z.string().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const zcodeMcpReadResourceResultSchema = z
  .object({ contents: z.array(zcodeMcpResourceContentSchema) })
  .strict();

export type ZCodeMcpReadResourceResult = z.infer<typeof zcodeMcpReadResourceResultSchema>;

/**
 * 插件页面发起的 `resources/read` 代理。
 * 与 `mcp/readResource`（宿主取 ui:// HTML）参数同形，但结果去掉 `_meta`、受 8 MiB 与 mimeType 白名单约束。
 */
export const zcodeMcpUiReadResourceParamsSchema = zcodeMcpReadResourceParamsSchema;

export type ZCodeMcpUiReadResourceParams = z.infer<typeof zcodeMcpUiReadResourceParamsSchema>;

export const zcodeMcpUiResourceContentSchema = z
  .object({
    uri: z.string(),
    mimeType: z.string().optional(),
    text: z.string().optional(),
    blob: z.string().optional(),
  })
  .strict();

export const zcodeMcpUiReadResourceResultSchema = z
  .object({ contents: z.array(zcodeMcpUiResourceContentSchema) })
  .strict();

export type ZCodeMcpUiReadResourceResult = z.infer<typeof zcodeMcpUiReadResourceResultSchema>;

export const zcodeMcpUiSamplingParamsSchema = z
  .object({
    ...zcodeMcpUiPluginScopeShape,
    operationId: nonEmptyString.max(128),
    request: mcpAppsSamplingParamsSchema,
  })
  .strict();

export const zcodeMcpUiCancelSamplingParamsSchema = z
  .object({
    ...zcodeMcpUiPluginScopeShape,
    operationId: nonEmptyString.max(128),
  })
  .strict();

export const zcodeMcpUiSamplingResultSchema = mcpAppsSamplingResultSchema;

export type ZCodeMcpUiSamplingParams = z.infer<typeof zcodeMcpUiSamplingParamsSchema>;

export type ZCodeMcpUiCancelSamplingParams = z.infer<typeof zcodeMcpUiCancelSamplingParamsSchema>;

export const zcodeMcpUiCallToolParamsSchema = z
  .object({
    ...zcodeMcpUiPluginScopeShape,
    toolName: nonEmptyString,
    arguments: z.record(z.string(), z.unknown()).optional(),
    /** 宿主生成的调用 id，配合 `mcp/uiCancelCall` 取消进行中的调用。 */
    callId: nonEmptyString.max(128),
  })
  .strict();

export type ZCodeMcpUiCallToolParams = z.infer<typeof zcodeMcpUiCallToolParamsSchema>;

/** 取消页面发起的工具调用（卡片卸载、会话切换）；agent 侧 abort 到 MCP client。 */
export const zcodeMcpUiCancelCallParamsSchema = z
  .object({ ...zcodeMcpUiPluginScopeShape, callId: nonEmptyString.max(128) })
  .strict();

export type ZCodeMcpUiCancelCallParams = z.infer<typeof zcodeMcpUiCancelCallParamsSchema>;

export const zcodeMcpUiCancelCallResultSchema = z.object({ cancelled: z.boolean() }).strict();

export type ZCodeMcpUiCancelCallResult = z.infer<typeof zcodeMcpUiCancelCallResultSchema>;

/** 页面发起的 resources/list、resources/templates/list、subscribe、unsubscribe 代理。 */
export const zcodeMcpUiListResourcesParamsSchema = z
  .object({
    ...zcodeMcpUiPluginScopeShape,
    cursor: nonEmptyString.max(2048).optional(),
  })
  .strict();

export type ZCodeMcpUiListResourcesParams = z.infer<typeof zcodeMcpUiListResourcesParamsSchema>;

const zcodeMcpUiResourceDescriptorSchema = z
  .object({
    uri: z.string(),
    name: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
    // MCP Resource 的标准字段；规范把资源级 csp / prefersBorder 放在这里，宿主读 HTML 项缺 _meta 时回退用。
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const zcodeMcpUiListResourcesResultSchema = z
  .object({
    resources: z.array(zcodeMcpUiResourceDescriptorSchema),
    nextCursor: z.string().optional(),
  })
  .strict();

export type ZCodeMcpUiListResourcesResult = z.infer<typeof zcodeMcpUiListResourcesResultSchema>;

export const zcodeMcpUiListResourceTemplatesResultSchema = z
  .object({
    resourceTemplates: z.array(
      z
        .object({
          uriTemplate: z.string(),
          name: z.string().optional(),
          title: z.string().optional(),
          description: z.string().optional(),
          mimeType: z.string().optional(),
        })
        .strict(),
    ),
    nextCursor: z.string().optional(),
  })
  .strict();

export type ZCodeMcpUiListResourceTemplatesResult = z.infer<
  typeof zcodeMcpUiListResourceTemplatesResultSchema
>;

/** 订阅者身份 = 会话 + 沙箱作用域 + 实例代际（initId）；dispose 只退订本代际，新实例不受影响。 */
export const zcodeMcpUiResourceSubscriptionParamsSchema = z
  .object({
    ...zcodeMcpUiPluginScopeShape,
    scopeId: nonEmptyString.max(256),
    generation: z.number().int().nonnegative(),
    uri: nonEmptyString.max(2048),
  })
  .strict();

export type ZCodeMcpUiResourceSubscriptionParams = z.infer<
  typeof zcodeMcpUiResourceSubscriptionParamsSchema
>;

export const zcodeMcpUiResourceSubscriptionResultSchema = z.object({}).strict();

/**
 * App-Provided Tools：实例身份 = 会话 + 沙箱作用域 + 代际（与资源订阅同一三元组）。
 * 登记按实例整体替换；调用认领 / 回传按 callId 幂等。
 */
const zcodeMcpUiAppToolInstanceShape = {
  ...zcodeMcpUiPluginScopeShape,
  scopeId: nonEmptyString.max(256),
  generation: z.number().int().nonnegative(),
};

export const zcodeMcpUiRegisterAppToolsParamsSchema = z
  .object({
    ...zcodeMcpUiAppToolInstanceShape,
    tools: z.array(mcpAppsAppToolDescriptorSchema).max(MCP_APPS_APP_TOOLS_MAX_PER_INSTANCE),
  })
  .strict();

export type ZCodeMcpUiRegisterAppToolsParams = z.infer<
  typeof zcodeMcpUiRegisterAppToolsParamsSchema
>;

export const zcodeMcpUiRegisterAppToolsResultSchema = z
  .object({
    tools: z.array(z.object({ name: z.string(), modelName: z.string() }).strict()),
  })
  .strict();

export type ZCodeMcpUiRegisterAppToolsResult = z.infer<
  typeof zcodeMcpUiRegisterAppToolsResultSchema
>;

export const zcodeMcpUiUnregisterAppToolsParamsSchema = z
  .object(zcodeMcpUiAppToolInstanceShape)
  .strict();

export type ZCodeMcpUiUnregisterAppToolsParams = z.infer<
  typeof zcodeMcpUiUnregisterAppToolsParamsSchema
>;

export const zcodeMcpUiUnregisterAppToolsResultSchema = z
  .object({ removed: z.number().int().nonnegative() })
  .strict();

export type ZCodeMcpUiUnregisterAppToolsResult = z.infer<
  typeof zcodeMcpUiUnregisterAppToolsResultSchema
>;

export const zcodeMcpUiClaimAppToolCallParamsSchema = z
  .object({
    ...zcodeMcpUiAppToolInstanceShape,
    callId: nonEmptyString.max(MCP_APPS_APP_TOOL_CALL_ID_MAX_CHARS),
  })
  .strict();

export type ZCodeMcpUiClaimAppToolCallParams = z.infer<
  typeof zcodeMcpUiClaimAppToolCallParamsSchema
>;

export const zcodeMcpUiAppToolAcceptedResultSchema = z.object({ accepted: z.boolean() }).strict();

export type ZCodeMcpUiAppToolAcceptedResult = z.infer<typeof zcodeMcpUiAppToolAcceptedResultSchema>;

export const zcodeMcpUiResolveAppToolCallParamsSchema = z
  .object({
    ...zcodeMcpUiAppToolInstanceShape,
    callId: nonEmptyString.max(MCP_APPS_APP_TOOL_CALL_ID_MAX_CHARS),
    result: mcpAppsAppToolCallResultSchema.optional(),
    error: z
      .object({
        message: z.string().max(MCP_APPS_APP_TOOL_ERROR_MESSAGE_MAX_CHARS),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => (value.result === undefined) !== (value.error === undefined), {
    message: "exactly one of result or error is required",
  });

export type ZCodeMcpUiResolveAppToolCallParams = z.infer<
  typeof zcodeMcpUiResolveAppToolCallParamsSchema
>;

export const zcodeMcpUiCallToolResultSchema = z
  .object({
    content: z.array(z.record(z.string(), z.unknown())),
    structuredContent: z.unknown().optional(),
    isError: z.boolean().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type ZCodeMcpUiCallToolResult = z.infer<typeof zcodeMcpUiCallToolResultSchema>;
