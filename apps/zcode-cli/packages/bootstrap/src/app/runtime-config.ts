import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ConfigResult } from "@zcode/adapters/config";
import { GEN_UI_OUTPUT_ROOT_ENV } from "@zcode/shared/node";
import { resolveInitialModelSelection, type ModelSelectionOptions } from "@zcode/provider";
import { resolveBashTimeoutPolicy, type AgentProfile, type AgentRuntimeConfig } from "@zcode/core";
import {
  ZCODE_SUBAGENT_MAX_PARALLEL_ENV_KEY,
  ZCODE_SUBAGENT_TASK_TIMEOUT_MINUTES_ENV_KEY,
  readSubagentMaxParallel,
  readSubagentTaskTimeoutMinutes,
  type BuiltInSubagentModelSelectionOverrides,
} from "@zcode/shared";
import {
  type CollaborationMode,
  type HookConfigSource,
  type HookEventName,
  type HookMatcherConfig,
  type HooksRuntimeConfig,
  type McpServerConfig,
} from "@zcode/contracts";
import { omitMcpServers, resolveTrustedOfficialCuaServerNames } from "../mcp-config.js";
import { resolveDefaultEmbeddedSearchBackend } from "./embedded-search-backend.js";
import { getProjectMemoryRoot } from "./paths.js";
import type { ZCodeAppOptions } from "./types.js";
import {
  resolveRegistryOwnedModelSelection,
  resolveRegistryModelSelection,
  type ResolvedRegistrySelection,
} from "./provider-registry-selection.js";

interface ResolvedAppRuntimeConfig {
  configuredMcpServers: Record<string, McpServerConfig>;
  runtimeConfig: AgentRuntimeConfig;
  untrustedProjectMcpServers: Set<string>;
}

/**
 * 审批等待上限默认值（research R05 / docs/specs/2026-11-11-permission-hard-deny-approval-timeout.md）。
 *
 * 悬空审批过去可以永久挂起 turn：`AgentRuntimeConfig.permissionTimeoutMs` 有类型和完整
 * 消费链（ToolExecutor → PermissionBroker），但没有任何启动方赋值。配置键
 * `permission.approvalTimeoutMs` 已由 contracts/adapters 提供，其 DefaultRuntimeConfig 也是
 * 300000；这里的常量只作为配置链之外的装配兜底（例如手工构造的 ConfigResult），
 * 保证两处取值一致，而不是第二条判定路径。
 *
 * 优先级：显式会话值（`options.runtimeConfig.permissionTimeoutMs`）> 配置文件 > 300000。
 * 显式 `0` 表示关闭超时（broker 只在有限正数上排 timer），`??` 不会吞掉 0。
 */
const DEFAULT_PERMISSION_APPROVAL_TIMEOUT_MS = 300_000;

/**
 * 审批等待上限的单一投影：显式会话值 > 配置文件 `permission.approvalTimeoutMs` > 300000。
 *
 * 参数类型显式声明为 `number | undefined`：`RuntimeConfig.permission.approvalTimeoutMs` 是
 * 必填 `number`，若在调用点直接写 `session ?? config ?? 300000`，TS 的“右侧不可达”
 * 检查（TS2869）会拒绝；而运行时手工装配的 ConfigResult 仍可能不带该键。
 * 用 `??` 而非真值判断：显式 `0` 表示关闭超时，必须原样保留。
 */
function resolvePermissionApprovalTimeoutMs(
  sessionValue: number | undefined,
  configuredValue: number | undefined,
): number {
  return sessionValue ?? configuredValue ?? DEFAULT_PERMISSION_APPROVAL_TIMEOUT_MS;
}

/** project-scope MCP 授权记录的唯一持久化形态；不保存 command/args/env/url 原文。 */
export interface McpProjectTrustRecord {
  workspaceIdentity: string;
  serverName: string;
  definitionDigest: string;
  decision: "approved";
  /** 仅审计用途，不参与授权匹配。 */
  grantedAt: string;
}

const MCP_PROJECT_TRUST_STORE_SCHEMA_VERSION = 1;
const MCP_PROJECT_TRUST_STORE_DIR = "security";
const MCP_PROJECT_TRUST_STORE_FILE = "mcp-project-trust-v1.json";
const MCP_PROJECT_TRUST_DIGEST_VERSION = 1;
const SHA256_HEX = /^[a-f0-9]{64}$/;

