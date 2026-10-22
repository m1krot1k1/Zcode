// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationRowView } from "@/v4/ConversationRowView.js";
import type { ExternalAgentRunRow } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";

const row: ExternalAgentRunRow = {
  rowId: 1,
  turnId: "turn-1",
  kind: "externalAgentRun",
  runId: "run-1",
  commandId: "run-1",
  provider: "opencode-cli",
  promptText: "inspect repository",
  output: { text: "" },
  tools: [],
  status: "running",
  pendingPermissions: [
    {
      requestId: "permission-1",
      opencodeSessionId: "acp-1",
      title: "Run command",
      inputSummary: "pnpm lint",
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    },
  ],
};

function renderRow(
  onRespondOpenCodePermission?: ConversationRowRenderContext["onRespondOpenCodePermission"],
) {
  return render(
    <ZCodeIntlProvider initialLocale="en-US">
      <ConversationRowView
        row={row}
        context={
          {
            workspacePath: "/workspace",
            theme: "dark",
            codePreviewSettings: {} as ConversationRowRenderContext["codePreviewSettings"],
            onRespondOpenCodePermission,
          } as ConversationRowRenderContext
        }
      />
    </ZCodeIntlProvider>,
  );
}

describe("OpenCode inline ACP permission card", () => {
  afterEach(() => cleanup());

  it("shows only advertised options and routes the exact clicked option identity", () => {
    const onRespond = vi.fn(async () => undefined);
    renderRow(onRespond);

    expect(screen.getByText("Run command")).toBeTruthy();
    expect(screen.getByText("pnpm lint")).toBeTruthy();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Allow once",
      "Reject",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onRespond).toHaveBeenCalledWith({
      commandId: "run-1",
      runId: "run-1",
      opencodeSessionId: "acp-1",
      requestId: "permission-1",
      optionId: "reject-once",
    });
  });

  it("does not expose actionable approval controls without a writable command route", () => {
    renderRow();
    expect(screen.getByRole("button", { name: "Allow once" }).hasAttribute("disabled")).toBe(true);
  });
});
