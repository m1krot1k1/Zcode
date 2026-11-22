import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { workerSpecsContain } from "../helpers/e2e-worker-isolation.js";
import { BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID } from "@zcode/shared";
import { resolveCodingPlanUpgradeMockScenario } from "../helpers/coding-plan-upgrade-mock-server.js";
import { E2E_USER_PROFILE } from "./env.js";
import { E2E_HOME_DIR, execFileAsync } from "./paths.js";
import {
  CONTEXT_WINDOW_COLD_RESUME_SPEC,
  GIT_REVIEW_ENTRY_SPEC,
  JWT_EXPIRY_REAUTHENTICATION_SPEC,
  OAUTH_CREDENTIAL_RECOVERY_SPEC,
  PROVIDER_READINESS_AGENT_STARTUP_SPEC,
  SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_SPEC,
  TASK_INDEX_ROW_AUTHORITY_SPEC,
  WINDOWS_AGENT_METRIC_PROBE_ABSENCE_SPEC,
} from "./specs.js";

export function isOAuthCredentialRecoverySpec(specs: string[] = []) {
  return workerSpecsContain(specs, OAUTH_CREDENTIAL_RECOVERY_SPEC);
}

export function isJwtExpiryReauthenticationSpec(specs: string[] = []) {
  return workerSpecsContain(specs, JWT_EXPIRY_REAUTHENTICATION_SPEC);
}

export function isSubagentCodingPlanLoginCatalogStaleSpec(specs: string[] = []) {
  return workerSpecsContain(specs, SUBAGENT_CODING_PLAN_LOGIN_CATALOG_STALE_SPEC);
}

export function usesProviderReadinessColdStartFixture(specs: string[] = []) {
  return (
    workerSpecsContain(specs, PROVIDER_READINESS_AGENT_STARTUP_SPEC) ||
    workerSpecsContain(specs, WINDOWS_AGENT_METRIC_PROBE_ABSENCE_SPEC)
  );
}

export function usesContextWindowColdResumeFixture(specs: string[] = []) {
  return workerSpecsContain(specs, CONTEXT_WINDOW_COLD_RESUME_SPEC);
}

export function usesTaskIndexRowAuthorityFixture(specs: string[] = []) {
  return workerSpecsContain(specs, TASK_INDEX_ROW_AUTHORITY_SPEC);
}

export function usesGitReviewEntryFixture(specs: string[] = []) {
  return workerSpecsContain(specs, GIT_REVIEW_ENTRY_SPEC);
}

export async function seedE2EGitReviewEntryWorkspace(specs: string[] = []) {
  if (!usesGitReviewEntryFixture(specs)) return;

  const workspacePath = resolve(E2E_HOME_DIR, "ZCodeProject");
  const caseRoot = resolve(workspacePath, ".zcode-e2e/conversation-session-git-review-entry");
  await mkdir(caseRoot, { recursive: true });
  await runGitReviewEntryCommand(workspacePath, ["init"]);
  await runGitReviewEntryCommand(workspacePath, ["checkout", "-B", "main"]);
  await writeFile(
    resolve(caseRoot, "status-panel-review.txt"),
    "status panel Git review e2e fixture\n",
    "utf8",
  );
}

async function runGitReviewEntryCommand(cwd: string, args: string[]) {
  await execFileAsync(process.env.ZCODE_GIT_BINARY?.trim() || "git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
}

export function createCorruptOAuthCredentialSeed(authProviderId: string): Record<string, string> {
  const corruptEncryptedValue = "enc:v1:bad.bad.bad";
  const corruptTokenProvider = process.env.ZCODE_E2E_CORRUPT_OAUTH_TOKEN_PROVIDER;
  if (corruptTokenProvider === BIGMODEL_PROVIDER_ID || corruptTokenProvider === ZAI_PROVIDER_ID) {
    // 业务 token 损坏曾绕过启动恢复的解密清理；共享 JWT 与资料正常才能隔离此路径。
    return {
      "oauth:active_provider": corruptTokenProvider,
      [`oauth:${corruptTokenProvider}:access_token`]: corruptEncryptedValue,
      [`oauth:${corruptTokenProvider}:refresh_token`]: "stale-refresh-token",
      [`oauth:${corruptTokenProvider}:user_info`]: JSON.stringify(
        corruptTokenProvider === ZAI_PROVIDER_ID
          ? { user_id: "e2e-user", name: "Fixture User" }
          : { id: "e2e-user", username: "Fixture User", displayName: "Fixture User" },
      ),
      zcodejwttoken: "e2e-valid-opaque-jwt",
      "bot:e2e:credential": "e2e-independent-bot-token",
    };
  }
  return {
    // Bugfix: 这个 spec 需要冷启动复现线上“密文存在但当前机器无法解密”的状态；
    // 只损坏 active provider 就足以触发 OAuth 会话清理，并验证用户仍能看到登录入口。
    "oauth:active_provider": corruptEncryptedValue,
    [`oauth:${authProviderId}:access_token`]: "stale-access-token",
    [`oauth:${authProviderId}:refresh_token`]: "stale-refresh-token",
    [`oauth:${authProviderId}:user_info`]: JSON.stringify(E2E_USER_PROFILE),
    [`oauth:${BIGMODEL_PROVIDER_ID}:access_token`]: "stale-bigmodel-access-token",
    [`oauth:${BIGMODEL_PROVIDER_ID}:refresh_token`]: "stale-bigmodel-refresh-token",
    [`oauth:${BIGMODEL_PROVIDER_ID}:user_info`]: JSON.stringify(E2E_USER_PROFILE),
    zcodejwttoken: "stale-zcode-jwt-token",
    "bot:e2e:credential": "e2e-independent-bot-token",
  };
}

export function createExpiredJwtOAuthCredentialSeed(
  authProviderId: string,
): Record<string, string> {
  return {
    "oauth:active_provider": authProviderId,
    [`oauth:${authProviderId}:access_token`]: "expired-session-access-token",
    [`oauth:${authProviderId}:refresh_token`]: "expired-session-refresh-token",
    [`oauth:${authProviderId}:user_info`]: JSON.stringify(E2E_USER_PROFILE),
    // Bug 回归 fixture：exp=1 明确早于任意测试运行时间；客户端只解析 exp，
    // 不验证这枚本地测试 JWT 的签名。
    zcodejwttoken: "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJleHAiOjF9.e2e",
  };
}

export function isCodingPlanUpgradeE2E(specs: string[] = []) {
  return resolveCodingPlanUpgradeMockScenario(specs) !== null;
}

export function shouldSeedGuideInteractionBehavior(specs: string[] = []) {
  return specs.some(
    (arg) =>
      arg.includes("conversation-session-running-guide-steer.test.ts") ||
      arg.includes("conversation-session-background-guide-steer.test.ts"),
  );
}
