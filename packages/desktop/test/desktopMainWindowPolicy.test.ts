import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => {
  const browserWindowInstance = {
    isFullScreen: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    isDestroyed: vi.fn(() => false),
    maximize: vi.fn(),
    on: vi.fn(),
    setWindowButtonPosition: vi.fn(),
    setTitleBarOverlay: vi.fn(),
    webContents: {
      id: 17,
      getZoomFactor: vi.fn(() => 1),
      invalidate: vi.fn(),
      isDestroyed: vi.fn(() => false),
      on: vi.fn(),
      once: vi.fn(),
      send: vi.fn(),
      setZoomFactor: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    },
  };

  return {
    app: {
      dock: undefined,
      isPackaged: false,
    },
    browserWindowConstructor: vi.fn(),
    browserWindowInstance,
    loadWindow: vi.fn(),
    shellOpenExternal: vi.fn(() => Promise.resolve()),
  };
});

vi.mock("electron", () => ({
  app: electronMocks.app,
  BrowserWindow: class {
    constructor(options: unknown) {
      electronMocks.browserWindowConstructor(options);
      return electronMocks.browserWindowInstance;
    }
  },
  Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
  nativeImage: { createFromPath: vi.fn(() => ({ isEmpty: () => true })) },
  nativeTheme: {
    get shouldUseDarkColors() {
      return true;
    },
  },
  shell: { openExternal: electronMocks.shellOpenExternal },
  screen: {
    getPrimaryDisplay: vi.fn(() => ({ workAreaSize: { width: 1920, height: 1040 } })),
  },
}));

vi.mock("../src/main/desktopHostProcess.js", () => ({
  loadWindow: electronMocks.loadWindow,
}));

// 用平台真实路径构造 file URL：Windows 上是 C:\…，POSIX 上是 /…，避免测试只在单一平台成立。
const RENDERER_DIR = join(import.meta.dirname, "..", "out", "renderer");
const RENDERER_INDEX_URL = pathToFileURL(join(RENDERER_DIR, "index.html")).href;
const OUTSIDE_RENDERER_URL = pathToFileURL(
  join(import.meta.dirname, "..", "out", "main", "index.js"),
).href;
const RENDERER_TRAVERSAL_URL = `${RENDERER_INDEX_URL}/../../main/index.js`;
const DEMO_FILE_URL = pathToFileURL(join(import.meta.dirname, "demo.html")).href;
// guard 内部用 import.meta.dirname 推导 ../renderer；production 构建里该目录对应 out/renderer。
// 测试验证的是「同一相对目录内的 file 文档可放行」，因此用 src/renderer 的真实路径。
const SOURCE_RENDERER_INDEX_URL = pathToFileURL(
  join(import.meta.dirname, "..", "src", "renderer", "index.html"),
).href;

type PolicyModule = typeof import("../src/main/desktopWindowChrome.js");

function decideProduction(
  module: PolicyModule,
  url: string,
): ReturnType<PolicyModule["resolveMainWindowNavigationDecision"]> {
  return module.resolveMainWindowNavigationDecision({
    url,
    isPackaged: true,
    rendererDir: RENDERER_DIR,
  });
}

function decideDevelopment(
  module: PolicyModule,
  url: string,
  devServerOrigin = "http://localhost:5174",
): ReturnType<PolicyModule["resolveMainWindowNavigationDecision"]> {
  return module.resolveMainWindowNavigationDecision({
    url,
    isPackaged: false,
    rendererDir: RENDERER_DIR,
    devServerOrigin,
  });
}

let policyModulePromise: Promise<PolicyModule> | undefined;

function loadPolicyModule(): Promise<PolicyModule> {
  // 模块级只加载一次：与 Electron mock 共享同一实例，避免重复求值 createBrowserWindow 依赖图。
  policyModulePromise ??= import("../src/main/desktopWindowChrome.js");
  return policyModulePromise;
}

afterEach(() => {
  electronMocks.browserWindowInstance.webContents.on.mockClear();
  electronMocks.browserWindowInstance.webContents.setWindowOpenHandler.mockClear();
  electronMocks.shellOpenExternal.mockClear();
  electronMocks.app.isPackaged = false;
  vi.unstubAllEnvs();
});

