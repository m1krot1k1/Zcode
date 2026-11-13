import { homedir } from "node:os";
import { join } from "node:path";

import { getAppConfigDir } from "@zcode/services/node";

export function getZCodeDataDir() {
  return getAppConfigDir();
}

export function getZCodeCliDir() {
  return join(homedir(), ".zcode", "cli");
}

export function getZCodeCliLogDir() {
  return join(getZCodeCliDir(), "log");
}

/**
 * Computer Use Helper 的运行目录。macOS 上 Helper 由 LaunchServices 启动，stderr 被系统丢弃，
 * 所以它把生命周期与后台输入诊断 tee 到 `<socket>.exit.log`（见 zcode-cua
 * helperExitLogPathFor）。同目录下还有 `.tokens` broker 凭据，收集时必须按文件名白名单。
 */
export function getCuaHelperRunDir() {
  return join(homedir(), ".zcode", "computer-use", "run");
}

export function isCuaHelperDiagnosticFileName(fileName: string): boolean {
  return fileName.endsWith(".exit.log");
}
