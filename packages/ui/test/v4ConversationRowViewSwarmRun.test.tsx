// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TID_V4_SUBAGENT_DRILLDOWN,
  TID_V4_SUBAGENT_OPEN_SIDE_PANE,
  testId,
} from "@zcode/shared/test-ids";
import type { AssistantTextRow, SwarmRunRow } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationRowView } from "@/v4/ConversationRowView.js";
import { V4ConversationContext } from "@/v4/V4ConversationContext.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

const context: ConversationRowRenderContext = {
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
  sessionId: "session-1",
  theme: "system",
  workspacePath: "/workspace",
};

function renderSwarm(row: SwarmRunRow, locale: "en-US" | "zh-CN" = "en-US"): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(ConversationRowView, { context, row }),
    ),
  );
}

describe("ConversationRowView swarm row", () => {
  afterEach(() => cleanup());

  it("renders stable run identity, localized lifecycle status, task count, and summary", () => {
    const row: SwarmRunRow = {
      rowId: 4,
      turnId: "turn-1",
      createdAt: 1_800_000_000_000,
      createdAtSeq: 4,
      kind: "swarmRun",
      swarmRunId: "swarm-42",
      status: "running",
      taskCount: 2,
      summary: "Two independent tasks are running.",
    };
    const html = renderSwarm(row);

    expect(html).toContain('data-row-kind="swarmRun"');
    expect(html).toContain('data-swarm-run-id="swarm-42"');
    expect(html).toContain('data-status="running"');
    expect(html).toContain("Agent swarm");
    expect(html).toContain("Running");
    expect(html).toContain("Tasks: 2");
    expect(html).toContain("Two independent tasks are running.");
  });

  it("shows unknown acceptance for legacy terminal rows and localizes status in Chinese", () => {
    const row: SwarmRunRow = {
      rowId: 5,
      turnId: "turn-1",
      createdAt: 1_800_000_000_000,
      createdAtSeq: 5,
      kind: "swarmRun",
      swarmRunId: "swarm-43",
      status: "completed",
    };

    const html = renderSwarm(row, "zh-CN");
    expect(html).toContain("已完成");
    expect(html).toContain("目标尚未验证");
  });

  it("distinguishes passed declared checks from semantic goal verification", () => {
    const row: SwarmRunRow = {
      rowId: 8,
      turnId: "turn-1",
      createdAt: 1_800_000_000_000,
      createdAtSeq: 8,
      kind: "swarmRun",
      swarmRunId: "swarm-verified-checks",
      status: "completed",
      outcomeAcceptance: "verified",
    };

    expect(renderSwarm(row)).toContain("Declared checks passed; semantic goal is unverified");
  });

  it("shows actual child session IDs and opens the selected child in the side pane", () => {
    const onOpenSubagentSession = vi.fn();
    const childSessionIds = ["child-session-1", "child-session-2"];
    const row: SwarmRunRow = {
      rowId: 6,
      turnId: "turn-1",
      createdAt: 1_800_000_000_000,
      createdAtSeq: 6,
      kind: "swarmRun",
      swarmRunId: "swarm-44",
      status: "running",
      taskCount: 2,
      childSessionIds,
      childAgentTypes: {
        "child-session-1": "researcher",
        "child-session-2": "implementer",
      },
    };
    const contextWithChildNavigation: ConversationRowRenderContext = {
      ...context,
      rootSessionId: "root-session-1",
      onOpenSubagentSession,
    };
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          V4ConversationContext.Provider,
          {
            value: {
              layer: { acquire: vi.fn(() => ({ store: null, release: vi.fn() })) },
            } as never,
          },
          createElement(ConversationRowView, {
            context: contextWithChildNavigation,
            row,
          }),
        ),
      ),
    );

    expect(screen.getByLabelText("Child sessions").textContent).toContain("child-session-1");
    expect(screen.getByLabelText("Child sessions").textContent).toContain("child-session-2");
    expect(screen.getByTestId("swarm-child-role-child-session-1").textContent).toBe(
      "Role: researcher",
    );
    expect(screen.getByTestId("swarm-child-role-child-session-2").textContent).toBe(
      "Role: implementer",
    );
    expect(
      screen.getByTestId("swarm-child-output-toggle-child-session-2").getAttribute("aria-expanded"),
    ).toBe("true");
    fireEvent.click(screen.getByTestId(testId(TID_V4_SUBAGENT_OPEN_SIDE_PANE, "child-session-2")));

    expect(onOpenSubagentSession).toHaveBeenCalledWith({
      rootSessionId: "root-session-1",
      parentSessionId: "session-1",
      childSessionId: "child-session-2",
      subagentType: "swarm-task",
      title: "Swarm task 2",
    });
  });

  it("mounts live child outputs by default and lets each preview be collapsed", async () => {
    const row: SwarmRunRow = {
      rowId: 9,
      turnId: "turn-1",
      createdAt: 1_800_000_000_000,
      createdAtSeq: 9,
      kind: "swarmRun",
      swarmRunId: "swarm-live-output",
      status: "running",
      childSessionIds: ["child-live-1", "child-live-2"],
    };
    const release = vi.fn();
    const acquire = vi.fn((_sessionId: string) => ({ store: null, release }));
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          TooltipProvider,
          null,
          createElement(
            V4ConversationContext.Provider,
            { value: { layer: { acquire } } as never },
            createElement(ConversationRowView, {
              context: { ...context, theme: "light" },
              row,
            }),
          ),
        ),
      ),
    );

    expect(
      await screen.findByTestId(testId(TID_V4_SUBAGENT_DRILLDOWN, "child-live-1")),
    ).toBeTruthy();
    expect(screen.getByTestId(testId(TID_V4_SUBAGENT_DRILLDOWN, "child-live-2"))).toBeTruthy();
    expect(screen.queryByTestId("swarm-child-role-child-live-1")).toBeNull();
    expect(acquire.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      "child-live-1",
      "child-live-2",
    ]);

    fireEvent.click(screen.getByTestId("swarm-child-output-toggle-child-live-1"));
    expect(screen.queryByTestId(testId(TID_V4_SUBAGENT_DRILLDOWN, "child-live-1"))).toBeNull();
    expect(
      screen.getByTestId("swarm-child-output-toggle-child-live-1").getAttribute("aria-expanded"),
    ).toBe("false");
    expect(release).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId(testId(TID_V4_SUBAGENT_DRILLDOWN, "child-live-2"))).toBeTruthy();
  });

  it("keeps the live preview to the latest three assistant rows", async () => {
    const row: SwarmRunRow = {
      rowId: 10,
      turnId: "turn-1",
      createdAt: 1_800_000_000_000,
      createdAtSeq: 10,
      kind: "swarmRun",
      swarmRunId: "swarm-bounded-output",
      status: "running",
      childSessionIds: ["child-bounded"],
    };
    const childRows = [1, 2, 3, 4, 5].map(
      (rowId) =>
        ({
          rowId,
          turnId: "turn-child",
          createdAt: 1_800_000_000_000 + rowId,
          createdAtSeq: rowId,
          kind: "assistantText",
          text: `child-output-${rowId}`,
          state: "complete",
        }) satisfies AssistantTextRow,
    );
    const childState = {
      status: "live",
      snapshot: {
        rows: { window: childRows, totalCount: childRows.length, firstRowId: 1 },
      },
      subscriptionId: "sub-child",
      lastError: null,
      optimisticCommands: [],
      loadingOlder: false,
      sessionPlans: [],
      planDirectoryRevision: 0,
      plansLoading: false,
      turnNavigatorDirectoryRevision: 0,
    };
    const acquire = vi.fn(() => ({
      store: {
        subscribe: () => () => {},
        getState: () => childState,
      },
      release: vi.fn(),
    }));
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          TooltipProvider,
          null,
          createElement(
            V4ConversationContext.Provider,
            { value: { layer: { acquire } } as never },
            createElement(ConversationRowView, {
              context: { ...context, theme: "light" },
              row,
            }),
          ),
        ),
      ),
    );

    const preview = await screen.findByTestId(testId(TID_V4_SUBAGENT_DRILLDOWN, "child-bounded"));
    expect(preview.getAttribute("data-row-count")).toBe("5");
    expect(preview.getAttribute("data-visible-row-count")).toBe("3");
    expect(preview.textContent).toContain("child-output-3");
    expect(preview.textContent).toContain("child-output-4");
    expect(preview.textContent).toContain("child-output-5");
    expect(preview.textContent).not.toContain("child-output-1");
    expect(preview.textContent).not.toContain("child-output-2");
  });
});