describe("main window navigation policy", () => {
  it("allows the packaged renderer document inside the renderer directory", async () => {
    const module = await loadPolicyModule();
    expect(decideProduction(module, RENDERER_INDEX_URL)).toEqual({ action: "allow" });
    expect(
      decideProduction(module, `${RENDERER_INDEX_URL}?restoreSession=true&windowKind=main`),
    ).toEqual({ action: "allow" });
  });

  it("denies file documents outside the renderer directory", async () => {
    const module = await loadPolicyModule();
    // 主窗口文档拥有 preload 暴露的全部 native API；任意本地 HTML 不能复用该容器。
    expect(decideProduction(module, OUTSIDE_RENDERER_URL)).toEqual({
      action: "deny",
      openExternal: false,
    });
    expect(decideProduction(module, RENDERER_TRAVERSAL_URL)).toEqual({
      action: "deny",
      openExternal: false,
    });
    // file:// 的 host 不是 localhost 时不能被当作应用文档。
    expect(decideProduction(module, "file://evil.example/etc/passwd")).toEqual({
      action: "deny",
      openExternal: false,
    });
  });

  it("denies external http(s) navigation but marks it for the system browser", async () => {
    const module = await loadPolicyModule();
    expect(decideProduction(module, "https://example.com/docs")).toEqual({
      action: "deny",
      openExternal: true,
    });
    expect(decideProduction(module, "http://example.com/")).toEqual({
      action: "deny",
      openExternal: true,
    });
  });

  it("denies unknown and script-capable schemes without launching an OS handler", async () => {
    const module = await loadPolicyModule();
    expect(decideProduction(module, "javascript:alert(1)")).toEqual({
      action: "deny",
      openExternal: false,
    });
    expect(decideProduction(module, "data:text/html,<script>alert(1)</script>")).toEqual({
      action: "deny",
      openExternal: false,
    });
    expect(decideProduction(module, "zcode://some-deep-link")).toEqual({
      action: "deny",
      openExternal: false,
    });
    expect(decideProduction(module, "not a url")).toEqual({ action: "deny", openExternal: false });
  });

  it("allows only the configured dev server origin in development", async () => {
    const module = await loadPolicyModule();
    expect(
      decideDevelopment(module, "http://localhost:5174/index.html?restoreSession=true"),
    ).toEqual({ action: "allow" });
    expect(decideDevelopment(module, "http://127.0.0.1:5174/", "http://127.0.0.1:5174")).toEqual({
      action: "allow",
    });
    // 不同端口/主机不是同一 dev origin：不能被当作同源 HMR。
    expect(decideDevelopment(module, "http://localhost:5175/")).toEqual({
      action: "deny",
      openExternal: true,
    });
    expect(decideDevelopment(module, "http://evil.example/")).toEqual({
      action: "deny",
      openExternal: true,
    });
  });

  it("falls back to packaged file policy when no dev server URL is configured", async () => {
    const module = await loadPolicyModule();
    expect(
      module.resolveMainWindowNavigationDecision({
        url: RENDERER_INDEX_URL,
        isPackaged: false,
        rendererDir: RENDERER_DIR,
      }),
    ).toEqual({ action: "allow" });
    expect(
      module.resolveMainWindowNavigationDecision({
        url: "https://example.com/",
        isPackaged: false,
        rendererDir: RENDERER_DIR,
      }),
    ).toEqual({ action: "deny", openExternal: true });
  });

  it("does not trust a dev origin with a different scheme or a subdomain lookalike", async () => {
    const module = await loadPolicyModule();
    // https vs http 是不同 origin；localhost.evil.example 不是 localhost 的子域。
    expect(decideDevelopment(module, "https://localhost:5174/")).toEqual({
      action: "deny",
      openExternal: true,
    });
    expect(decideDevelopment(module, "http://localhost.evil.example:5174/")).toEqual({
      action: "deny",
      openExternal: true,
    });
  });
});

describe("main window popup policy", () => {
  it("always denies window creation, even for trusted app URLs", async () => {
    const module = await loadPolicyModule();
    // 断言 deny 是唯一返回值：主窗口不能通过 window.open 派生第二个 Electron 窗口。
    expect(module.resolveMainWindowWindowOpenDecision({ url: RENDERER_INDEX_URL })).toEqual({
      action: "deny",
      openExternal: false,
    });
    expect(
      module.resolveMainWindowWindowOpenDecision({ url: "http://localhost:5174/index.html" }),
    ).toEqual({ action: "deny", openExternal: true });
  });

  it("opens only http(s) popups externally", async () => {
    const module = await loadPolicyModule();
    expect(module.resolveMainWindowWindowOpenDecision({ url: "https://example.com/docs" })).toEqual(
      { action: "deny", openExternal: true },
    );
    expect(module.resolveMainWindowWindowOpenDecision({ url: DEMO_FILE_URL })).toEqual({
      action: "deny",
      openExternal: false,
    });
    expect(module.resolveMainWindowWindowOpenDecision({ url: "javascript:alert(1)" })).toEqual({
      action: "deny",
      openExternal: false,
    });
    expect(
      module.resolveMainWindowWindowOpenDecision({ url: "mailto:security@example.com" }),
    ).toEqual({ action: "deny", openExternal: false });
  });
});