interface ResolvedInitialRegistrySelection extends ResolvedRegistrySelection {
  readonly selectionOptions?: ModelSelectionOptions;
}

export function resolveAppRuntimeConfig(input: {
  cliStorageRoot: string;
  configResult: ConfigResult;
  options: ZCodeAppOptions;
  persistedMode?: CollaborationMode;
  builtInMcpServers?: Record<string, McpServerConfig>;
  builtInSubagentModelSelectionOverrides?: BuiltInSubagentModelSelectionOverrides;
  pluginHooks?: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  pluginMcpServers?: Record<string, McpServerConfig>;
  pluginRuntimeFeatures?: AgentRuntimeConfig["runtimeFeatures"];
  /** project-scope MCP 的显式授权快照；缺省 = 零授权（fail closed）。 */
  projectMcpTrust?: ProjectMcpTrustSnapshot;
  subagentOutputRootDir: string;
  subagentProfiles?: readonly AgentProfile[];
  storageRoot?: string;
  workingDirectory: string;
  workspaceIdentity?: string;
}): ResolvedAppRuntimeConfig {
  const {
    cliStorageRoot,
    configResult,
    options,
    persistedMode,
    builtInMcpServers,
    pluginMcpServers,
    pluginRuntimeFeatures,
    subagentOutputRootDir,
    subagentProfiles = [],
    workingDirectory,
    workspaceIdentity,
  } = input;
  const userInstructions = options.runtimeConfig?.userInstructions ?? { workingDirectory };
  const registrySelection = resolveInitialRegistrySelection(options);
  // 恢复历史不等于开始执行：失效/缺失选择保持未绑定，不能借 configured default 补齐。
  const initialModelSelection = options.resume
    ? registrySelection?.selection
    : (options.runtimeConfig?.modelSelection ?? registrySelection?.selection);
  // 空白会话先创建、再应用本次 Submission 的选择；强制初始默认模型会
  // 让未配置 default 的用户在 switch/send 前就创建失败。未绑定 Runtime 可以存在，
  // 真正执行仍由 admission/ModelFactory 校验完整选择，不能在这里偷偷选择 Registry 首项。
  const requestedTitleGeneration = options.runtimeConfig?.titleGeneration;
  const requestedTitleModelSelection = requestedTitleGeneration?.modelSelection;
  const titleGeneration =
    requestedTitleGeneration === undefined
      ? undefined
      : {
          ...requestedTitleGeneration,
          // 标题生成 sidecar 默认 15s 在慢模型/代理链路下容易超时，
          // 入口层统一补 60s，避免旧 core 默认值或空配置让桌面端继续回落到 15s。
          timeoutMs: requestedTitleGeneration.timeoutMs ?? 60_000,
          // 空 titleGeneration 表示启用默认标题生成，模型必须跟随会话当前模型。
          // 如果这里在草稿 session 创建时固化另一份标题模型，之后切模型只会更新主链路，
          // 首发时的 generate title sidecar 会继续使用切换前的旧 provider/model。
          ...(requestedTitleModelSelection
            ? {
                modelSelection: requestedTitleModelSelection,
              }
            : {}),
        };
  // Protocol session/create 传入的 mcp.servers 只包含 UI MCP 设置里的用户配置，
  // 不包含插件注册的 MCP。宿主内建 server 最后合并并保留其 identity，避免用户或第三方
  // 用同名配置劫持 mcp__node_repl__*；普通 plugin MCP 仍允许显式用户配置覆盖。
  const configuredMcpServers = {
    ...pluginMcpServers,
    ...(options.runtimeConfig?.mcp?.servers ?? configResult.config.mcp.servers),
    ...builtInMcpServers,
  };
  const trustedOfficialCuaServerNames = resolveTrustedOfficialCuaServerNames(
    configuredMcpServers,
    pluginMcpServers ?? {},
  );
  const cuaBridgeServerNames = new Set(trustedOfficialCuaServerNames);
  if (pluginRuntimeFeatures?.computerUse === true && configuredMcpServers.node_repl) {
    // node_repl 需要 broker 注入，但不是 CUA MCP server。注入资格与官方 CUA 图片
    // authority 必须分开；把它塞进 trustedOfficialCuaServerNames 会让整个
    // 通用 node_repl 结果被误送进 exact-raster gate，Browser 截图和 console 日志都会失败。
    cuaBridgeServerNames.add("node_repl");
  }
  // project-scope MCP 默认 untrusted：workspace 仓库不能靠提交一份 config 就执行任意
  // stdio command。判定只信任 config-factory 给出的最终生效层（serverSources），
  // 不新增第二套 scope 推断。user/env/cli/plugin/builtin server 行为保持不变。
  const untrustedProjectMcpServers = resolveUntrustedProjectMcpServers({
    configuredMcpServers,
    // 手工装配的 ConfigResult（嵌入/测试）可能没有 sources.mcp；缺省标签视为非 project，
    // 保持既有行为，只有 config-factory 明确标记 project 的条目才进入 fail-closed 判定。
    serverSources: configResult.sources.mcp?.serverSources ?? {},
    trust: input.projectMcpTrust,
    hostOwnedServerNames: new Set(Object.keys(builtInMcpServers ?? {})),
  });
  const autoConnectMcpServers = omitMcpServers(
    configuredMcpServers,
    untrustedProjectMcpServers,
    cuaBridgeServerNames,
  );
  const runtimeBuiltInModelSelectionOverrides =
    options.runtimeConfig?.subagents?.builtInModelSelectionOverrides ?? {};
  const runtimeConfig: AgentRuntimeConfig = {
    ...options.runtimeConfig,
    genUiOutputRoot: (options.env ?? process.env)[GEN_UI_OUTPUT_ROOT_ENV],
    bashTimeoutPolicy:
      options.runtimeConfig?.bashTimeoutPolicy ??
      resolveBashTimeoutPolicy(options.env ?? process.env),
    // 保留 AppSettings.spawnBudget 的存储兼容，但不再把旧任务总数上限传入 runtime。
    subagentMaxParallel:
      options.runtimeConfig?.subagentMaxParallel ??
      readSubagentMaxParallel((options.env ?? process.env)[ZCODE_SUBAGENT_MAX_PARALLEL_ENV_KEY]),
    subagentTaskTimeoutMinutes:
      options.runtimeConfig?.subagentTaskTimeoutMinutes ??
      readSubagentTaskTimeoutMinutes(
        (options.env ?? process.env)[ZCODE_SUBAGENT_TASK_TIMEOUT_MINUTES_ENV_KEY],
      ),
    mode: options.runtimeConfig?.mode ?? persistedMode ?? configResult.config.permission.mode,
    // Workspace 边界（docs/specs/2026-11-11-workspace-boundary.md）：显式会话值 >
    // user/project 配置文件 > 兼容默认 allow。消费链在 core executor → path-policy。
    workspaceBoundary:
      options.runtimeConfig?.workspaceBoundary ?? configResult.config.workspaceBoundary,
    // 悬空审批必须有界：显式会话值（含 0 = 无超时）> 配置文件 `permission.approvalTimeoutMs`
    // > 300000 默认。消费链已存在（core runtime-tools → ToolExecutor → PermissionBroker），
    // 这里只做投影。
    permissionTimeoutMs: resolvePermissionApprovalTimeoutMs(
      options.runtimeConfig?.permissionTimeoutMs,
      configResult.config.permission.approvalTimeoutMs,
    ),
    modelSelection: initialModelSelection,
    // 仅接受显式传入的会话级工具面（ZCode Protocol session/create 或 CLI
    // --allowed-tools/--disallowed-tools）。不要从 config.permission.allowedTools
    // 回落：那个键的既有语义是“免审批清单”，把它投影到注册面会让老配置里
    // 只写了几个 allowedTools 的用户突然丢失其余全部工具。
    toolAllowlist: options.runtimeConfig?.toolAllowlist,
    toolDisallowlist: options.runtimeConfig?.toolDisallowlist,
    embeddedSearchBackend:
      options.runtimeConfig?.embeddedSearchBackend ??
      resolveDefaultEmbeddedSearchBackend({
        env: options.env,
      }),
    runtimeFeatures: pluginRuntimeFeatures,
    language: options.runtimeConfig?.language,
    titleGeneration,
    workingDirectory,
    additionalDirectories: options.additionalDirectories,
    userInstructions: {
      ...userInstructions,
      workingDirectory: userInstructions.workingDirectory ?? workingDirectory,
    },
    skillMetadataBudget:
      options.runtimeConfig?.skillMetadataBudget ?? configResult.config.skills.metadataBudget,
    toolConcurrency: {
      maxConcurrency:
        options.runtimeConfig?.toolConcurrency?.maxConcurrency ??
        configResult.config.toolConcurrency.maxConcurrency,
    },
    modelAnomalyGuard: {
      ...configResult.config.modelAnomalyGuard,
      ...options.runtimeConfig?.modelAnomalyGuard,
    },
    mcp: {
      enabled: options.runtimeConfig?.mcp?.enabled ?? configResult.config.features.mcp,
      servers: autoConnectMcpServers,
      trustedOfficialCuaServerNames: [...trustedOfficialCuaServerNames],
    },
    hooks: mergeRuntimeHooks(
      options.runtimeConfig?.hooks
        ? withHookConfigSource(options.runtimeConfig.hooks, { kind: "internal" })
        : configResult.config.hooks,
      input.pluginHooks,
    ),
    subagents: {
      ...options.runtimeConfig?.subagents,
      enabled: options.runtimeConfig?.subagents?.enabled ?? configResult.config.features.subagent,
      outputRootDir: options.runtimeConfig?.subagents?.outputRootDir ?? subagentOutputRootDir,
      builtInModelSelectionOverrides: {
        ...(input.builtInSubagentModelSelectionOverrides ?? {}),
        ...runtimeBuiltInModelSelectionOverrides,
      },
      profiles: [...(options.runtimeConfig?.subagents?.profiles ?? []), ...subagentProfiles],
    },
    memory: {
      cliStorageRoot,
      enabled: options.runtimeConfig?.memory?.enabled ?? configResult.config.features.memory,
      ...(options.runtimeConfig?.memory?.extractionEnabled === undefined
        ? {}
        : { extractionEnabled: options.runtimeConfig.memory.extractionEnabled }),
      ...(input.storageRoot ? { storageRoot: input.storageRoot } : {}),
      use: options.runtimeConfig?.memory?.use ?? configResult.config.memory.use,
      workspaceIdentity: workspaceIdentity?.trim() || undefined,
    },
  };
  return {
    configuredMcpServers,
    runtimeConfig,
    untrustedProjectMcpServers,
  };
}

