import { app } from "electron";
import {
  applyAppVersionBootstrap,
  type DesktopAppVersionTarget,
} from "./desktopAppVersionBootstrap.js";

// 构建期由 tsup define 注入（见 packages/desktop/tsup.config.ts createSharedDefines），
// 值来自根 package.json 的 version；非构建环境（如 vitest）不存在，用 typeof 兜底。
declare const __ZCODE_VERSION__: string;

/**
 * Electron 41 的类型声明里没有 app.setVersion，但运行时存在（Electron 自己在缺少
 * app.asar 元数据时会提示 "No version found. Was app.setVersion() called?"）。
 * 这里只做结构化适配，避免把整个 app 断言成 any。
 */
function toVersionTarget(): DesktopAppVersionTarget {
  return {
    isPackaged: app.isPackaged,
    getVersion: () => app.getVersion(),
    setVersion: (version: string) => {
      (app as typeof app & { setVersion(version: string): void }).setVersion(version);
    },
  };
}

applyAppVersionBootstrap(toVersionTarget(), {
  envVersion: process.env["ZCODE_APP_VERSION"],
  buildVersion: typeof __ZCODE_VERSION__ !== "undefined" ? __ZCODE_VERSION__ : undefined,
});
