import { resolveUpstreamModels } from "../helpers/upstream-recorded-models.js";
import { ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV } from "@zcode/shared";
import { MANUAL_REVIEW_SPEC_GLOB } from "../../../scripts/e2e-formal-spec-selection.mjs";
import { readPositiveIntegerEnv } from "./paths.js";

export function isOpenCodeComposerE2E(specs: string[]) {
  return specs.some((spec) => spec.endsWith("conversation-session-opencode-cli-composer.test.ts"));
}
export function isOpenCodeCliInstallE2E(specs: string[]) {
  return specs.some((spec) => spec.endsWith("conversation-session-opencode-cli-install.test.ts"));
}
export const UPSTREAM_PROVIDER_SPEC = "./test/e2e/upstream-provider.test.ts";
export const TURN_STEER_PROBE_SPEC =
  "./test/e2e/conversation-session/manual-review/pending/conversation-session-turn-steer-probe.test.ts";
const PLUGIN_NO_GIT_GITHUB_ARCHIVE_SPEC = "plugin-no-git-github-archive.test.ts";
export const GIT_COMMIT_DIALOG_UI_FLOW_SPEC = "git-commit-dialog-ui-flow.test.ts";
export const OAUTH_CREDENTIAL_RECOVERY_SPEC = "oauth-credential-recovery.test.ts";
export const JWT_EXPIRY_REAUTHENTICATION_SPEC = "jwt-expiry-reauthentication.test.ts";
export const SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_SPEC =
  "subagent-coding-plan-login-catalog-stale.test.ts";
export const SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_MODE = "subagent-login-catalog-stale";
export const SUBAGENT_CODING_PLAN_OAUTH_FLOW_ID = "e2e-subagent-bigmodel-flow";
export const SUBAGENT_CODING_PLAN_OAUTH_STATE = "e2e-subagent-bigmodel-state";
export const PROVIDER_READINESS_AGENT_STARTUP_SPEC = "provider-readiness-agent-startup.test.ts";
export const CONTEXT_WINDOW_COLD_RESUME_SPEC =
  "conversation-session-context-window-cold-resume.test.ts";
const PASSIVE_AGENT_STARTUP_SPEC = "workspace-passive-agent-startup.test.ts";
const AGENT_WARMUP_LIFECYCLE_SPEC = "workspace-agent-warmup-lifecycle.test.ts";
const AGENT_WARMUP_SMALL_SET_SPEC = "workspace-agent-warmup-small-set.test.ts";
const PROVIDER_SAVE_DORMANT_AGENT_SPEC = "workspace-provider-save-dormant-agent.test.ts";
export const MODEL_PROVIDER_REGRESSION_GAPS_SPEC =
  "conversation-session-model-provider-regression-gaps.test.ts";
// 只借用这套 fixture 的「多 workspace 已恢复」启动态来做 workspace 切换，不断言 agent 预热行为。
const BROWSER_CROSS_WORKSPACE_CLOSE_SPEC = "browser-tab-close-cross-workspace.test.ts";
const WORKSPACE_REMOVAL_RUNTIME_RELEASE_SPEC = "workspace-removal-runtime-release.test.ts";
export const AGENT_WARMUP_FIXTURE_SPECS = [
  PASSIVE_AGENT_STARTUP_SPEC,
  AGENT_WARMUP_LIFECYCLE_SPEC,
  AGENT_WARMUP_SMALL_SET_SPEC,
  PROVIDER_SAVE_DORMANT_AGENT_SPEC,
  BROWSER_CROSS_WORKSPACE_CLOSE_SPEC,
  WORKSPACE_REMOVAL_RUNTIME_RELEASE_SPEC,
  MODEL_PROVIDER_REGRESSION_GAPS_SPEC,
] as const;
/** 只需要两个 workspace 的 spec，用小号 scenario 少 seed 7 个目录。 */
export const SMALL_AGENT_WARMUP_SPECS = [
  AGENT_WARMUP_SMALL_SET_SPEC,
  BROWSER_CROSS_WORKSPACE_CLOSE_SPEC,
  WORKSPACE_REMOVAL_RUNTIME_RELEASE_SPEC,
  MODEL_PROVIDER_REGRESSION_GAPS_SPEC,
] as const;
export const TASK_INDEX_ROW_AUTHORITY_SPEC =
  "conversation-session-task-index-row-authority.test.ts";