function withHookConfigSource(
  config: HooksRuntimeConfig,
  source: HookConfigSource,
): HooksRuntimeConfig {
  return {
    ...config,
    events: Object.fromEntries(
      Object.entries(config.events).map(([eventName, matchers]) => [
        eventName,
        matchers?.map((matcher) => ({
          ...matcher,
          hooks: matcher.hooks.map((hook) => ({ ...hook, source: hook.source ?? source })),
        })),
      ]),
    ) as HooksRuntimeConfig["events"],
  };
}

function resolveInitialRegistrySelection(
  options: ZCodeAppOptions,
): ResolvedInitialRegistrySelection | undefined {
  const registry = options.providerRegistry;
  if (!registry) return undefined;

  if (options.runtimeConfig?.modelSelection) {
    const selection = options.runtimeConfig.modelSelection;
    if (options.resume && !registry.validateSelection(selection).ok) return undefined;
    const resolved = resolveRegistryOwnedModelSelection(registry, selection);
    return resolved
      ? {
          ...resolved,
          ...(selection.options ? { selectionOptions: selection.options } : {}),
        }
      : undefined;
  }

  if (options.resume) return undefined;
  const initial = resolveInitialModelSelection({
    configuredDefault: options.configuredDefaultModelSelection,
    registry: registry.getView(),
  });
  if (initial.source === "none") return undefined;
  const resolved = resolveRegistryOwnedModelSelection(registry, initial.selection);
  return resolved
    ? {
        ...resolved,
        ...(initial.selection.options ? { selectionOptions: initial.selection.options } : {}),
      }
    : undefined;
}

