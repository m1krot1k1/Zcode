// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TID_V4_SUBAGENT_OPEN_SIDE_PANE, testId } from "@zcode/shared/test-ids";
import type { SwarmRunRow } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationRowView } from "@/v4/ConversationRowView.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";

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

  it("localizes terminal status in Chinese", () => {
    const row: SwarmRunRow = {
      rowId: 5,
      turnId: "turn-1",
      createdAt: 1_800_000_000_000,
      createdAtSeq: 5,
      kind: "swarmRun",
      swarmRunId: "swarm-43",
      status: "completed",
    };

    expect(renderSwarm(row, "zh-CN")).toContain("已完成");
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
        createElement(ConversationRowView, { context: contextWithChildNavigation, row }),
      ),
    );

    expect(screen.getByLabelText("Child sessions").textContent).toContain("child-session-1");
    expect(screen.getByLabelText("Child sessions").textContent).toContain("child-session-2");
    fireEvent.click(screen.getByTestId(testId(TID_V4_SUBAGENT_OPEN_SIDE_PANE, "child-session-2")));

    expect(onOpenSubagentSession).toHaveBeenCalledWith({
      rootSessionId: "root-session-1",
      parentSessionId: "session-1",
      childSessionId: "child-session-2",
      subagentType: "swarm-task",
      title: "Swarm task 2",
    });
  });
});
