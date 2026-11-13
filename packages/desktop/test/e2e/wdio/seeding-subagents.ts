import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type PersonalProviderConfigSeed,
  seedPersonalProviderConfig,
  seedPersonalDefaultModelSelection,
} from "../helpers/model-provider-restart-config.js";
import {
  E2E_PROVIDER_REPLAY_API_KEY,
  e2eProviderPreset,
  e2eProviderPresetName,
  readE2EThoughtLevel,
  upstreamE2EContextWindowOverride,
  upstreamE2EMaxOutputTokensOverride,
} from "./env.js";
import { buildUpstreamE2EAnthropicBaseUrl } from "./mocks-upstream.js";
import {
  DESKTOP_DIR,
  E2E_AGENTS_STATE_FILE,
  E2E_APP_CONFIG_DIR,
  E2E_APP_PROVIDER_CONFIG_FILE,
  E2E_CLI_AGENTS_DIR,
  E2E_CLI_CONFIG_FILE,
  E2E_STORAGE_ROOT,
  E2E_USER_AGENTS_DIR,
} from "./paths.js";
import {
  isOAuthCredentialRecoverySpec,
  isSubagentCodingPlanLoginCatalogStaleSpec,
  usesProviderReadinessColdStartFixture,
} from "./seeding-spec-fixtures.js";
import {
  BUILT_IN_SUBAGENT_MODEL_OVERRIDES_SPEC,
  E2E_PROVIDER_ALTERNATE_PROVIDER_ID,
  E2E_PROVIDER_ALTERNATE_PROVIDER_NAME,
  E2E_PROVIDER_SECONDARY_MODEL,
  MODEL_PROVIDER_PLAN_SURFACE_SPEC,
  OFFPEAK_INVALID_TICKET_SPEC,
  OFFPEAK_SUBAGENT_MODEL_INHERITANCE_SPEC,
  SETTINGS_SUBAGENT_CREATE_EDIT_PERSISTENCE_SPEC,
  SUBAGENT_PROVIDER_REGISTRY_AGENT_NAME,
  SUBAGENT_PROVIDER_REGISTRY_COLD_START_SPEC,
  SUBAGENT_REASONING_AGENT_NAME,
  SUBAGENT_RUNTIME_CATALOG_AGENT_NAME,
  SUBAGENT_RUNTIME_CATALOG_MODEL,
  SUBAGENT_RUNTIME_CATALOG_PROVIDER_ID,
  SUBAGENT_RUNTIME_CATALOG_PROVIDER_NAME,
  SUBAGENT_RUNTIME_CATALOG_REASONING_SPEC,
  SUBAGENT_TEAM_SCOPE_SPEC,
  TOOL_ERROR_SURFACE_HEALTHY_AGENT_NAME,
  TOOL_ERROR_SURFACE_SPEC,
  TOOL_ERROR_SURFACE_STALE_AGENT_NAME,
} from "./specs.js";
import { wdioState } from "./state.js";

function isSubagentProviderRegistryColdStartSpec(specs: string[] = []) {
  return specs.some((spec) => spec.includes(SUBAGENT_PROVIDER_REGISTRY_COLD_START_SPEC));
}

export function isBuiltInSubagentModelSelectionOverridesSpec(specs: string[] = []) {
  return specs.some((spec) => spec.includes(BUILT_IN_SUBAGENT_MODEL_OVERRIDES_SPEC));
}

function isSettingsSubagentCreateEditPersistenceSpec(specs: string[] = []) {
  return specs.some((spec) => spec.includes(SETTINGS_SUBAGENT_CREATE_EDIT_PERSISTENCE_SPEC));
}

function isSubagentRuntimeCatalogReasoningSpec(specs: string[] = []) {
  return specs.some((spec) => spec.includes(SUBAGENT_RUNTIME_CATALOG_REASONING_SPEC));
}

export function isOffPeakSubagentModelInheritanceSpec(specs: string[] = []) {
  return specs.some((spec) => spec.includes(OFFPEAK_SUBAGENT_MODEL_INHERITANCE_SPEC));
}