describe("main window guard registration", () => {
  async function createWindow(module: PolicyModule) {
    return module.createBrowserWindow({
      iconPath: "icon.png",
      preloadPath: "preload.js",
      logger: { warn: vi.fn() },
    });
  }

  function getWebContentsHandler(eventName: string) {
    return electronMocks.browserWindowInstance.webContents.on.mock.calls.find(
      ([event]) => event === eventName,
    )?.[1] as ((...args: unknown[]) => void) | undefined;
  }

  function getWindowOpenHandler() {
    return electronMocks.browserWindowInstance.webContents.setWindowOpenHandler.mock
      .calls[0]?.[0] as ((details: { url: string }) => unknown) | undefined;
  }

  it("registers will-navigate and setWindowOpenHandler on the main window", async () => {
    const module = await loadPolicyModule();
    await createWindow(module);
    expect(getWebContentsHandler("will-navigate")).toBeTypeOf("function");
    expect(
      electronMocks.browserWindowInstance.webContents.setWindowOpenHandler,
    ).toHaveBeenCalledOnce();
  });

  it("guards server redirects with the same navigation policy", async () => {
    const module = await loadPolicyModule();
    await createWindow(module);
    const redirect = getWebContentsHandler("will-redirect");
    expect(redirect).toBeTypeOf("function");

    const event = {
      url: "https://example.com/redirected",
      isMainFrame: true,
      preventDefault: vi.fn(),
    };
    redirect?.(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(electronMocks.shellOpenExternal).toHaveBeenCalledWith("https://example.com/redirected");
  });

  it("does not block sandboxed subframe redirects", async () => {
    // 子 frame 的重定向不属于主文档边界：拦截会破坏 cloud-content 等内嵌内容。
    const module = await loadPolicyModule();
    await createWindow(module);
    const redirect = getWebContentsHandler("will-redirect");

    const event = {
      url: "https://cdn.example.com/hero.html",
      isMainFrame: false,
      preventDefault: vi.fn(),
    };
    redirect?.(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(electronMocks.shellOpenExternal).not.toHaveBeenCalled();
  });

  it("blocks an external main-frame navigation and opens it in the system browser", async () => {
    const module = await loadPolicyModule();
    await createWindow(module);
    const navigate = getWebContentsHandler("will-navigate");
    expect(navigate).toBeTypeOf("function");

    const event = { url: "https://example.com/phishing", preventDefault: vi.fn() };
    navigate?.(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(electronMocks.shellOpenExternal).toHaveBeenCalledWith("https://example.com/phishing");
  });

  it("denies an unknown-scheme navigation without handing it to the OS", async () => {
    const module = await loadPolicyModule();
    await createWindow(module);
    const navigate = getWebContentsHandler("will-navigate");
    const event = { url: "zcode://unexpected-handler", preventDefault: vi.fn() };

    navigate?.(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(electronMocks.shellOpenExternal).not.toHaveBeenCalled();
  });

  it("allows an in-app renderer navigation without side effects", async () => {
    // 未打包且无 ELECTRON_RENDERER_URL 时 loadWindow 走 loadFile；
    // guard 必须按 renderer 目录放行，否则生产/无 dev server 的窗口会立刻被拦截。
    vi.stubEnv("ELECTRON_RENDERER_URL", "");
    const module = await loadPolicyModule();
    await createWindow(module);

    const navigate = getWebContentsHandler("will-navigate");
    const event = { url: SOURCE_RENDERER_INDEX_URL, preventDefault: vi.fn() };
    navigate?.(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(electronMocks.shellOpenExternal).not.toHaveBeenCalled();
  });

  it("denies popup creation and only opens http(s) URLs externally", async () => {
    const module = await loadPolicyModule();
    await createWindow(module);
    const handler = getWindowOpenHandler();
    expect(handler).toBeTypeOf("function");

    expect(handler?.({ url: "https://example.com/docs" })).toEqual({ action: "deny" });
    expect(electronMocks.shellOpenExternal).toHaveBeenCalledWith("https://example.com/docs");

    electronMocks.shellOpenExternal.mockClear();
    expect(handler?.({ url: DEMO_FILE_URL })).toEqual({ action: "deny" });
    expect(electronMocks.shellOpenExternal).not.toHaveBeenCalled();
  });
});

describe("main window CSP", () => {
  const html = readFileSync(join(import.meta.dirname, "../src/renderer/index.html"), "utf8");

  function readCsp(): string {
    const match = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u);
    expect(match?.[1]).toBeTypeOf("string");
    return match?.[1] ?? "";
  }

  it("declares a CSP meta tag in the renderer document", () => {
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(readCsp().length).toBeGreaterThan(0);
  });

  it("restricts scripts to the app bundle and limits the WASM exception", () => {
    const csp = readCsp();
    expect(csp).toContain("script-src 'self'");
    // 只允许 WASM 编译，不得放开任意 eval / new Function。
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it("blocks plugins, base rewriting and cross-origin form posts", () => {
    const csp = readCsp();
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self'");
  });

  it("has no wildcard source that would void the policy", () => {
    const csp = readCsp();
    // `*` 作为独立 source 会放开任意 origin / scheme；只允许出现在 dev HMR 的显式 loopback 列表里。
    expect(csp.split(";").map((directive) => directive.trim())).not.toContain("*");
    expect(csp).not.toMatch(/(?:^|[\s;])\*[\s;]?/u);
  });

  it("keeps the dev-only HMR WebSocket allowance explicit and loopback-scoped", () => {
    const csp = readCsp();
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("ws://localhost:5174");
    expect(csp).toContain("ws://127.0.0.1:5174");
    expect(csp).not.toContain("ws://*");
    expect(csp).not.toContain("wss://*");
  });

  it("allows local media previews and blob previews", () => {
    const csp = readCsp();
    expect(csp).toContain("media-src 'self' data: blob: zcode-media:");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("worker-src 'self' blob:");
  });
});
