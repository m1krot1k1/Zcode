// @vitest-environment jsdom
//
// 修复原因：根 vitest.config.ts 的 unit include 是 `packages/*/test/**/*.test.ts`，
// 不含 .tsx；本文件曾命名为 codeIndexPopover.test.tsx，导致根命令选择不到、报
// "No test files found"。这里改为 .test.ts 并用 createElement 构造元素，保持全部
// 断言不变，让官方根命令可以真实执行这些用例。

import { createElement } from "react";
import type { HTMLAttributes, ReactNode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeIndexStatus } from "../src/agent-workbench/contract.js";

const mocks = vi.hoisted(() => ({
  services: null as Record<string, unknown> | null,
  intl: {
    formatMessage: (
      descriptor: { id: string },
      values?: Record<string, string | number>,
    ): string => {
      const template = descriptor.id;
      if (!values) return template;
      return Object.entries(values).reduce(
        (text, [key, value]) => text.replace(`{${key}}`, String(value)),
        template,
      );
    },
  },
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => mocks.services,
}));

vi.mock("@/store/TabStoreProvider.js", () => ({
  useOptionalTabStore: (selector: (state: { openSettingsTab: () => void }) => unknown) =>
    selector({ openSettingsTab: vi.fn() }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: mocks.intl, locale: "en-US" }),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    onSettingsChanged: () => () => undefined,
    syncAppSettings: () => undefined,
  }),
}));

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({
    settings: { subagentMaxParallel: 0, subagentTaskTimeoutMinutes: 0 },
    loading: false,
    error: null,
    update: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("@/components/ui/popover.js", async () => {
  const React = await import("react");
  return {
    Popover: ({ children }: { children: ReactNode }) => React.createElement("div", null, children),
    PopoverTrigger: ({ children }: { children: ReactNode }) => children,
    PopoverContent: ({
      children,
      ...props
    }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) =>
      React.createElement("div", props, children),
  };
});

import { CodeIndexPopover } from "../src/agent-workbench/CodeIndexPopover.js";
import { AgentWorkbenchView } from "../src/agent-workbench/AgentWorkbenchView.js";

afterEach(() => {
  cleanup();
  mocks.services = null;
  vi.restoreAllMocks();
});

describe("CodeIndexPopover coverage messaging", () => {
  it("keeps skipped-file details calm and does not expose raw diagnostics", async () => {
    const diagnostic = "A source file matching secret patterns was excluded from the index.";
    const status = {
      state: "ready",
      partial: true,
      generation: 3,
      updatedAt: "2026-11-08T12:00:00.000Z",
      counts: { files: 4, chunks: 8, symbols: 12, edges: 5 },
      embedding: { configured: true, available: true, phase: "ready", model: "test/embed" },
      diagnostics: [diagnostic],
    } satisfies CodeIndexStatus;
    mocks.services = {
      codeIntelligenceService: {
        getStatus: vi.fn().mockResolvedValue(status),
        watchWorkspace: vi.fn(() => new Promise<void>(() => undefined)),
      },
    };

    render(createElement(CodeIndexPopover, { workspacePath: "/workspace" }));
    await waitFor(() => expect(screen.getByText("codeIndex.partial")).toBeTruthy());

    expect(screen.getByText("codeIndex.coverageDetails")).toBeTruthy();
    expect(screen.getByTestId("composer-code-index-skip-reason").textContent).toBe(
      "codeIndex.skip.secret",
    );
    expect(screen.queryByText(diagnostic)).toBeNull();
    expect(document.querySelector(".text-amber-600, .text-amber-400")).toBeNull();
  });
});

function statusWith(state: CodeIndexStatus["state"], partial?: boolean): CodeIndexStatus {
  return {
    state,
    ...(partial === undefined ? {} : { partial }),
    generation: state === "unindexed" ? 0 : 3,
    updatedAt: state === "unindexed" ? undefined : 1_791_000_000_000,
    counts: { files: 4, chunks: 8, symbols: 12, edges: 5 },
    embedding: { configured: false, available: false, phase: "not-configured" },
    diagnostics: [],
  };
}

function mockService(status: CodeIndexStatus) {
  mocks.services = {
    codeIntelligenceService: {
      getStatus: vi.fn().mockResolvedValue(status),
      watchWorkspace: vi.fn(() => new Promise<void>(() => undefined)),
    },
  };
}

async function renderWithStatus(status: CodeIndexStatus, expectedTone: string) {
  mockService(status);
  render(createElement(CodeIndexPopover, { workspacePath: "/workspace" }));
  // 首帧 status 仍是 null（neutral）；必须等实际状态到达，否则断言会读到 loading 的 tone。
  await waitFor(() =>
    expect(screen.getByTestId("composer-code-index-trigger").dataset.codeIndexTone).toBe(
      expectedTone,
    ),
  );
  return screen.getByTestId("composer-code-index-indicator");
}

describe("CodeIndexPopover status indicator tones", () => {
  it("uses a neutral dot for an unindexed workspace and still renders the dot", async () => {
    const dot = await renderWithStatus(statusWith("unindexed"), "neutral");

    expect(dot.dataset.codeIndexTone).toBe("neutral");
    expect(dot.className).toMatch(/bg-foreground-subtle/);
    expect(dot.className).not.toMatch(/bg-muted/);
    expect(dot.className).not.toMatch(/animate-pulse/);
    expect(screen.getByTestId("composer-code-index-trigger").dataset.codeIndexState).toBe(
      "unindexed",
    );
  });

  it("uses an amber warning dot with a pulse while indexing", async () => {
    const dot = await renderWithStatus(statusWith("indexing"), "indexing");

    expect(dot.dataset.codeIndexTone).toBe("indexing");
    expect(dot.className).toMatch(/bg-warning/);
    expect(dot.className).toMatch(/animate-pulse/);
  });

  it("uses a success dot for a complete ready index", async () => {
    const dot = await renderWithStatus(statusWith("ready", false), "ready");

    expect(dot.dataset.codeIndexTone).toBe("ready");
    expect(dot.className).toMatch(/bg-success/);
    expect(dot.className).not.toMatch(/animate-pulse/);
  });

  it("uses a warning dot for ready but partial coverage", async () => {
    const dot = await renderWithStatus(statusWith("ready", true), "partial");

    expect(dot.dataset.codeIndexTone).toBe("partial");
    expect(dot.className).toMatch(/bg-warning/);
    expect(dot.className).not.toMatch(/animate-pulse/);
  });

  it("uses a destructive dot for a degraded index", async () => {
    const dot = await renderWithStatus(statusWith("degraded"), "degraded");

    expect(dot.dataset.codeIndexTone).toBe("degraded");
    expect(dot.className).toMatch(/bg-destructive/);
  });

  it("announces the localized status through the button name and live region", async () => {
    await renderWithStatus(statusWith("ready", true), "partial");

    const trigger = screen.getByTestId("composer-code-index-trigger");
    expect(trigger.getAttribute("aria-label")).toBe(
      "codeIndex.triggerWithStatus".replace("{status}", "agentWorkbench.statePartial"),
    );
    expect(trigger.getAttribute("title")).toBe(
      "codeIndex.triggerWithStatus".replace("{status}", "agentWorkbench.statePartial"),
    );
    expect(trigger.getAttribute("aria-label")).not.toContain("agentWorkbench.stateReady");
    const liveRegion = screen.getByTestId("composer-code-index-status");
    expect(liveRegion.getAttribute("role")).toBe("status");
    expect(liveRegion.getAttribute("aria-live")).toBe("polite");
    expect(liveRegion.textContent).toBe("agentWorkbench.statePartial");
  });

  it("shows the partial status text in the popover badge instead of Ready", async () => {
    await renderWithStatus(statusWith("ready", true), "partial");

    const badge = screen.getByTestId("composer-code-index-badge");
    expect(badge.textContent).toBe("agentWorkbench.statePartial");
    expect(badge.textContent).not.toBe("agentWorkbench.stateReady");
  });

  it("shows the ready status text in the popover badge for a complete index", async () => {
    await renderWithStatus(statusWith("ready", false), "ready");

    expect(screen.getByTestId("composer-code-index-badge").textContent).toBe(
      "agentWorkbench.stateReady",
    );
  });

  it("does not label a degraded index as partial coverage", async () => {
    await renderWithStatus(statusWith("degraded"), "degraded");

    const badge = screen.getByTestId("composer-code-index-badge");
    expect(badge.textContent).toBe("agentWorkbench.stateDegraded");
    expect(badge.textContent).not.toBe("agentWorkbench.statePartial");
  });

  it("announces the loading copy before the first status resolves", () => {
    mocks.services = {
      codeIntelligenceService: {
        getStatus: vi.fn(() => new Promise<CodeIndexStatus>(() => undefined)),
        watchWorkspace: vi.fn(() => new Promise<void>(() => undefined)),
      },
    };
    render(createElement(CodeIndexPopover, { workspacePath: "/workspace" }));

    expect(screen.getByTestId("composer-code-index-indicator").dataset.codeIndexTone).toBe(
      "neutral",
    );
    expect(screen.getByTestId("composer-code-index-status").textContent).toBe(
      "codeIndex.loadingStatus",
    );
  });

  it("keeps polling a closed popover while indexing and then stops on ready", async () => {
    const scheduled: Array<() => void> = [];
    const setIntervalSpy = vi
      .spyOn(window, "setInterval")
      .mockImplementation((handler: TimerHandler) => {
        scheduled.push(handler as () => void);
        return 1 as unknown as ReturnType<typeof setInterval>;
      });
    vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);
    const getStatus = vi
      .fn<() => Promise<CodeIndexStatus>>()
      .mockResolvedValueOnce(statusWith("indexing"))
      .mockResolvedValue(statusWith("ready", false));
    mocks.services = {
      codeIntelligenceService: {
        getStatus,
        watchWorkspace: vi.fn(() => new Promise<void>(() => undefined)),
      },
    };

    render(createElement(CodeIndexPopover, { workspacePath: "/workspace" }));
    await waitFor(() =>
      expect(screen.getByTestId("composer-code-index-trigger").dataset.codeIndexTone).toBe(
        "indexing",
      ),
    );
    expect(scheduled.length).toBeGreaterThan(0);
    scheduled.at(-1)?.();
    await waitFor(() =>
      expect(screen.getByTestId("composer-code-index-trigger").dataset.codeIndexTone).toBe(
        "ready",
      ),
    );
    setIntervalSpy.mockRestore();
    vi.spyOn(window, "clearInterval").mockRestore();
  });

  it("ignores a slower indexing reply that lands after a newer ready status", async () => {
    let resolveStale: (status: CodeIndexStatus) => void = () => undefined;
    const stale = new Promise<CodeIndexStatus>((resolve) => {
      resolveStale = resolve;
    });
    let resolveWatch: () => void = () => undefined;
    const getStatus = vi
      .fn<() => Promise<CodeIndexStatus>>()
      .mockImplementationOnce(() => stale)
      .mockResolvedValue(statusWith("ready", false));
    mocks.services = {
      codeIntelligenceService: {
        getStatus,
        watchWorkspace: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              resolveWatch = resolve;
            }),
        ),
      },
    };

    render(createElement(CodeIndexPopover, { workspacePath: "/workspace" }));
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(1));
    resolveWatch();
    await waitFor(() =>
      expect(screen.getByTestId("composer-code-index-trigger").dataset.codeIndexTone).toBe(
        "ready",
      ),
    );
    resolveStale(statusWith("indexing"));
    await Promise.resolve();
    expect(screen.getByTestId("composer-code-index-trigger").dataset.codeIndexTone).toBe("ready");
  });

  it("does not rely on raw palette utilities in the indicator dot", async () => {
    const dot = await renderWithStatus(statusWith("ready", false), "ready");

    expect(dot.className).not.toMatch(/bg-emerald-|text-emerald-|bg-amber-|text-amber-/);
  });
});