export function isOffPeakInvalidTicketSpec(specs: string[] = []) {
  return specs.some((spec) => spec.includes(OFFPEAK_INVALID_TICKET_SPEC));
}

export function isModelProviderPlanSurfaceSpec(specs: string[] = []) {
  return specs.some((spec) => spec.includes(MODEL_PROVIDER_PLAN_SURFACE_SPEC));
}

function isToolErrorSurfaceSpec(specs: string[] = []) {
  return specs.some((spec) => spec.includes(TOOL_ERROR_SURFACE_SPEC));
}

export function seedE2EBuiltInSubagentModelOverrides(specs: string[] = []) {
  const builtInModelSelectionOverridesSpec = isBuiltInSubagentModelSelectionOverridesSpec(specs);
  const runtimeCatalogSpec = isSubagentRuntimeCatalogReasoningSpec(specs);
  const offPeakSubagentModelInheritanceSpec = isOffPeakSubagentModelInheritanceSpec(specs);
  if (
    !builtInModelSelectionOverridesSpec &&
    !runtimeCatalogSpec &&
    !offPeakSubagentModelInheritanceSpec
  ) {
    return;
  }

  // Bug 根因：browser.reloadSession() 会再次触发 beforeSession。若这里无条件重写，
  // 测试刚通过设置页保存的 structured selection 会在冷启动前被初始 fixture 覆盖，
  // 使“冷恢复”实际验证的仍是 seed，而不是用户持久化结果。初始 HOME 为空时才落盘。
  if (existsSync(E2E_AGENTS_STATE_FILE)) {
    return;
  }

  const overrideSelection = runtimeCatalogSpec
    ? {
        providerId: SUBAGENT_RUNTIME_CATALOG_PROVIDER_ID,
        modelId: SUBAGENT_RUNTIME_CATALOG_MODEL,
      }
    : {
        providerId: E2E_PROVIDER_ALTERNATE_PROVIDER_ID,
        modelId: E2E_PROVIDER_SECONDARY_MODEL,
      };
  const initialGeneralPurposeSelection =
    runtimeCatalogSpec || offPeakSubagentModelInheritanceSpec
      ? overrideSelection
      : {
          providerId: e2eProviderPreset.providerId,
          modelId: e2eProviderPreset.model,
        };
  mkdirSync(E2E_APP_CONFIG_DIR, { recursive: true });
  writeFileSync(
    E2E_AGENTS_STATE_FILE,
    JSON.stringify(
      {
        builtInModelSelectionOverrides: {
          Explore: {
            ...overrideSelection,
            ...(builtInModelSelectionOverridesSpec || runtimeCatalogSpec
              ? { options: { reasoningLevel: "invalid-e2e" } }
              : {}),
          },
          "general-purpose": {
            ...initialGeneralPurposeSelection,
            ...(runtimeCatalogSpec ? { options: { reasoningLevel: "high" } } : {}),
          },
        },
        disabledAgentIds: [],
      },
      null,
      2,
    ),
    "utf-8",
  );
}