function mergeRuntimeHooks(
  base: HooksRuntimeConfig | undefined,
  pluginHooks: Partial<Record<HookEventName, HookMatcherConfig[]>> | undefined,
): HooksRuntimeConfig | undefined {
  if (!pluginHooks || Object.values(pluginHooks).every((matchers) => !matchers?.length)) {
    return base;
  }

  const mergedEvents: HooksRuntimeConfig["events"] = {
    ...base?.events,
  };
  for (const [eventName, matchers] of Object.entries(pluginHooks) as Array<
    [HookEventName, HookMatcherConfig[]]
  >) {
    if (matchers.length === 0) continue;
    mergedEvents[eventName] = [...(mergedEvents[eventName] ?? []), ...matchers];
  }

  return {
    enabled: true,
    events: mergedEvents,
    maxOutputBytes: base?.maxOutputBytes ?? 32768,
    timeoutMs: base?.timeoutMs ?? 60000,
  };
}

export function runtimeConfigLogContext(
  runtimeConfig: AgentRuntimeConfig,
  workingDirectory: string,
) {
  const memoryRoot = runtimeConfig.memory?.cliStorageRoot
    ? getProjectMemoryRoot(
        runtimeConfig.memory.cliStorageRoot,
        workingDirectory,
        runtimeConfig.memory.workspaceIdentity,
      )
    : undefined;
  return {
    mcpEnabled: runtimeConfig.mcp?.enabled !== false,
    memoryEnabled: runtimeConfig.memory?.enabled !== false,
    memoryExtractionEnabled: runtimeConfig.memory?.extractionEnabled !== false,
    memoryRoot,
    memoryUse: runtimeConfig.memory?.use !== false,
    mcsMode: runtimeConfig.midConversationSystem?.mode,
    mode: runtimeConfig.mode,
    model: runtimeConfig.modelSelection
      ? `${runtimeConfig.modelSelection.providerId}/${runtimeConfig.modelSelection.modelId}`
      : undefined,
    runtimeFeatureBrowserUse: runtimeConfig.runtimeFeatures?.browserUse === true,
    runtimeFeatureNodeRepl: runtimeConfig.runtimeFeatures?.nodeRepl === true,
    workingDirectory,
  };
}

