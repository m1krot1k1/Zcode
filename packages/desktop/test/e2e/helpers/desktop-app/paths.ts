import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PERSONAL_PROVIDER_CONFIG_FILE_NAME } from "@zcode/provider-node";

const DEFAULT_E2E_HOME_DIR = resolve(process.cwd(), ".e2e-home");
const E2E_HOME_DIR =
  process.env.ZCODE_E2E_HOME_DIR?.trim() ||
  process.env.ZCODE_DATA_BASE_DIR?.trim() ||
  process.env.ZCODE_DESKTOP_HOME_DIR?.trim() ||
  // 修复原因：WDIO worker 环境不稳定时，helper 曾回落到真实 HOME，
  // 导致 provider 诊断和清理读写开发者本机配置，而不是当前 e2e sandbox。
  DEFAULT_E2E_HOME_DIR;
// Bug 根因：storage profile 回滚删除了该共享根字段，但多个 E2E 仍需定位 CLI 数据。
// 隔离由测试 HOME 保证，目录名保持生产历史语义 .zcode。
const E2E_STORAGE_ROOT = join(E2E_HOME_DIR, ".zcode");
const E2E_APP_DATA_DIR = join(E2E_STORAGE_ROOT, "v2");
export const DEFAULT_WORKSPACE = join(E2E_HOME_DIR, "ZCodeProject");
export const DEFAULT_CONVERSATION_WORKSPACE = join(E2E_STORAGE_ROOT, "workspace", "default");
const SETTINGS_FILE = join(E2E_APP_DATA_DIR, "setting.json");
const CREDENTIALS_FILE = join(E2E_APP_DATA_DIR, "credentials.json");
const CONFIG_FILE = join(E2E_APP_DATA_DIR, PERSONAL_PROVIDER_CONFIG_FILE_NAME);
const CLI_CONFIG_FILE = join(E2E_STORAGE_ROOT, "cli", "config.json");
const AGENTS_STATE_FILE = join(E2E_APP_DATA_DIR, "agents-state.json");

/** 模块内共享的 E2E sandbox 路径；仅 desktop-app/ 子模块使用，不属于公开 API。 */
export const desktopAppPaths = {
  appDataDir: E2E_APP_DATA_DIR,
  agentsStateFile: AGENTS_STATE_FILE,
  cliConfigFile: CLI_CONFIG_FILE,
  configFile: CONFIG_FILE,
  credentialsFile: CREDENTIALS_FILE,
  homeDir: E2E_HOME_DIR,
  settingsFile: SETTINGS_FILE,
  storageRoot: E2E_STORAGE_ROOT,
} as const;

export async function ensureAppDataDir() {
  await mkdir(E2E_APP_DATA_DIR, { recursive: true });
}

export function getE2EAppDataPaths() {
  return {
    appDataDir: E2E_APP_DATA_DIR,
    configFile: CONFIG_FILE,
    credentialsFile: CREDENTIALS_FILE,
    homeDir: E2E_HOME_DIR,
    storageRoot: E2E_STORAGE_ROOT,
    workspace: DEFAULT_WORKSPACE,
  };
}
