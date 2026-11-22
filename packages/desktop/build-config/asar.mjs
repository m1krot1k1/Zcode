import { resolve } from "node:path";
import { runCommand, runCommandAndReadStdout } from "../../../scripts/spawn-command.mjs";

const commandStdoutMaxBuffer = 64 * 1024 * 1024;

export function resolveAppAsarPath(context) {
  if (context.electronPlatformName === "darwin") {
    const appName = `${context.packager?.appInfo?.productFilename ?? "ZCode"}.app`;
    return resolve(context.appOutDir, appName, "Contents", "Resources", "app.asar");
  }

  return resolve(context.appOutDir, "resources", "app.asar");
}

export function resolvePackagedResourcesDir(context) {
  if (context.electronPlatformName === "darwin") {
    const appName = `${context.packager?.appInfo?.productFilename ?? "ZCode"}.app`;
    return resolve(context.appOutDir, appName, "Contents", "Resources");
  }

  return resolve(context.appOutDir, "resources");
}

export function createAsarTools({ asarCliPath, workingDirectory }) {
  function runAsarCommand(args) {
    runCommand(process.execPath, [asarCliPath, ...args], {
      cwd: workingDirectory,
      env: process.env,
    });
  }

  function runAsarCommandAndReadStdout(args) {
    return runCommandAndReadStdout(process.execPath, [asarCliPath, ...args], {
      cwd: workingDirectory,
      env: process.env,
      // app.asar 在当前桌面包体积较大，asar list 输出可能超过默认缓冲并触发 ENOBUFS。
      // 这里显式放大缓冲，避免“为了判断是否需要注入”反而把打包流程误判失败。
      maxBuffer: commandStdoutMaxBuffer,
      stdio: ["ignore", "pipe", "inherit"],
    });
  }

  return { runAsarCommand, runAsarCommandAndReadStdout };
}
