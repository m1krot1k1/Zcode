import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { config as loadDotenv } from "dotenv";
import { resolveE2EWebDriverRequestLimits } from "../helpers/e2e-worker-isolation.js";
import {
  DEFAULT_E2E_ELECTRON_INSTALL_TIMEOUT_MS,
  resolveE2EElectronBinary,
} from "../helpers/e2e-electron-binary.js";

export const DESKTOP_DIR = resolve(import.meta.dirname, "../../..");
export const execFileAsync = promisify(execFile);
export const REPO_ROOT = resolve(DESKTOP_DIR, "../..");
export const E2E_ELECTRON_SERVICE_MODULE_PATH = resolve(
  DESKTOP_DIR,
  "test/e2e/helpers/e2e-electron-service.ts",
);
const E2E_LOCAL_ENV_FILES = [
  resolve(DESKTOP_DIR, ".env.e2e.local"),
  resolve(REPO_ROOT, ".env.e2e.local"),
  // 仓库不再提供共享 key：.env.e2e.local.example 只列变量名、值留空，不作为 fallback 读取。
];
// Bug 根因：Electron 二进制预检曾早于本地 E2E env 加载，缺包修复因此绕过镜像、
// 代理、证书和缓存配置。所有读取 process.env 的 runner 初始化都必须位于该调用之后。
loadE2ELocalEnv();
export const BUILD_DESKTOP_AGENT_SCRIPT = resolve(REPO_ROOT, "scripts/build-desktop-agent-cli.mjs");
export const ZCODE_CLI_ENTRYPOINT = resolve(
  REPO_ROOT,
  "apps/zcode-cli/packages/cli/dist/zcode.cjs",
);
export const E2E_HOME_DIR = resolve(
  process.env.ZCODE_E2E_HOME_DIR?.trim() ||
    // 修复原因：多个 WDIO 本地并发时会互相清理默认 .e2e-home，导致窗口白屏、
    // DevTools 断链或登录页等待失败；默认路径保持兼容，调试时允许显式隔离。
    resolve(DESKTOP_DIR, ".e2e-home"),
);
export const E2E_PACKAGED_APP_BINARY_PATH = process.env.ZCODE_E2E_PACKAGED_APP_PATH?.trim()
  ? resolve(process.env.ZCODE_E2E_PACKAGED_APP_PATH)
  : null;
// 目录隔离已回滚：所有 Desktop E2E 继续使用历史 ~/.zcode 布局。
export const E2E_STORAGE_ROOT = resolve(E2E_HOME_DIR, ".zcode");
export const E2E_APP_CONFIG_DIR = resolve(E2E_STORAGE_ROOT, "v2");
export const E2E_APP_SETTINGS_FILE = resolve(E2E_APP_CONFIG_DIR, "setting.json");
const OPENCODE_INSTALL_E2E_ENV_KEYS = [
  "ZCODE_E2E_OPENCODE_CLI_PATH",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
] as const;
let originalOpenCodeInstallE2EEnv: Map<
  (typeof OPENCODE_INSTALL_E2E_ENV_KEYS)[number],
  string | undefined
> | null = null;