export function seedE2ESubagentProfiles(specs: string[] = []) {
  if (specs.some((spec) => spec.includes("conversation-session-subagent-cross-host.test.ts"))) {
    // 内置文档插件已拆分并固定模型；覆盖/清除覆盖场景使用自己的继承模型 fixture。
    const pluginDir = resolve(E2E_STORAGE_ROOT, "cli/plugins");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      resolve(pluginDir, "installed_plugins.json"),
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "e2e-subagent-refresh@e2e-fixture",
            name: "e2e-subagent-refresh",
            marketplace: "e2e-fixture",
            version: "1.0.0",
            installPath: resolve(DESKTOP_DIR, "test/e2e/fixtures/subagent-refresh-plugin"),
            installedAt: "2026-09-18T00:00:00.000Z",
            updatedAt: "2026-09-18T00:00:00.000Z",
            scope: "user",
          },
        ],
      }),
    );
    const config = existsSync(E2E_CLI_CONFIG_FILE)
      ? JSON.parse(readFileSync(E2E_CLI_CONFIG_FILE, "utf8"))
      : {};
    config.plugins = {
      ...config.plugins,
      enabledPlugins: {
        ...config.plugins?.enabledPlugins,
        "e2e-subagent-refresh@e2e-fixture": true,
      },
    };
    writeFileSync(E2E_CLI_CONFIG_FILE, JSON.stringify(config));
  }
  const profileEntries: Array<{ content: string; name: string }> = [];

  if (isBuiltInSubagentModelSelectionOverridesSpec(specs)) {
    profileEntries.push({
      name: SUBAGENT_REASONING_AGENT_NAME,
      content: `---
name: ${SUBAGENT_REASONING_AGENT_NAME}
description: E2E custom subagent for reasoning effort persistence coverage.
model: custom:${E2E_PROVIDER_ALTERNATE_PROVIDER_ID}:${E2E_PROVIDER_SECONDARY_MODEL}
thoughtLevel: invalid-e2e
tools: Read
maxTurns: 1
---
You are the E2E reasoning reviewer. Reply only with the requested marker.
`,
    });
  }

  if (isSubagentRuntimeCatalogReasoningSpec(specs)) {
    profileEntries.push({
      name: SUBAGENT_RUNTIME_CATALOG_AGENT_NAME,
      content: `---
name: ${SUBAGENT_RUNTIME_CATALOG_AGENT_NAME}
description: E2E custom subagent for runtime reasoning catalog coverage.
model: custom:${SUBAGENT_RUNTIME_CATALOG_PROVIDER_ID}:${SUBAGENT_RUNTIME_CATALOG_MODEL}
thoughtLevel: invalid-e2e
tools: Read
maxTurns: 1
---
You are the E2E Claude catalog reviewer. Reply only with the requested marker.
`,
    });
  }

  if (isSubagentProviderRegistryColdStartSpec(specs)) {
    profileEntries.push({
      name: SUBAGENT_PROVIDER_REGISTRY_AGENT_NAME,
      content: `---
name: ${SUBAGENT_PROVIDER_REGISTRY_AGENT_NAME}
description: E2E subagent bound to an alternate provider for cold-start registry sync reproduction.
model: custom:${E2E_PROVIDER_ALTERNATE_PROVIDER_ID}:${E2E_PROVIDER_SECONDARY_MODEL}
tools: Read
maxTurns: 1
---
You are the E2E provider registry reviewer. Reply only with the requested marker.
`,
    });
  }

  if (isOffPeakSubagentModelInheritanceSpec(specs)) {
    profileEntries.push(
      {
        name: "Code Search",
        content: `---
name: Code Search
description: E2E custom foreground subagent with an explicit alternate provider model.
model: custom:${E2E_PROVIDER_ALTERNATE_PROVIDER_ID}:${E2E_PROVIDER_SECONDARY_MODEL}
tools: Read
maxTurns: 1
---
You are the E2E Code Search reviewer. Reply only with the requested marker.
`,
      },
      {
        name: "E2E OffPeak Inherit Reviewer",
        content: `---
name: E2E OffPeak Inherit Reviewer
description: E2E custom foreground subagent that normally inherits the session model.
tools: Read
maxTurns: 1
---
You are the E2E inherited-model reviewer. Reply only with the requested marker.
`,
      },
      {
        name: "E2E OffPeak Background Reviewer",
        content: `---
name: E2E OffPeak Background Reviewer
description: E2E custom profile configured to run in the background.
model: custom:${E2E_PROVIDER_ALTERNATE_PROVIDER_ID}:${E2E_PROVIDER_SECONDARY_MODEL}
tools: Read
background: true
maxTurns: 1
---
This E2E profile must be rejected before any provider request during an idle-plan turn.
`,
      },
    );
  }

  if (isToolErrorSurfaceSpec(specs)) {
    profileEntries.push(
      {
        name: TOOL_ERROR_SURFACE_STALE_AGENT_NAME,
        content: `---
name: ${TOOL_ERROR_SURFACE_STALE_AGENT_NAME}
description: E2E subagent intentionally bound to a stale provider/model for tool error surface coverage.
model: custom:e2e-stale-provider:e2e-stale-model
tools: Read
maxTurns: 1
---
You are the stale E2E reviewer. This profile should fail before any child model request.
`,
      },
      {
        name: TOOL_ERROR_SURFACE_HEALTHY_AGENT_NAME,
        content: `---
name: ${TOOL_ERROR_SURFACE_HEALTHY_AGENT_NAME}
description: E2E subagent used as the healthy sibling when another Agent tool fails.
tools: Read
maxTurns: 1
---
You are the healthy E2E reviewer. Reply only with the requested marker.
`,
      },
    );
  }

  if (specs.some((spec) => spec.includes(SUBAGENT_TEAM_SCOPE_SPEC))) {
    profileEntries.push({
      name: "e2e-team-scope-reviewer",
      content: `---
name: e2e-team-scope-reviewer
description: E2E custom subagent bound to a Team connection without organization/project scope.
model: custom:team-plan:e2e-missing-scope:team-model
tools: Read
maxTurns: 1
---
This child must fail before sending a provider request when the Team scope is unavailable.
`,
    });
  }

  if (profileEntries.length === 0) {
    return;
  }

  for (const agentsDir of [E2E_USER_AGENTS_DIR, E2E_CLI_AGENTS_DIR]) {
    // 修复原因：CLI runtime 从 storageRoot/agents 加载用户 subagent profile，
    // 而设置页/历史路径曾使用 .zcode/cli/agents。双写只作用于本复现 spec，
    // 避免路径差异让 case 停在 agent type not found，而不是 provider registry 缺失。
    mkdirSync(agentsDir, { recursive: true });
    for (const profile of profileEntries) {
      const profilePath = resolve(agentsDir, `${profile.name}.md`);
      // 同 agents-state：reloadSession 不能覆盖设置页已经保存的当前 Markdown。
      if (!existsSync(profilePath)) {
        writeFileSync(profilePath, profile.content, "utf-8");
      }
    }
  }
}