/** 本次 App 可见的 project-scope MCP 授权快照；由 Host 在启动边界读出后注入。 */
export interface ProjectMcpTrustSnapshot {
  /** `workspaceIdentity?.trim() || workspacePath`，与 AGENTS.md 的 identity key 一致。 */
  workspaceIdentity: string;
  approvals: readonly McpProjectTrustRecord[];
}

/**
 * 归一化后的 digest 输入：只保留会被 Runtime 消费的执行语义。
 * 显式排除 `enabled`（启停是配置状态，不是执行内容）与已废弃别名。
 */
function canonicalMcpDefinition(config: McpServerConfig): Record<string, unknown> {
  const sortedRecord = (
    value: Record<string, string> | undefined,
  ): Record<string, string> | undefined => {
    if (!value) return undefined;
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, entry]) => [key, entry] as const)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    );
  };
  // oauth / auth / official 不在所有 union 分支上；用 in 收窄，禁止 as 断言绕过。
  const oauthConfig = "oauth" in config ? config.oauth : undefined;
  const authConfig = "auth" in config ? config.auth : undefined;
  const official = "official" in config ? config.official : undefined;
  const oauth = oauthConfig
    ? oauthConfig.type === "client_credentials"
      ? {
          type: oauthConfig.type,
          clientId: oauthConfig.clientId,
          clientSecret: oauthConfig.clientSecret,
          ...(oauthConfig.clientName ? { clientName: oauthConfig.clientName } : {}),
          ...(oauthConfig.scope ? { scope: oauthConfig.scope } : {}),
        }
      : {
          type: oauthConfig.type,
          ...(oauthConfig.clientId ? { clientId: oauthConfig.clientId } : {}),
          ...(oauthConfig.clientSecret ? { clientSecret: oauthConfig.clientSecret } : {}),
          ...(oauthConfig.clientName ? { clientName: oauthConfig.clientName } : {}),
          ...(oauthConfig.redirectPath ? { redirectPath: oauthConfig.redirectPath } : {}),
          ...(oauthConfig.scope ? { scope: oauthConfig.scope } : {}),
        }
    : undefined;
  const shared = {
    type: config.type,
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.alwaysLoad !== undefined ? { alwaysLoad: config.alwaysLoad } : {}),
    ...(config.isolation !== undefined ? { isolation: config.isolation } : {}),
    ...(config.protocolVersion !== undefined ? { protocolVersion: config.protocolVersion } : {}),
    ...(authConfig ? { auth: { type: authConfig.type, provider: authConfig.provider } } : {}),
    ...(official
      ? {
          official: {
            pluginId: official.pluginId,
            mcpKey: official.mcpKey,
            source: official.source,
          },
        }
      : {}),
  };

  if (config.type === "stdio") {
    return {
      ...shared,
      command: config.command,
      args: config.args ?? [],
      ...(config.cwd ? { cwd: config.cwd } : {}),
      ...(config.env ? { env: sortedRecord(config.env) } : {}),
      ...(oauth ? { oauth } : {}),
    };
  }
  return {
    ...shared,
    url: config.url,
    ...(config.headers ? { headers: sortedRecord(config.headers) } : {}),
    ...(oauth ? { oauth } : {}),
  };
}