export function isolateOpenCodeInstallE2EEnvironment() {
  originalOpenCodeInstallE2EEnv = new Map(
    OPENCODE_INSTALL_E2E_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  process.env.ZCODE_E2E_OPENCODE_CLI_PATH = resolve(E2E_HOME_DIR, ".opencode", "bin", "opencode");
  process.env.XDG_CONFIG_HOME = resolve(E2E_HOME_DIR, ".config");
  process.env.XDG_DATA_HOME = resolve(E2E_HOME_DIR, ".local", "share");
  process.env.XDG_CACHE_HOME = resolve(E2E_HOME_DIR, ".cache");
  process.env.XDG_STATE_HOME = resolve(E2E_HOME_DIR, ".local", "state");
}

export function restoreOpenCodeInstallE2EEnvironment() {
  if (!originalOpenCodeInstallE2EEnv) return;
  for (const [key, value] of originalOpenCodeInstallE2EEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalOpenCodeInstallE2EEnv = null;
}
export const E2E_APP_CREDENTIALS_FILE = resolve(E2E_APP_CONFIG_DIR, "credentials.json");
export const E2E_APP_PROVIDER_CONFIG_FILE = resolve(E2E_APP_CONFIG_DIR, "provider_config.json");
// staged Electron app 只有 main/host/renderer 产物，不携带仓库级 config/provider。
// 若让 Host 依据 app.getAppPath() 推导 bundled config，重启后会把不存在的路径当作
// bundled release，模型配置初始化直接失败。E2E 明确注入同一份只读基线；off-peak
// spec 会在 startOffPeakE2EMock 中覆盖为带 mock endpoint 的 case-local 文件。
export const E2E_DEFAULT_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = resolve(
  REPO_ROOT,
  "config/provider/zcode-builtin.json",
);
export const INITIAL_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE =
  process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim();
export const E2E_OFFPEAK_ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = resolve(
  REPO_ROOT,
  ".cache/desktop-e2e-provider-config/official-offpeak-mock.json",
);
export const E2E_AGENTS_STATE_FILE = resolve(E2E_APP_CONFIG_DIR, "agents-state.json");
export const E2E_CLI_CONFIG_DIR = resolve(E2E_STORAGE_ROOT, "cli");
export const E2E_CLI_CONFIG_FILE = resolve(E2E_CLI_CONFIG_DIR, "config.json");
export const E2E_CLI_AGENTS_DIR = resolve(E2E_CLI_CONFIG_DIR, "agents");
export const E2E_USER_AGENTS_DIR = resolve(E2E_STORAGE_ROOT, "agents");
export const E2E_NETWORK_CAPTURE_DIR = resolve(
  process.env.ZCODE_E2E_NETWORK_CAPTURE_DIR?.trim() ||
    // 修复原因：beforeSession 会清空 .e2e-home；抓包代理的 CA 必须放在
    // reset 范围之外，否则 agent 读 httpProxyCaCertPath 时会遇到 ENOENT。
    resolve(DESKTOP_DIR, ".e2e-network-capture"),
);
const E2E_CERT_CACHE_ROOT =
  process.env.ZCODE_E2E_CERT_CACHE_DIR?.trim() || resolve(REPO_ROOT, ".cache");
export const E2E_NETWORK_CAPTURE_CA_DIR = resolve(
  E2E_CERT_CACHE_ROOT,
  "desktop-e2e-network-capture-ca",
);
export const E2E_CODING_PLAN_DATA_PLANE_CA_DIR = resolve(
  E2E_CERT_CACHE_ROOT,
  "desktop-e2e-coding-plan-data-plane-ca",
);
export const E2E_BROWSER_DRIVER_CACHE_DIR = resolve(REPO_ROOT, ".cache/wdio-browser-drivers");
export const DESKTOP_BUILD_OUTPUT_DIR = resolve(DESKTOP_DIR, "out");
export const DESKTOP_BUILD_ENTRY_POINT = resolve(DESKTOP_BUILD_OUTPUT_DIR, "main/index.js");
export const E2E_RENDERER_ASSETS_DIR = resolve(DESKTOP_DIR, "out/renderer/assets");
export const UPSTREAM_CAPTURE_ARTIFACT_PATH = resolve(
  E2E_NETWORK_CAPTURE_DIR,
  "upstream-provider.json",
);
export const CODING_PLAN_DATA_PLANE_ARTIFACT_PATH = resolve(
  E2E_NETWORK_CAPTURE_DIR,
  "coding-plan-data-plane.json",
);
export const E2E_PROVIDER_RUNTIME_FILE = resolve(E2E_NETWORK_CAPTURE_DIR, "upstream-runtime.json");
export const UPSTREAM_REPLAY_FIXTURE_ROOT = resolve(DESKTOP_DIR, "test/e2e/fixtures/upstream");
export const UPSTREAM_COMMON_REPLAY_FIXTURE_PATH = resolve(
  UPSTREAM_REPLAY_FIXTURE_ROOT,
  "common.json",
);
export const UPSTREAM_CONVERSATION_SESSION_REPLAY_FIXTURE_DIR = resolve(
  UPSTREAM_REPLAY_FIXTURE_ROOT,
  "conversation-session",
);
export const UPSTREAM_CONVERSATION_SESSION_CASE_MANIFEST_DIR = resolve(
  DESKTOP_DIR,
  "test/e2e/fixtures/cases/conversation-session",
);
export const LEGACY_UPSTREAM_REPLAY_FIXTURE_PATHS = [
  resolve(UPSTREAM_REPLAY_FIXTURE_ROOT, "provider-conversation-tool-cross-product.json"),
  resolve(UPSTREAM_REPLAY_FIXTURE_ROOT, "provider-basic.json"),
];
export const UPSTREAM_CAPTURE_RESPONSE_PREVIEW_BYTES = 8 * 1024 * 1024;
export const UPSTREAM_CAPTURE_RESPONSE_CHUNK_TIMELINE_BYTES = 16 * 1024 * 1024;
const E2E_ELECTRON_INSTALL_TIMEOUT_MS =
  readPositiveIntegerEnv("ZCODE_E2E_ELECTRON_INSTALL_TIMEOUT_MS") ??
  DEFAULT_E2E_ELECTRON_INSTALL_TIMEOUT_MS;
export const ELECTRON_APP_BINARY_PATH =
  E2E_PACKAGED_APP_BINARY_PATH ??
  resolveE2EElectronBinary({
    desktopDir: DESKTOP_DIR,
    environment: process.env,
    installTimeoutMs: E2E_ELECTRON_INSTALL_TIMEOUT_MS,
    repoRoot: REPO_ROOT,
  });
const DESKTOP_PACKAGE_JSON = JSON.parse(
  readFileSync(resolve(DESKTOP_DIR, "package.json"), "utf-8"),
) as { devDependencies?: Record<string, string> };
export const ELECTRON_VERSION = DESKTOP_PACKAGE_JSON.devDependencies?.electron ?? "";
export const PNPM_COMMAND = "pnpm";
export const E2E_ELECTRON_APP_QUIT_TIMEOUT_MS =
  readPositiveIntegerEnv("ZCODE_E2E_ELECTRON_APP_QUIT_TIMEOUT_MS") ?? 1000;
export const E2E_ELECTRON_FORCE_KILL_GRACE_MS =
  readPositiveIntegerEnv("ZCODE_E2E_ELECTRON_FORCE_KILL_GRACE_MS") ?? 3000;
export const E2E_RENDERER_BRIDGE_PREFLIGHT_TIMEOUT_MS =
  readPositiveIntegerEnv("ZCODE_E2E_RENDERER_BRIDGE_PREFLIGHT_TIMEOUT_MS") ?? 15000;
export const E2E_RUNNER_FORCE_EXIT_TIMEOUT_MS =
  readPositiveIntegerEnv("ZCODE_E2E_RUNNER_FORCE_EXIT_TIMEOUT_MS") ?? 5000;
export const E2E_RUNNER_FINALIZATION_GUARD_TIMEOUT_MS =
  readPositiveIntegerEnv("ZCODE_E2E_RUNNER_FINALIZATION_GUARD_TIMEOUT_MS") ?? 30000;
export const E2E_FAILURE_ARTIFACT_COLLECTION_TIMEOUT_MS = Math.min(
  readPositiveIntegerEnv("ZCODE_E2E_FAILURE_ARTIFACT_COLLECTION_TIMEOUT_MS") ?? 60_000,
  5 * 60_000,
);
export const E2E_WEBDRIVER_REQUEST_LIMITS = resolveE2EWebDriverRequestLimits({
  retryCount: process.env.ZCODE_E2E_WEBDRIVER_REQUEST_RETRY_COUNT,
  timeoutMs: process.env.ZCODE_E2E_WEBDRIVER_REQUEST_TIMEOUT_MS,
});
export const E2E_HOME_REMOVE_RETRY_DELAYS_MS = [200, 500, 1000, 2000, 3000, 5000, 8000];
export const HOST_HOME_DIR = process.env.HOME?.trim();
export const HOST_USERPROFILE_DIR = process.env.USERPROFILE?.trim();

function loadE2ELocalEnv() {
  for (const envFile of E2E_LOCAL_ENV_FILES) {
    if (!existsSync(envFile)) {
      continue;
    }

    const parsedEnv: Record<string, string> = {};
    const result = loadDotenv({
      path: envFile,
      processEnv: parsedEnv,
      quiet: true,
    });
    if (result.error) {
      throw new Error(`Failed to load e2e env file: ${envFile}`, {
        cause: result.error,
      });
    }
    for (const [key, value] of Object.entries(parsedEnv)) {
      if (!process.env[key]?.trim()) {
        process.env[key] = value;
      }
    }
  }
}

export function readPositiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`);
  }
  return Math.floor(parsed);
}