export async function seedUpstreamE2EModelConfig(specs: string[] = []) {
  if (isOAuthCredentialRecoverySpec(specs) || usesProviderReadinessColdStartFixture(specs)) {
    // Bugfix: OAuth 凭据恢复及 provider-readiness 冷启动 fixture 必须保持
    // 无可用本地模型配置，避免默认 上游 回放 provider 绕过登录/执行门禁。
    return;
  }

  const apiKey =
    wdioState.upstreamE2EHttpMode === "replay"
      ? E2E_PROVIDER_REPLAY_API_KEY
      : (process.env.E2E_PROVIDER_API_KEY?.trim() ?? "");
  if (!apiKey || apiKey === "xxx") {
    return;
  }

  // 修复原因：固定 e2e 默认回放真实采集 fixture，capture 模式才访问线上
  // 上游；baseURL 必须在每个 session 重置前跟随当前 HTTP 模式写入配置。
  const anthropicBaseURL = buildUpstreamE2EAnthropicBaseUrl();
  const modelSwitchToolEditForkSpec = specs.some((spec) =>
    spec.includes("conversation-session-model-switch-tool-edit-fork.test.ts"),
  );
  const modelProviderListFilteringSpec = specs.some((spec) =>
    spec.includes("conversation-session-model-provider-list-filtering.test.ts"),
  );
  const forkMergedAssistantSpec = specs.some((spec) =>
    spec.includes("conversation-session-fork-merged-assistant.test.ts"),
  );
  const bashReadStateSpec = specs.some((spec) =>
    spec.includes("conversation-session-bash-read-state.test.ts"),
  );
  const runningGuideSteerSpec = specs.some((spec) =>
    spec.includes("conversation-session-running-guide-steer.test.ts"),
  );
  const subagentProviderRegistryColdStartSpec = isSubagentProviderRegistryColdStartSpec(specs);
  const builtInSubagentModelOverridesSpec = isBuiltInSubagentModelSelectionOverridesSpec(specs);
  const settingsSubagentCreateEditPersistenceSpec =
    isSettingsSubagentCreateEditPersistenceSpec(specs);
  const exposeSubagentReasoningMetadata =
    // 思考隔离专项需要核对真实 wire；空 Map 会让参数缺席，无法验证 session 隔离。
    specs.some((spec) =>
      /conversation-session-(thought-level-session-isolation|readstate-model-isolation|v4-goal)\.test\.ts$/.test(
        spec,
      ),
    ) ||
    builtInSubagentModelOverridesSpec ||
    settingsSubagentCreateEditPersistenceSpec ||
    specs.some((spec) => spec.includes("plugin-subagent-override-cold.test.ts")) ||
    isSubagentCodingPlanLoginCatalogStaleSpec(specs);
  const subagentRuntimeCatalogReasoningSpec = isSubagentRuntimeCatalogReasoningSpec(specs);
  const offPeakSubagentModelInheritanceSpec = isOffPeakSubagentModelInheritanceSpec(specs);
  const browserUseIabLifecycleSpec = specs.some(
    (spec) =>
      spec.includes("conversation-session-browser-use-iab-full-chain.test.ts") ||
      spec.includes("conversation-session-browser-zoom-coordinates.test.ts") ||
      spec.includes("conversation-session-browser-use-iab-multitab-lifecycle.test.ts") ||
      spec.includes("conversation-session-node-repl-stateless-browser-multisession.test.ts") ||
      spec.includes("conversation-session-browser-use-subagent-boundary.test.ts"),
  );
  const toolCallGroupingSpec = specs.some(
    (spec) =>
      spec.includes("conversation-session-tool-stage-grouping-live-transition.test.ts") ||
      spec.includes("conversation-session-terminal-expanded-details-and-status.test.ts") ||
      spec.includes("conversation-session-changes-group-responsive-file-summary.test.ts") ||
      spec.includes("conversation-session-tool-group-reasoning-visibility-boundary.test.ts") ||
      spec.includes("conversation-session-tool-groups-history-restore.test.ts") ||
      // CUA response 分组必须连续观察多个 tool response 与非 CUA 关闭边界；
      // manual-review 的 240/80 小窗口会在边界前自动 compact，改写目标事件序列。
      spec.includes("conversation-session-cua-response-grouping.test.ts"),
  );
  const autoCompactSpec = specs.some(
    (spec) =>
      spec.includes("conversation-session-compact-auto.test.ts") ||
      spec.includes("conversation-session-compact-auto-actions.test.ts") ||
      // 转正后 spec 不再命中 manual-review 通配；MR-GOAL-09/17 仍依赖
      // 240/80 小窗口验证 queued goal 前置 auto compact，必须显式保留原环境合同。
      spec.includes("conversation-session-goal-run-cases.test.ts") ||
      spec.includes("conversation-session-model-switch-auto-compact.test.ts") ||
      // Bugfix: tool/edit/fork 模型继承 spec 不验证 guard；manual-review 的
      // 240/80 小窗口会让普通 completed 历史也被压缩 guard 合法取消，掩盖继承断言。
      // E10 merged assistant fork 复现只验证 fork 边界，必须保留默认上下文窗口，
      // 否则自动压缩会把 fork 历史边界问题和 compact 前置流程混在一起。
      // Bash read-state 复现只验证 Bash 读状态和 stale hint，不能把
      // manual-review 的小窗口 compact 插进工具链中间。
      // P06 必须连续经过 tool-batch 与 text-only 两个 steer drain 边界；240-token
      // 小窗口会在第三次主请求前插入 auto compact，覆盖掉本 case 要验证的时序。
      (spec.includes("test/e2e/conversation-session/manual-review/") &&
        !modelSwitchToolEditForkSpec &&
        !forkMergedAssistantSpec &&
        !bashReadStateSpec &&
        !runningGuideSteerSpec &&
        // OTC08/OTC09/OTC10 只观察 output-limit Continue 的累计 assistant 投影。manual-review
        // 默认 240/80 小窗口会在相邻 partial 之间插入 Compact，既污染 UI，也会让
        // summary 替换原始 marker 后使第三段 fixture 退化到通用 fallback。
        !spec.includes("conversation-session-output-limit-continue-ui.test.ts") &&
        !spec.includes("conversation-session-output-limit-continue-markdown-boundaries.test.ts") &&
        !spec.includes(
          "conversation-session-output-limit-continue-markdown-content-types.test.ts",
        ) &&
        !spec.includes("conversation-session-output-limit-continue-markdown-protocols.test.ts") &&
        !subagentProviderRegistryColdStartSpec &&
        // 本 case 连续验证三组 parent/child 请求；极小窗口会在第二组前插入 compact，
        // 与 model + reasoning effort 的目标语义无关。
        !builtInSubagentModelOverridesSpec &&
        !subagentRuntimeCatalogReasoningSpec &&
        !offPeakSubagentModelInheritanceSpec &&
        // Z02 要验证 cold follow-up 仍投影原始 tool block；240/80 小窗口会先触发
        // auto compact 并合法替换历史，导致测试观察到另一条产品路径。
        !spec.includes("conversation-session-tool-input-validation-provider-content.test.ts") &&
        // OP-CHAT-02 验证冷恢复旧会话仍有 OffPeakCreate 工具面并走完创建→卡片→编辑；
        // 240/80 小窗口会在 tool_result 后插入 auto compact，与闲时任务语义无关。
        !spec.includes("conversation-session-offpeak-create-existing-session.test.ts") &&
        // I70-I72 直接断言未经 compact 改写的 reasoning 历史投影与 signature retry；
        // 240-token 小窗口会在第二轮前合法替换历史，污染本 case 的 provider-visible 证据。
        !spec.includes("conversation-session-anthropic-reasoning-history-replay.test.ts") &&
        // SSE stall diagnostic 必须保留原始 partial/tool history 来判断恢复锚点；
        // manual-review 的 240/80 小窗口会插入无关 compact 并改写要采样的请求历史。
        !spec.includes("conversation-session-sse-stall-diagnostic.test.ts") &&
        // WPL-008 验证 resident App catalog 冻结及 cold resume 重建；自动 compact 会在
        // cold follow-up 前改写 resident 历史，把与 Plugin 生命周期无关的状态机混入用例。
        !spec.includes("conversation-session-plugin-resident-freeze-cold-resume.test.ts") &&
        // TGE01-TGE05 验证连续工具阶段、运行态 summary 与冷恢复；240/80 小窗口会在
        // 第二个工具后插入 auto compact，提前改写本组 case 要观察的原始工具序列。
        !toolCallGroupingSpec &&
        // 修复原因：Browser lifecycle case 要分别验证跨 turn tab 状态和显式图/轮尾图持久化；
        // manual-review 的极小自动 compact 会改写这两类历史，和目标断言语义互斥。
        // Browser compact 连续性应由独立 case 覆盖，不能混入 lifecycle 回归。
        !browserUseIabLifecycleSpec &&
        // BG41 只验证父 launch turn idle 后的 model-only 文件 Diff。manual-review
        // 默认 240-token 窗口会在 Read/Edit 之间插入 compact，并清空 read guard，
        // 把本 case 剪枝掉的 compact 语义错误混入缺陷回归。
        !spec.includes("conversation-session-background-file-diff.test.ts") &&
        // HK16 竞速回归只验证「确认窗打开期间用户批准先到者胜」；240/80 小窗口
        // 若在 tool_use 与 tool_result 之间插入无 fixture 的 compact 请求，其挂起
        // 表象与本 case 要回归的死锁缺陷无法区分，必须保留默认上下文窗口。
        !spec.includes("conversation-session-permission-hook-race.test.ts") &&
        // Hook 改写用例需要观察原始 tool_result；240-token 窗口会插入无关自动压缩，
        // 改写批准到模型收到结果的链路，因此与权限竞速用例一样保留正常窗口。
        !spec.includes("conversation-session-permission-hook-rewrite.test.ts") &&
        // Bug 根因：TX 显式叉乘 completed tool 后的 manual compact/fork/goal；
        // manual-review 默认 240/80 小窗口会在工具结果或 goal continuation 前额外插入
        // auto compact，把另一条产品路径混进 51 个独立断言并触发无 fixture 重试。
        !spec.includes("conversation-session-virtual-project-cold-roots.test.ts") &&
        // 未读矩阵的多轮完成由显式闸门控制；240 token 窗口会混入无关自动压缩。
        !spec.includes("conversation-session-web-remote-unread.test.ts") &&
        !spec.includes("conversation-session-tool-cross-product.test.ts") &&
        // SHR04-SHR08 验收同一父 session 的 append-only 前缀；小窗口 compact 会替换历史。
        !spec.includes("conversation-session-subagent-catalog-refresh.test.ts") &&
        // SHR09 只改变 profile 字段；保持历史便于断言旧 part 不变与单段父轨迹。
        !spec.includes("conversation-session-subagent-profile-fields.test.ts") &&
        !spec.includes("conversation-session-subagent-context-boundaries.test.ts") &&
        !spec.includes("conversation-session-subagent-multi-workspace.test.ts") &&
        !spec.includes("conversation-session-subagent-cross-host.test.ts")),
  );
  const modelSwitchAutoCompactSpec = specs.some((spec) =>
    spec.includes("conversation-session-model-switch-auto-compact.test.ts"),
  );
  const contextWindow = upstreamE2EContextWindowOverride ?? (autoCompactSpec ? 240 : 128000);
  const maxOutputTokens = upstreamE2EMaxOutputTokensOverride ?? (autoCompactSpec ? 80 : undefined);
  // 修复原因：model switch guard 读取的是 app 侧 provider metadata。
  // 该 spec 需要稳定触发“目标模型过小”的确认弹窗；真实 agent runtime
  // 继续使用上面的 240/80，避免为了触发 UI guard 拉长 prompt 影响回放稳定性。
  const appContextWindow =
    upstreamE2EContextWindowOverride ?? (modelSwitchAutoCompactSpec ? 1 : contextWindow);
  const appMaxOutputTokens =
    upstreamE2EMaxOutputTokensOverride ?? (modelSwitchAutoCompactSpec ? 1 : maxOutputTokens);
  mkdirSync(E2E_APP_CONFIG_DIR, { recursive: true });
  // 工具栏用例实际选择 high/max；只声明 disabled 会在进入交互断言前失败。
  const composerToolbarSpec = specs.some((spec) =>
    spec.includes("conversation-session-v4-composer-toolbar.test.ts"),
  );
  // 通用 fixture 自带完整 Option Spec，SSH 目标不依赖本机 E2E Built-in 补全。
  // Registry 以末项作为最高档；旧夹具将默认值放首项，导致 alternate 的 max 被 high 覆盖。
  const reasoning = (): PersonalProviderConfigSeed["models"][number]["reasoningLevel"] => ({
    values: specs.some((spec) => spec.endsWith("conversation-session-v4-goal.test.ts"))
      ? ["high", "low", "max"]
      : // 默认 env 的准备步骤选择 high；只声明 disabled 会在进入被测流程前失败。
        e2eProviderPresetName === "env" ||
          e2eProviderPresetName === "stagingmodel" ||
          composerToolbarSpec
        ? builtInSubagentModelOverridesSpec
          ? ["off", "low", "high", "max"]
          : ["high", "max"]
        : ["disabled"],
    // 只有专项 wire 用例注入思考参数；普通 replay 的响应节奏由 fixture 控制。
    map: exposeSubagentReasoningMetadata
      ? '{"thinking":{"type":"enabled","budget_tokens":1024},"output_config":{"effort":reasoningLevel}}'
      : "{}",
  });
  const model = (
    id: string,
    visibility?: "visible" | "hidden",
  ): PersonalProviderConfigSeed["models"][number] => ({
    id,
    contextWindow: appContextWindow,
    // 图片布局和 Stop 收尾用例必须检查真实图片 wire 内容，限定这些 fixture 支持图片输入。
    ...(specs.some(
      (spec) =>
        spec.includes("conversation-session-v4-attachment-layout.test.ts") ||
        spec.includes("conversation-session-stop-tool-results.test.ts"),
    )
      ? { inputModalities: ["text", "image"] as const }
      : {}),
    ...(appMaxOutputTokens !== undefined ? { maxOutputTokens: appMaxOutputTokens } : {}),
    reasoningLevel: reasoning(),
    ...(visibility ? { visibility } : {}),
  });
  const provider = (params: {
    apiKey?: string;
    baseURL?: string;
    enabled?: boolean;
    id: string;
    label: string;
    models: PersonalProviderConfigSeed["models"];
    visibility?: "visible" | "hidden";
  }): PersonalProviderConfigSeed => ({
    apiFormat: "anthropic-messages",
    apiKey: params.apiKey ?? apiKey,
    baseURL: params.baseURL ?? anthropicBaseURL,
    enabled: params.enabled ?? true,
    id: params.id,
    label: params.label,
    models: params.models,
    ...(params.visibility ? { visibility: params.visibility } : {}),
  });
  const appProviders: PersonalProviderConfigSeed[] = [
    provider({
      id: e2eProviderPreset.providerId,
      label: e2eProviderPreset.providerName,
      models: [
        model(e2eProviderPreset.model),
        ...(e2eProviderPresetName === "env" ? [model(E2E_PROVIDER_SECONDARY_MODEL)] : []),
      ],
    }),
    ...(e2eProviderPresetName === "env"
      ? [
          provider({
            id: E2E_PROVIDER_ALTERNATE_PROVIDER_ID,
            label: E2E_PROVIDER_ALTERNATE_PROVIDER_NAME,
            models: [model(E2E_PROVIDER_SECONDARY_MODEL)],
          }),
        ]
      : []),
    ...(subagentRuntimeCatalogReasoningSpec
      ? [
          provider({
            id: SUBAGENT_RUNTIME_CATALOG_PROVIDER_ID,
            label: SUBAGENT_RUNTIME_CATALOG_PROVIDER_NAME,
            // I68 验证四档父子请求隔离；通用 high/max 夹具不能代替其明确的 Option Spec。
            models: [
              {
                ...model(SUBAGENT_RUNTIME_CATALOG_MODEL),
                maxOutputTokens: 32_000,
                reasoningLevel: {
                  values: ["low", "medium", "high", "xhigh"],
                  map: '{"thinking":{"type":"enabled","budget_tokens":reasoningLevel == "low" ? 4000 : reasoningLevel == "medium" ? 8000 : reasoningLevel == "high" ? 16000 : 31999},"output_config":{"effort":reasoningLevel}}',
                },
              },
            ],
          }),
        ]
      : []),
    ...(modelProviderListFilteringSpec
      ? [
          provider({
            id: "e2e-hidden-provider",
            label: "Hidden Provider",
            models: [model("hidden-provider-model")],
            visibility: "hidden",
          }),
          provider({
            id: "e2e-visible-provider-hidden-model",
            label: "Visible Provider With Hidden Model",
            models: [model("visible-companion-model"), model("hidden-model", "hidden")],
          }),
          provider({
            enabled: false,
            id: "e2e-hidden-disabled",
            label: "Hidden Disabled Provider",
            models: [model("hidden-disabled-model")],
          }),
          provider({
            apiKey: "",
            id: "e2e-hidden-no-key",
            label: "Hidden No Key Provider",
            models: [model("hidden-no-key-model")],
          }),
          provider({
            baseURL: "",
            id: "e2e-hidden-no-endpoint",
            label: "Hidden No Endpoint Provider",
            models: [model("hidden-no-endpoint-model")],
          }),
          provider({
            baseURL: `${anthropicBaseURL}/builtin-personal-conflict`,
            id: "e2e-zai-template-provider",
            label: "Z.ai Template Provider E2E",
            models: [model("glm-5.3")],
          }),
        ]
      : []),
  ];
  for (const provider of appProviders) {
    await seedPersonalProviderConfig(E2E_APP_PROVIDER_CONFIG_FILE, provider);
  }
  await seedPersonalDefaultModelSelection(E2E_APP_PROVIDER_CONFIG_FILE, {
    providerId: e2eProviderPreset.providerId,
    modelId: e2eProviderPreset.model,
    // 远端 Provisioning 只接受完整模型选择；默认模型缺少思考档位会使 SSH 首连与
    // OP10 新建会话退回 Registry 推荐。无思考能力的模型也显式选择 disabled。
    options: { reasoningLevel: readE2EThoughtLevel() || "disabled" },
  });
}
