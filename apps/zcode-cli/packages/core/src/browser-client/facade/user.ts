import type { BrowserCommand, BrowserUserTabInfo } from "@zcode/contracts/browser-control";
import { expectOk, expectPayload } from "../result.js";
import { Tab } from "./tab.js";
import type { BrowserCapabilityInfo, BrowserExecuteFn } from "./types.js";

interface BrowserHistoryOptions {
  from?: string | Date;
  limit?: number;
  queries?: string[];
  to?: string | Date;
}

interface BrowserHistoryEntry {
  dateVisited: string;
  title?: string;
  url: string;
}

export class BrowserUser {
  constructor(
    private readonly execute: BrowserExecuteFn,
    private readonly wrapTab: (tab: Tab) => Tab,
    private readonly capabilities: readonly BrowserCapabilityInfo[] = [],
    private readonly readCapabilityDocumentation: (name?: string) => string = () => "",
  ) {}

  async openTabs(): Promise<BrowserUserTabInfo[]> {
    const command: BrowserCommand = { method: "listUserTabs" };
    const result = expectOk(command, await this.execute(command));
    return result.userTabs ?? [];
  }

  async claimTab(tab: string | BrowserUserTabInfo): Promise<Tab> {
    const command: BrowserCommand = {
      method: "claimTab",
      tabId: typeof tab === "string" ? tab : tab.id,
    };
    const result = await this.execute(command);
    const summary = expectPayload(command, result, result.tab, "tab");
    return this.wrapTab(
      new Tab(
        this.execute,
        summary.tabId,
        summary,
        this.capabilities,
        this.readCapabilityDocumentation,
      ),
    );
  }

  async history(_options: BrowserHistoryOptions = {}): Promise<BrowserHistoryEntry[]> {
    // IAB 没有 Chromium History provider。该 member 会由 IAB manifest override 隐藏；保留方法
    // 只用于未来 extension backend 复用同一对象类型，避免当前 backend 伪造历史记录。
    throw new Error("Browser history is unavailable for the iab backend");
  }
}
