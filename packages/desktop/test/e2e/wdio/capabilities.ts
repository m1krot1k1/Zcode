import { buildE2ERunIdArg, createWindowsE2EHomeMarkerArg } from "../helpers/e2e-process-cleanup.js";
import {
  E2E_BROWSER_DRIVER_CACHE_DIR,
  E2E_HOME_DIR,
  E2E_PACKAGED_APP_BINARY_PATH,
  ELECTRON_APP_BINARY_PATH,
  ELECTRON_VERSION,
} from "./paths.js";
import { E2E_APP_ENTRY_POINT, E2E_RUN_ID } from "./reporters.js";
import { containerE2E } from "./specs.js";

const containerChromeArgs = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--ozone-platform=x11",
  "--window-size=1440,1000",
];

export function createCapabilities(): WebdriverIO.Config["capabilities"] {
  return [
    {
      browserName: "electron",
      browserVersion: ELECTRON_VERSION,
      "wdio:electronServiceOptions": {
        appArgs: [
          ...(E2E_PACKAGED_APP_BINARY_PATH ? [] : [`--app=${E2E_APP_ENTRY_POINT}`]),
          "--no-sandbox",
          // 修复原因：环境变量不会出现在进程命令行；同时传 runId 与 HOME identity，
          // 让跨平台清理优先命中当前 run，并为 Windows shard 保留路径级兜底。
          buildE2ERunIdArg(E2E_RUN_ID),
          createWindowsE2EHomeMarkerArg(E2E_HOME_DIR),
        ],
        appBinaryPath: ELECTRON_APP_BINARY_PATH,
      },
      "goog:chromeOptions": {
        // 修复原因：Electron 的 `--app=<main>` 会永久保留一个
        // chrome-error://chromewebdata/ app target。把 app 暴露给 ChromeDriver 后，
        // 长批次 session 启停期间 current handle 可能重新落到错误壳；这里只允许
        // BrowserWindow 对应的 page target，让 session 未就绪时失败而不是绑错窗口。
        windowTypes: ["page"],
        args: [...(containerE2E ? containerChromeArgs : [])],
      },
      "wdio:chromedriverOptions": {
        // 修复原因：固定 repo 内 cache，避免把 chromedriver 半解压到系统临时目录，导致本地 macOS E2E 找不到可执行文件。
        cacheDir: E2E_BROWSER_DRIVER_CACHE_DIR,
      },
    },
  ];
}