function mockWorkbenchServices(status: CodeIndexStatus) {
  mocks.services = {
    codeIntelligenceService: {
      getStatus: vi.fn().mockResolvedValue(status),
      watchWorkspace: vi.fn(() => new Promise<void>(() => undefined)),
    },
    subagentsService: {
      list: vi.fn().mockResolvedValue({ agents: [] }),
    },
  };
}

async function renderWorkbenchPill(status: CodeIndexStatus, expectedTone: string) {
  mockWorkbenchServices(status);
  render(createElement(AgentWorkbenchView, { workspacePath: "/workspace" }));
  const pill = screen.getByTestId("agent-workbench-index-state");
  await waitFor(() => expect(pill.dataset.codeIndexTone).toBe(expectedTone));
  return pill;
}

describe("AgentWorkbench index state pill", () => {
  it("uses the neutral tag pill for an unindexed workspace", async () => {
    const pill = await renderWorkbenchPill(statusWith("unindexed"), "neutral");

    expect(pill.dataset.codeIndexTone).toBe("neutral");
    expect(pill.dataset.codeIndexState).toBe("unindexed");
    expect(pill.className).toMatch(/bg-tag/);
    expect(pill.className).toMatch(/text-foreground-subtle/);
    expect(pill.className).not.toMatch(/bg-muted/);
  });

  it("uses the warning surface pill while indexing", async () => {
    const pill = await renderWorkbenchPill(statusWith("indexing"), "indexing");

    expect(pill.dataset.codeIndexTone).toBe("indexing");
    expect(pill.dataset.codeIndexState).toBe("indexing");
    expect(pill.className).toMatch(/bg-warning-surface/);
    expect(pill.className).toMatch(/text-warning-surface-foreground/);
  });

  it("uses the success surface pill for a complete ready index", async () => {
    const pill = await renderWorkbenchPill(statusWith("ready", false), "ready");

    expect(pill.dataset.codeIndexTone).toBe("ready");
    expect(pill.className).toMatch(/bg-success-surface/);
    expect(pill.className).toMatch(/text-success-surface-foreground/);
  });

  it("uses the warning surface pill for ready but partial coverage", async () => {
    const pill = await renderWorkbenchPill(statusWith("ready", true), "partial");

    expect(pill.dataset.codeIndexTone).toBe("partial");
    expect(pill.dataset.codeIndexState).toBe("ready");
    expect(pill.textContent).toBe("agentWorkbench.statePartial");
    expect(pill.className).toMatch(/bg-warning-surface/);
    expect(pill.className).toMatch(/text-warning-surface-foreground/);
  });

  it("shows the ready status text on the success pill for a complete index", async () => {
    const pill = await renderWorkbenchPill(statusWith("ready", false), "ready");

    expect(pill.textContent).toBe("agentWorkbench.stateReady");
  });

  it("keeps a distinct English partial label instead of reusing Ready", async () => {
    const englishMessages = (await import("../src/i18n/locales/en-US.js")).default;

    expect(englishMessages["agentWorkbench.statePartial"]).toBe("Partial");
    expect(englishMessages["agentWorkbench.statePartial"]).not.toBe(
      englishMessages["agentWorkbench.stateReady"],
    );
  });

  it("polls while indexing even when the build button is idle", async () => {
    const scheduled: Array<() => void> = [];
    const setIntervalSpy = vi
      .spyOn(window, "setInterval")
      .mockImplementation((handler: TimerHandler) => {
        scheduled.push(handler as () => void);
        return 1 as unknown as ReturnType<typeof setInterval>;
      });
    vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);
    const getStatus = vi
      .fn<() => Promise<CodeIndexStatus>>()
      .mockResolvedValueOnce(statusWith("indexing"))
      .mockResolvedValue(statusWith("ready", false));
    mocks.services = {
      codeIntelligenceService: {
        getStatus,
        watchWorkspace: vi.fn(() => new Promise<void>(() => undefined)),
      },
      subagentsService: {
        list: vi.fn().mockResolvedValue({ agents: [] }),
      },
    };

    render(createElement(AgentWorkbenchView, { workspacePath: "/workspace" }));
    await waitFor(() =>
      expect(screen.getByTestId("agent-workbench-index-state").dataset.codeIndexTone).toBe(
        "indexing",
      ),
    );
    expect(scheduled.length).toBeGreaterThan(0);
    scheduled.at(-1)?.();
    await waitFor(() =>
      expect(screen.getByTestId("agent-workbench-index-state").dataset.codeIndexTone).toBe(
        "ready",
      ),
    );
    setIntervalSpy.mockRestore();
    vi.spyOn(window, "clearInterval").mockRestore();
  });

  it("uses the destructive surface pill for a degraded index", async () => {
    const pill = await renderWorkbenchPill(statusWith("degraded"), "degraded");

    expect(pill.dataset.codeIndexTone).toBe("degraded");
    expect(pill.dataset.codeIndexState).toBe("degraded");
    expect(pill.className).toMatch(/bg-destructive-surface/);
    expect(pill.className).toMatch(/text-destructive-surface-foreground/);
  });
});