export const TASK_TITLE_MARQUEE_SPEC = "conversation-session-task-title-marquee.test.ts";
export const GIT_REVIEW_ENTRY_SPEC = "conversation-session-git-review-entry.test.ts";
export const WINDOWS_AGENT_METRIC_PROBE_ABSENCE_SPEC = "windows-agent-metric-probe-absence.test.ts";
export const HOOKS_LIFECYCLE_SPEC = "conversation-session-hooks-lifecycle.test.ts";
export const HOOK_TRUST_SPEC = "conversation-session-hook-trust.test.ts";
export const E2E_PROVIDER_ID = "e2e-upstream";
export const E2E_PROVIDER_ALTERNATE_PROVIDER_ID = "e2e-upstream-alt";
export const E2E_PROVIDER_ALTERNATE_PROVIDER_NAME = "Upstream E2E Alt";
// 模型名由 E2E_PROVIDER_MODEL / E2E_PROVIDER_SECONDARY_MODEL 控制，未设置时使用回放夹具的录制模型。
export const { model: E2E_PROVIDER_MODEL, secondaryModel: E2E_PROVIDER_SECONDARY_MODEL } =
  resolveUpstreamModels();
export const SUBAGENT_PROVIDER_REGISTRY_COLD_START_SPEC =
  "conversation-session-subagent-provider-registry-cold-start.test.ts";
export const BUILT_IN_SUBAGENT_MODEL_OVERRIDES_SPEC =
  "conversation-session-built-in-subagent-model-overrides.test.ts";
export const SETTINGS_SUBAGENT_CREATE_EDIT_PERSISTENCE_SPEC =
  "settings-subagent-create-edit-persistence.test.ts";
export const SUBAGENT_REASONING_AGENT_NAME = "e2e-reasoning-reviewer";
export const SUBAGENT_RUNTIME_CATALOG_REASONING_SPEC =
  "conversation-session-subagent-runtime-catalog-reasoning.test.ts";
export const SUBAGENT_RUNTIME_CATALOG_PROVIDER_ID = "e2e-claude-runtime-catalog";
export const SUBAGENT_RUNTIME_CATALOG_PROVIDER_NAME = "Claude Runtime Catalog E2E";
export const SUBAGENT_RUNTIME_CATALOG_MODEL = "claude-opus-4-8";
export const SUBAGENT_RUNTIME_CATALOG_AGENT_NAME = "e2e-claude-catalog-reviewer";
export const OFFPEAK_SUBAGENT_MODEL_INHERITANCE_SPEC =
  "conversation-session-offpeak-subagent-model-inheritance.test.ts";
export const OFFPEAK_INVALID_TICKET_SPEC = "conversation-session-off-peak-invalid-ticket.test.ts";
export const MODEL_PROVIDER_PLAN_SURFACE_SPEC =
  "conversation-session-model-provider-plan-surface.test.ts";
export const SUBAGENT_TEAM_SCOPE_SPEC = "conversation-session-subagent-team-scope.test.ts";
export const TOOL_ERROR_SURFACE_SPEC = "conversation-session-tool-error-surface.test.ts";
export const MODEL_OUTPUT_TOKEN_BUDGET_SPEC =
  "conversation-session-model-output-token-budget.test.ts";
export const MODEL_OUTPUT_TOKEN_PREFLIGHT_SPEC =
  "conversation-session-model-output-token-preflight";
export const OUTPUT_LIMIT_CONTINUE_MARKDOWN_PROTOCOLS_SPEC =
  "conversation-session-output-limit-continue-markdown-protocols.test.ts";
export const SUBAGENT_PROVIDER_REGISTRY_AGENT_NAME = "e2e-provider-registry-reviewer";
export const TOOL_ERROR_SURFACE_STALE_AGENT_NAME = "e2e-stale-error-reviewer";
export const TOOL_ERROR_SURFACE_HEALTHY_AGENT_NAME = "e2e-healthy-error-reviewer";

