import type { BrowserCommand, BrowserTabSummary } from "@zcode/contracts/browser-control";
import { selectTabForUrl } from "../selection.js";
import { BrowserCommandError, expectOk, expectPayload } from "../result.js";
import { Tab } from "./tab.js";
import type { BrowserCapabilityInfo, BrowserExecuteFn, BrowserTabInfo } from "./types.js";

export class BrowserTabs {
  constructor(
    private readonly execute: BrowserExecuteFn,
    private readonly wrapTab: (tab: Tab) => Tab = (tab) => tab,
    private readonly capabilities: readonly BrowserCapabilityInfo[] = [],
    private readonly readCapabilityDocumentation: (name?: string) => string = () => "",
  ) {}

  private tab(summary: BrowserTabSummary): Tab {
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

  private async summaries(): Promise<BrowserTabSummary[]> {
    const command: BrowserCommand = { method: "list" };
    const result = await this.execute(command);
    expectOk(command, result);
    return result.tabs ?? [];
  }

  async list(): Promise<BrowserTabInfo[]> {
    return (await this.summaries()).map((summary) => ({
      id: summary.tabId,
      viewport: { ...summary.viewport },
      ...(summary.active ? { active: true } : {}),
      ...(summary.title ? { title: summary.title } : {}),
      ...(summary.url ? { url: summary.url } : {}),
    }));
  }

  async selected(): Promise<Tab | undefined> {
    const summaries = await this.summaries();
    const selected = summaries.find((summary) => summary.active === true) ?? summaries.at(-1);
    return selected ? this.tab(selected) : undefined;
  }

  async get(tabId: string): Promise<Tab> {
    const summary = (await this.summaries()).find((candidate) => candidate.tabId === tabId);
    if (!summary) {
      throw new BrowserCommandError(
        { method: "list" },
        {
          ok: false,
          elapsedMs: 0,
          error: { code: "backend_unavailable", message: `Browser tab '${tabId}' is unavailable` },
        },
        "backend_unavailable",
      );
    }
    const command: BrowserCommand = { method: "activateTab", tabId };
    const result = await this.execute(command);
    const activated = expectPayload(command, result, result.tab, "tab");
    return this.tab(activated);
  }

  async new(): Promise<Tab> {
    const command: BrowserCommand = { method: "newTab" };
    const result = await this.execute(command);
    const summary = expectPayload(command, result, result.tab, "tab");
    return this.tab(summary);
  }

  /**
   * open(url) 的复用入口：按 URL 匹配已有 agent-owned tab，命中则激活（activateTab，
   * 用户立即看到该 tab）并返回，未命中返回 undefined。list/activate 的失败向调用方抛出，
   * 由 open() 统一降级为 newTab，复用链路绝不阻断任务。
   */
  async reuse(url: string): Promise<Tab | undefined> {
    const summaries = await this.summaries();
    const matched = selectTabForUrl(url, summaries);
    if (!matched) return undefined;
    const command: BrowserCommand = { method: "activateTab", tabId: matched.tabId };
    const result = await this.execute(command);
    const activated = expectPayload(command, result, result.tab, "tab");
    return this.tab(activated);
  }

  async finalize(
    options: {
      keep?: Array<{
        tab: string | Tab | { id: string };
        status: "handoff" | "deliverable";
      }>;
    } = {},
  ): Promise<void> {
    const keep = (options.keep ?? []).map(({ tab, status }) => ({
      tabId: typeof tab === "string" ? tab : tab.id,
      status,
    }));
    const command: BrowserCommand = { method: "finalizeTabs", keep };
    expectOk(command, await this.execute(command));
  }
}
