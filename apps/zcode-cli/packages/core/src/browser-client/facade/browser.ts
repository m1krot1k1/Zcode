import type {
  BrowserBackendType,
  BrowserCommand,
  BrowserCommandResult,
} from "@zcode/contracts/browser-control";
import { BrowserApiPolicy, createBrowserApiProxy, type BrowserApiManifest } from "../manifest.js";
import { expectOk } from "../result.js";
import { BrowserCapabilityCollection } from "./capabilities.js";
import { Tab } from "./tab.js";
import { BrowserTabs } from "./tabs.js";
import { BrowserUser } from "./user.js";
import type {
  BrowserAvailabilityGuard,
  BrowserExecuteFn,
  BrowserInfo,
  BrowserTransportExecuteFn,
} from "./types.js";

export class Browser {
  readonly tabs: BrowserTabs;
  readonly user: BrowserUser;
  readonly capabilities: BrowserCapabilityCollection;
  private readonly defaultTab: Tab;
  private info: BrowserInfo;
  private readonly execute: BrowserExecuteFn;
  private readonly policy: BrowserApiPolicy;
  private readonly runtimeObject: Browser;

  constructor(
    info: BrowserInfo,
    execute: BrowserTransportExecuteFn,
    private readonly readDocumentation: (name?: string, descriptor?: BrowserInfo) => string,
    manifest: BrowserApiManifest,
    assertAvailable: BrowserAvailabilityGuard = () => undefined,
  ) {
    this.info = info;
    this.policy = new BrowserApiPolicy(manifest, info);
    this.execute = (command) => execute(this.info.id, this.info.generation, command);
    const capabilityDocumentation = (name?: string) => this.readDocumentation(name, this.info);
    const wrapTab = (tab: Tab) =>
      createBrowserApiProxy(tab.applyPlaywrightPolicy(this.policy), "Tab", this.policy);
    this.capabilities = new BrowserCapabilityCollection(
      () => this.info.capabilities.browser ?? [],
      capabilityDocumentation,
      this.execute,
      assertAvailable,
    );
    this.tabs = createBrowserApiProxy(
      new BrowserTabs(
        this.execute,
        wrapTab,
        this.info.capabilities.tab ?? [],
        capabilityDocumentation,
      ),
      "Tabs",
      this.policy,
    );
    this.user = createBrowserApiProxy(
      new BrowserUser(
        this.execute,
        wrapTab,
        this.info.capabilities.tab ?? [],
        capabilityDocumentation,
      ),
      "BrowserUser",
      this.policy,
    );
    this.defaultTab = wrapTab(
      new Tab(
        this.execute,
        undefined,
        undefined,
        this.info.capabilities.tab ?? [],
        capabilityDocumentation,
      ),
    );
    this.runtimeObject = createBrowserApiProxy(this, "Browser", this.policy);
  }

  get browserId(): string {
    return this.info.id;
  }

  get type(): BrowserBackendType {
    return this.info.type;
  }

  get generation(): number {
    return this.info.generation;
  }

  /** @deprecated 迁移兼容；新代码使用 browserId。 */
  get id(): string {
    return this.browserId;
  }

  /** @deprecated 迁移兼容；新代码使用 descriptor.type。 */
  get backend(): BrowserBackendType {
    return this.type;
  }

  get default(): Tab {
    return this.defaultTab;
  }

  async documentation(): Promise<string> {
    return this.readDocumentation(undefined, this.info);
  }

  async nameSession(name: string): Promise<void> {
    if (!name.trim()) throw new Error("browser.nameSession requires a non-empty name");
    const command: BrowserCommand = { method: "nameSession", name };
    expectOk(command, await this.execute(command));
  }

  /** registry refresh 后保留对象 identity，同时更新 capability/metadata。 */
  updateInfo(info: BrowserInfo): void {
    this.info = info;
    this.policy.updateDescriptor(info);
  }

  executeCommand(command: BrowserCommand): Promise<BrowserCommandResult> {
    return this.execute(command);
  }

  createTab(tabId: string): Tab {
    return createBrowserApiProxy(
      new Tab(this.execute, tabId, undefined, this.info.capabilities.tab ?? [], (name) =>
        this.readDocumentation(name, this.info),
      ),
      "Tab",
      this.policy,
    );
  }

  asRuntimeObject(): Browser {
    return this.runtimeObject;
  }
}