export const requestedE2ESpecs = readRequestedE2ESpecs();
export const requestedE2EExcludeSpecs = readRequestedE2EExcludeSpecs();
export const configuredModelRetryMaxRetries = process.env.ZCODE_MODEL_RETRY_MAX_RETRIES;
export const configuredE2EWorkerNetworkEnv = {
  httpProxy: process.env.ZCODE_HTTP_PROXY,
  noProxy: process.env.ZCODE_NO_PROXY,
};
export const upstreamProviderSpecRequested = process.argv
  .concat(requestedE2ESpecs)
  .some((arg) => arg.includes("upstream-provider.test.ts"));
export const turnSteerProbeSpecRequested = process.argv
  .concat(requestedE2ESpecs)
  .some((arg) => arg.includes("conversation-session-turn-steer-probe.test.ts"));
const manualReviewSpecRequested = process.argv
  .concat(requestedE2ESpecs)
  .some((arg) => arg.replaceAll("\\", "/").includes("/manual-review/"));
export const manualReviewE2E =
  process.env.ZCODE_E2E_MANUAL_REVIEW?.trim() === "1" || manualReviewSpecRequested;
if (manualReviewE2E) {
  process.env.ZCODE_E2E_MANUAL_REVIEW = "1";
}
export const manualReviewHoldMs = readPositiveIntegerEnv("ZCODE_E2E_MANUAL_REVIEW_HOLD_MS") ?? 0;
export const REQUESTED_UPSTREAM_HTTP_MODE_ENV = "ZCODE_E2E_REQUESTED_UPSTREAM_HTTP_MODE";
export const requestedUpstreamE2EHttpMode =
  process.env[REQUESTED_UPSTREAM_HTTP_MODE_ENV] !== undefined
    ? process.env[REQUESTED_UPSTREAM_HTTP_MODE_ENV]?.trim() || undefined
    : process.env.E2E_PROVIDER_HTTP_MODE?.trim() || undefined;
export const requestedAskUserQuestionClockScale =
  process.env[ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV]?.trim() || undefined;
export const containerE2E = process.env.ZCODE_E2E_CONTAINER === "1";
export const configuredE2ESpecs =
  requestedE2ESpecs.length > 0
    ? requestedE2ESpecs
    : manualReviewE2E
      ? [MANUAL_REVIEW_SPEC_GLOB]
      : upstreamProviderSpecRequested
        ? [UPSTREAM_PROVIDER_SPEC]
        : ["./test/e2e/**/*.test.ts"];
export const pluginNoGitGitHubArchiveE2E = configuredE2ESpecs.some((spec) =>
  spec.includes(PLUGIN_NO_GIT_GITHUB_ARCHIVE_SPEC),
);
export const workspacePluginRemoteExplicitSyncE2E = configuredE2ESpecs.some((spec) =>
  spec.includes("conversation-session-plugin-remote-explicit-sync-workspace.test.ts"),
);

function readRequestedE2ESpecs() {
  const specs = new Set<string>();
  appendRequestedE2ESpecs(specs, process.env.ZCODE_E2E_SPEC);

  for (let index = 0; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (!arg) {
      continue;
    }
    if (arg === "--spec") {
      appendRequestedE2ESpecs(specs, process.argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--spec=")) {
      appendRequestedE2ESpecs(specs, arg.slice("--spec=".length));
    }
  }

  return [...specs];
}

function readRequestedE2EExcludeSpecs() {
  const specs = new Set<string>();
  appendRequestedE2ESpecs(specs, process.env.ZCODE_E2E_EXCLUDE_SPEC);

  for (let index = 0; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (!arg) {
      continue;
    }
    if (arg === "--exclude") {
      appendRequestedE2ESpecs(specs, process.argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--exclude=")) {
      appendRequestedE2ESpecs(specs, arg.slice("--exclude=".length));
    }
  }

  return [...specs];
}

function appendRequestedE2ESpecs(specs: Set<string>, value?: string) {
  if (!value?.trim()) {
    return;
  }

  // 修复原因：`pnpm test:e2e -- --spec <file>` 下 WDIO 仍会先加载配置；
  // 如果配置只读 ZCODE_E2E_SPEC，实际会回落到全量 spec，多个 worker 轮流重置
  // .e2e-home 后就会把 上游 flash 选择冲掉。
  for (const spec of value.split(",")) {
    const trimmed = spec.trim();
    if (trimmed) {
      specs.add(trimmed);
    }
  }
}
