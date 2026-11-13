import { loadBrowserDocumentation } from "../documentation.js";
import {
  BrowserApiPolicy,
  createBrowserApiProxy,
  loadBrowserApiManifest,
  type BrowserApiManifest,
} from "../manifest.js";
import { BrowserCommandError } from "../result.js";
import { selectBrowserForUrl, selectDefaultBrowser } from "../selection.js";
import { Browser } from "./browser.js";
import { Tab } from "./tab.js";
import type {
  BrowserAvailabilityGuard,
  BrowserClientTransport,
  BrowserDescriptor,
  BrowserInfo,
} from "./types.js";

export class BrowsersFacade {
  private readonly assertAvailable: BrowserAvailabilityGuard;
  private readonly transport: BrowserClientTransport;
  private readonly readDocumentation: (name?: string, descriptor?: BrowserInfo) => string;
  private readonly manifest: BrowserApiManifest;
  private readonly browsers = new Map<string, { raw: Browser; runtime: Browser }>();
  private readonly runtimeObject: BrowsersFacade;

  constructor(
    transport: BrowserClientTransport,
    options: {
      documentationRoot?: string;
      assertAvailable?: BrowserAvailabilityGuard;
    } = {},
  ) {
    const assertAvailable = options.assertAvailable ?? (() => undefined);
    this.assertAvailable = assertAvailable;
    // Browser 对象是持久引用，内核 reset 后旧绑定必须失效。guard 必须包住持久对象的每次
    // transport/doc 调用，不能只在初始化时判断。
    this.transport = {
      list: async () => {
        assertAvailable();
        return await transport.list();
      },
      execute: async (browserId, browserGeneration, command) => {
        assertAvailable();
        return await transport.execute(browserId, browserGeneration, command);
      },
    };
    this.manifest = loadBrowserApiManifest(options.documentationRoot);
    this.readDocumentation = (name, descriptor) => {
      assertAvailable();
      return loadBrowserDocumentation(options.documentationRoot, name, descriptor);
    };
    const topLevelPolicy = new BrowserApiPolicy(this.manifest, {
      id: "browser-client",
      generation: 0,
      type: "iab",
      name: "Browser client",
      capabilities: {},
    });
    this.runtimeObject = createBrowserApiProxy(this, "Browsers", topLevelPolicy, {
      hideUnknown: true,
    });
  }

  asRuntimeObject(): BrowsersFacade {
    return this.runtimeObject;
  }

  private async listAvailable(): Promise<BrowserInfo[]> {
    return await this.transport.list();
  }

  async list(): Promise<BrowserDescriptor[]> {
    return (await this.listAvailable()).map(
      ({ generation: _generation, ...descriptor }) => descriptor,
    );
  }

  async get(idOrType: string): Promise<Browser> {
    const infos = await this.listAvailable();
    const info =
      infos.find((candidate) => candidate.id === idOrType) ??
      infos.find((candidate) => candidate.type === idOrType);
    if (!info) {
      const available = infos.map((candidate) => `${candidate.type}:${candidate.id}`).join(", ");
      throw new BrowserCommandError(
        { method: "list" },
        {
          ok: false,
          elapsedMs: 0,
          error: {
            code: "backend_unavailable",
            message: `Browser backend '${idOrType}' is unavailable${available ? `; available: ${available}` : ""}`,
          },
        },
        "backend_unavailable",
      );
    }
    return this.browserFor(info);
  }

  async getDefault(): Promise<Browser> {
    const info = selectDefaultBrowser(await this.listAvailable());
    if (!info) {
      return this.get("__no_browser_backend__");
    }
    return this.browserFor(info);
  }

  async getForUrl(url: string): Promise<Browser> {
    const infos = await this.listAvailable();
    if (infos.length === 0) {
      return this.get("__no_browser_backend__");
    }
    if (infos.length === 1) {
      return this.browserFor(infos[0]);
    }

    const tabsByBrowserId = new Map<string, readonly string[]>();
    await Promise.all(
      infos.map(async (info) => {
        try {
          const tabs = await this.browserFor(info).tabs.list();
          tabsByBrowserId.set(
            info.id,
            tabs.flatMap((tab) => (tab.url ? [tab.url] : [])),
          );
        } catch {
          tabsByBrowserId.set(info.id, []);
        }
      }),
    );
    return this.browserFor(selectBrowserForUrl(infos, url, tabsByBrowserId));
  }

  async open(url?: string, options: { reuseTab?: boolean } = {}): Promise<Tab> {
    const browser = await this.getDefault();
    if (url && options.reuseTab !== false) {
      // 已知问题：模型每次 open() 都新开 tab，任务结束后内置浏览器堆满标签页。
      // 默认按 URL 复用已有 agent-owned tab（tabs.list 只含本 scope 的 owned tabs，
      // 不会误接管用户 tab）：激活给用户并在原地 goto 刷新；复用链路任何失败都
      // 降级 newTab。需要并排独立 tab 时模型可显式传 reuseTab: false。
      const reusable = await browser.tabs.reuse(url).catch(() => undefined);
      if (reusable) {
        await reusable.goto(url);
        return reusable;
      }
    }
    const tab = await browser.tabs.new();
    if (url) {
      await tab.goto(url);
    }
    return tab;
  }

  async current(): Promise<Tab> {
    const browser = await this.getDefault();
    return (await browser.tabs.selected()) ?? browser.tabs.new();
  }

  async listTabs(): Promise<Tab[]> {
    const browser = await this.getDefault();
    // 兼容 listTabs 只枚举 binding，不能逐个调用 tabs.get()；get 现在有显式激活语义，
    // 批量 get 会依次抢占 active tab，且并发执行时最终选中项不确定。
    return (await browser.tabs.list()).map((tab) => browser.createTab(tab.id));
  }

  tab(tabId: string): Tab {
    // 兼容入口仍需冻结创建时选中的 browser；不能在每条命令时重跑 default，
    // 否则 backend 上下线后同一个 tabId 可能被错误发送到另一连接。
    const browser = this.getDefault();
    return new Tab(async (command) => (await browser).executeCommand(command), tabId);
  }

  documentation(name?: string): string {
    return this.readDocumentation(name);
  }

  private browserFor(info: BrowserInfo): Browser {
    const existing = this.browsers.get(info.id);
    if (existing && existing.raw.generation === info.generation) {
      existing.raw.updateInfo(info);
      return existing.runtime;
    }
    const raw = new Browser(
      info,
      this.transport.execute,
      this.readDocumentation,
      this.manifest,
      this.assertAvailable,
    );
    const runtime = raw.asRuntimeObject();
    this.browsers.set(info.id, { raw, runtime });
    return runtime;
  }
}