/**
 * project-scope MCP 定义 digest。
 * 授权必须绑定执行语义：换 command / args / env / url / headers 都要让旧批准失效。
 * 输入含 secret，输出只有 hex；调用方禁止把输入写进日志或错误。
 */
export function computeMcpServerDefinitionDigest(config: McpServerConfig): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schema: "zcode.mcp.definition",
        version: MCP_PROJECT_TRUST_DIGEST_VERSION,
        server: canonicalMcpDefinition(config),
      }),
      "utf8",
    )
    .digest("hex");
}

/** trust identity key：统一走 workspaceIdentity，本地才回落到 workspacePath。 */
export function resolveMcpTrustIdentity(input: {
  workspaceIdentity?: string | undefined;
  workspacePath: string;
}): string {
  return input.workspaceIdentity?.trim() || input.workspacePath;
}

function isApprovedProjectMcpServer(
  name: string,
  config: McpServerConfig,
  trust: ProjectMcpTrustSnapshot | undefined,
): boolean {
  if (!trust) return false;
  const identity = trust.workspaceIdentity.trim();
  if (!identity) return false;
  const digest = computeMcpServerDefinitionDigest(config);
  return trust.approvals.some(
    (record) =>
      record.decision === "approved" &&
      record.workspaceIdentity === identity &&
      record.serverName === name &&
      record.definitionDigest === digest,
  );
}

/**
 * 计算本次 runtime 必须排除的 project-scope server。
 *
 * 只有 `serverSources[name] === "project"` 才进入判定：user/env/cli 覆盖同名条目后
 * config-factory 已把标签改成覆盖层，这一层判定因此不会误伤用户自己的 server。
 * 缺省 trust（undefined）等价于零授权，project server 一律 fail closed。
 *
 * `hostOwnedServerNames` 必须包含宿主内建 server（node_repl 等）：它们合并优先级最高，
 * 项目配置即使声明同名也只是被覆盖的低优先条目，不能因此把宿主 server 判成 untrusted。
 */
export function resolveUntrustedProjectMcpServers(input: {
  configuredMcpServers: Record<string, McpServerConfig>;
  serverSources: Record<string, string | undefined>;
  trust: ProjectMcpTrustSnapshot | undefined;
  hostOwnedServerNames?: ReadonlySet<string>;
}): Set<string> {
  const untrusted = new Set<string>();
  for (const [name, config] of Object.entries(input.configuredMcpServers)) {
    if (input.hostOwnedServerNames?.has(name)) continue;
    if (input.serverSources[name] !== "project") continue;
    if (isApprovedProjectMcpServer(name, config, input.trust)) continue;
    untrusted.add(name);
  }
  return untrusted;
}

/** 仅供显式连接路径：单调记录一次用户批准。 */
export function createMcpProjectApprovalRecord(input: {
  workspaceIdentity: string;
  serverName: string;
  config: McpServerConfig;
  now?: Date;
}): McpProjectTrustRecord {
  return {
    workspaceIdentity: input.workspaceIdentity.trim(),
    serverName: input.serverName,
    definitionDigest: computeMcpServerDefinitionDigest(input.config),
    decision: "approved",
    grantedAt: (input.now ?? new Date()).toISOString(),
  };
}

export function resolveMcpProjectTrustStorePath(storageRoot: string): string {
  return join(storageRoot, MCP_PROJECT_TRUST_STORE_DIR, MCP_PROJECT_TRUST_STORE_FILE);
}

