import { DESKTOP_DIR, E2E_ELECTRON_SERVICE_MODULE_PATH } from "./paths.js";

/**
 * Локальный Electron service: официальный launcher плюс строгий readiness и onReload
 * из repo-модуля (см. test/e2e/helpers/e2e-electron-service.ts).
 */
export function createServices(): WebdriverIO.Config["services"] {
  return [
    [
      // Bug 根因：旧 Electron service 会吞 ContextId 失败，且 reloadSession 不会重跑
      // service.before；本地 module 保留官方 launcher，同时补严格 readiness 与 onReload。
      E2E_ELECTRON_SERVICE_MODULE_PATH,
      {
        // Bugfix: rootDir 只用于让 wdio-electron-service 读取 desktop package.json；
        // Electron 可执行文件在 pnpm hoisted / isolated 布局下位置不同，不能再让
        // appEntryPoint 模式按 rootDir 硬拼 node_modules/.bin/electron。
        rootDir: DESKTOP_DIR,
      },
    ],
  ];
}