/**
 * 显式批准的唯一写入路径：record 构造 + digest 绑定 + 原子 upsert。
 *
 * CLI `/mcp connect`（session facade）与 `mcp/connect` 协议方法都走这里，避免两条
 * approval 写入路径各自计算 digest 后漂移。本函数不记录日志，调用方按自己的 logger
 * 约定只输出 serverName/workspaceKey（禁止输出 command/args/env 或 digest 输入）。
 */
export async function grantProjectMcpServerApproval(input: {
  storageRoot: string;
  workspaceIdentity: string;
  serverName: string;
  config: McpServerConfig;
  now?: Date;
}): Promise<McpProjectTrustRecord> {
  const record = createMcpProjectApprovalRecord({
    workspaceIdentity: input.workspaceIdentity,
    serverName: input.serverName,
    config: input.config,
    ...(input.now ? { now: input.now } : {}),
  });
  await grantMcpProjectTrust({ storageRoot: input.storageRoot, record });
  return record;
}

interface McpProjectTrustStoreFile {
  schemaVersion: number;
  records: McpProjectTrustRecord[];
}

function parseMcpProjectTrustStoreFile(raw: unknown): McpProjectTrustRecord[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const file = raw as Partial<McpProjectTrustStoreFile>;
  if (file.schemaVersion !== MCP_PROJECT_TRUST_STORE_SCHEMA_VERSION) return [];
  if (!Array.isArray(file.records)) return [];
  const records: McpProjectTrustRecord[] = [];
  for (const candidate of file.records) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Partial<McpProjectTrustRecord>;
    if (record.decision !== "approved") continue;
    if (typeof record.workspaceIdentity !== "string" || !record.workspaceIdentity.trim()) continue;
    if (typeof record.serverName !== "string" || !record.serverName.trim()) continue;
    if (typeof record.definitionDigest !== "string") continue;
    if (!SHA256_HEX.test(record.definitionDigest)) continue;
    records.push({
      workspaceIdentity: record.workspaceIdentity,
      serverName: record.serverName,
      definitionDigest: record.definitionDigest,
      decision: "approved",
      grantedAt:
        typeof record.grantedAt === "string" ? record.grantedAt : new Date(0).toISOString(),
    });
  }
  return records;
}

/**
 * 读取 project-scope MCP 授权。缺失、解析失败或 schema 不符一律返回空集：
 * 损坏的 store 只能让 server 继续 untrusted，不能让整条启动链路失败。
 */
export async function readMcpProjectTrustRecords(
  storageRoot: string,
): Promise<McpProjectTrustRecord[]> {
  try {
    const content = await readFile(resolveMcpProjectTrustStorePath(storageRoot), "utf8");
    return parseMcpProjectTrustStoreFile(JSON.parse(content) as unknown);
  } catch {
    return [];
  }
}

/** 一次显式批准；进程内串行 + temp+rename，避免并发连接互相覆盖记录。 */
let mcpProjectTrustWriteQueue: Promise<unknown> = Promise.resolve();

export function grantMcpProjectTrust(input: {
  storageRoot: string;
  record: McpProjectTrustRecord;
}): Promise<void> {
  const run = async (): Promise<void> => {
    const filePath = resolveMcpProjectTrustStorePath(input.storageRoot);
    const directory = dirname(filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const existing = parseMcpProjectTrustStoreFile(
      await readFile(filePath, "utf8")
        .then((content) => JSON.parse(content) as unknown)
        .catch(() => undefined),
    );
    const key = `${input.record.workspaceIdentity}\u0000${input.record.serverName}\u0000${input.record.definitionDigest}`;
    const next = new Map<string, McpProjectTrustRecord>();
    for (const record of existing) {
      next.set(
        `${record.workspaceIdentity}\u0000${record.serverName}\u0000${record.definitionDigest}`,
        record,
      );
    }
    next.set(key, input.record);
    const tempPath = join(
      directory,
      `.${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    const payload: McpProjectTrustStoreFile = {
      schemaVersion: MCP_PROJECT_TRUST_STORE_SCHEMA_VERSION,
      records: [...next.values()],
    };
    try {
      await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(tempPath, filePath);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  };
  const queued = mcpProjectTrustWriteQueue.then(run, run);
  mcpProjectTrustWriteQueue = queued.catch(() => undefined);
  return queued;
}
