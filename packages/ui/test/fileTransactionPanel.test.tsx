// @vitest-environment jsdom
// ============================================================
// Этап 6.1c: реактивная панель транзакционных изменений файлов
// ============================================================
//
// Проверки держат контракт «событие → панель», а не реализацию:
//  - committed кадр рисует пути и счётчики;
//  - rolled_back показывает явный индикатор отката;
//  - повторный кадр с тем же transactionId идемпотентен (нет двойного рендера);
//  - кадр чужого workspace не попадает в панель;
//  - компактная сводка (web) рендерится без structuredPatch;
//  - полный патч (desktop) даёт открытие diff;
//  - невалидный кадр не роняет UI.

import { createElement } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZCodeFileTransactionEventPayload } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { FileTransactionSummaryPanel } from "@/v4/FileTransactionSummaryPanel.js";
import { useFileTransactionStore } from "@/store/fileTransactionStore.js";
import { toFileTransactionView } from "@/lib/fileTransactionProjection.js";
import { shouldMirrorFileTransaction } from "@/lib/fileTransactionWorkspaceScope.js";

const WORKSPACE = "/workspace";

function fullPayload(
  overrides: Partial<ZCodeFileTransactionEventPayload> = {},
): ZCodeFileTransactionEventPayload {
  return {
    compact: false,
    transactionId: "tx-1",
    workspaceKey: WORKSPACE,
    workspacePath: WORKSPACE,
    sessionId: "session-1",
    turnId: "turn-1",
    toolCallId: "tool-1",
    toolName: "MultiEdit",
    status: "committed",
    timestamp: 1_700_000_000_000,
    affectedPaths: ["src/alpha.ts", "src/beta.ts"],
    files: [
      {
        path: "src/alpha.ts",
        displayPath: "src/alpha.ts",
        operation: "update",
        additions: 21,
        deletions: 12,
        structuredPatch: [{ header: "@@ -1,2 +1,2 @@", lines: ["-a", "+b"] }],
      },
      {
        path: "src/beta.ts",
        displayPath: "src/beta.ts",
        operation: "create",
        additions: 3,
        deletions: 0,
        structuredPatch: [{ header: "@@ -0,0 +1,3 @@", lines: ["+x", "+y", "+z"] }],
      },
    ],
    ...overrides,
  } as ZCodeFileTransactionEventPayload;
}

function compactPayload(
  overrides: Partial<ZCodeFileTransactionEventPayload> = {},
): ZCodeFileTransactionEventPayload {
  return {
    compact: true,
    transactionId: "tx-compact",
    workspaceKey: WORKSPACE,
    workspacePath: WORKSPACE,
    sessionId: "session-1",
    turnId: "turn-1",
    toolCallId: "tool-compact",
    toolName: "MultiEdit",
    status: "committed",
    timestamp: 1_700_000_001_000,
    affectedPaths: ["src/alpha.ts"],
    files: [
      {
        path: "src/alpha.ts",
        displayPath: "src/alpha.ts",
        operation: "update",
        additions: 21,
        deletions: 12,
      },
    ],
    ...overrides,
  } as ZCodeFileTransactionEventPayload;
}

function renderWithIntl(node: Parameters<typeof createElement>[0] extends never ? never : React.ReactNode) {
  return render(createElement(ZCodeIntlProvider, { initialLocale: "en-US" }, node));
}

beforeEach(() => {
  useFileTransactionStore.getState().reset();
});

afterEach(() => {
  cleanup();
  useFileTransactionStore.getState().reset();
});

describe("FileTransactionSummaryPanel", () => {
  it("показывает пути и счётчики после committed-кадра", () => {
    useFileTransactionStore.getState().applyPayload(fullPayload());
    const transactions = Object.values(
      useFileTransactionStore.getState().table[WORKSPACE]["session-1"],
    );
    const view = renderWithIntl(
      createElement(FileTransactionSummaryPanel, {
        transactions,
        workspacePath: WORKSPACE,
        messageId: "m-1",
      }),
    );
    const panel = view.getByTestId("chat-file-transaction-panel-m-1");
    expect(panel.getAttribute("data-transaction-status")).toBe("committed");
    expect(panel.textContent).toContain("2 files changed");
    expect(panel.textContent).toContain("+24");
    expect(panel.textContent).toContain("-12");

    fireEvent.click(view.getByRole("button"));
    expect(view.container.textContent).toContain("alpha.ts");
    expect(view.container.textContent).toContain("beta.ts");
  });

  it("показывает явный индикатор отката при rolled_back", () => {
    useFileTransactionStore.getState().applyPayload(
      fullPayload({ status: "rolled_back", timestamp: 1_700_000_002_000 }),
    );
    const transactions = Object.values(
      useFileTransactionStore.getState().table[WORKSPACE]["session-1"],
    );
    const view = renderWithIntl(
      createElement(FileTransactionSummaryPanel, {
        transactions,
        workspacePath: WORKSPACE,
      }),
    );
    expect(view.container.textContent).toContain("Changes reverted");
    expect(
      view.container.querySelector('[data-transaction-status="rolled_back"]'),
    ).not.toBeNull();
  });

  it("идемпотентен при повторе того же transactionId", () => {
    const payload = fullPayload();
    expect(useFileTransactionStore.getState().applyPayload(payload)).toBe(true);
    const before = useFileTransactionStore.getState().table;
    expect(useFileTransactionStore.getState().applyPayload(payload)).toBe(false);
    // Тот же объект состояния => ни одного лишнего set() и ререндера.
    expect(useFileTransactionStore.getState().table).toBe(before);

    const transactions = Object.values(
      useFileTransactionStore.getState().table[WORKSPACE]["session-1"],
    );
    const view = renderWithIntl(
      createElement(FileTransactionSummaryPanel, {
        transactions,
        workspacePath: WORKSPACE,
        messageId: "m-2",
      }),
    );
    expect(view.container.querySelectorAll('[data-testid^="chat-file-transaction-panel"]')).toHaveLength(1);
  });

  it("не принимает кадры чужого workspaceKey", () => {
    expect(
      shouldMirrorFileTransaction({
        payloadWorkspaceKey: "/other-workspace",
        workspaceKey: WORKSPACE,
      }),
    ).toBe(false);
    // Даже если кадр всё же записали, селектор текущего workspace его не увидит.
    useFileTransactionStore.getState().applyPayload(
      fullPayload({ workspaceKey: "/other-workspace", workspacePath: "/other-workspace" }),
    );
    expect(useFileTransactionStore.getState().table[WORKSPACE]).toBeUndefined();
  });

  it("рендерит компактную сводку web-контура без structuredPatch", () => {
    const payload = compactPayload();
    useFileTransactionStore.getState().applyPayload(payload);
    const transactions = Object.values(
      useFileTransactionStore.getState().table[WORKSPACE]["session-1"],
    );
    const view = renderWithIntl(
      createElement(FileTransactionSummaryPanel, {
        transactions,
        workspacePath: WORKSPACE,
        messageId: "m-compact",
      }),
    );
    const panel = view.getByTestId("chat-file-transaction-panel-m-compact");
    expect(panel.getAttribute("data-transaction-compact")).toBe("true");
    expect(panel.textContent).toContain("1 file changed");
    expect(panel.textContent).toContain("+21");
    expect(panel.textContent).toContain("-12");
    expect(transactions[0]?.files[0]?.unifiedPatch).toBeUndefined();
  });

  it("открывает diff для полного патча desktop-контура", () => {
    useFileTransactionStore.getState().applyPayload(fullPayload());
    const transactions = Object.values(
      useFileTransactionStore.getState().table[WORKSPACE]["session-1"],
    );
    const onOpenCodeViewer = vi.fn();
    const view = renderWithIntl(
      createElement(FileTransactionSummaryPanel, {
        transactions,
        workspacePath: WORKSPACE,
        messageId: "m-full",
        onOpenCodeViewer,
      }),
    );
    fireEvent.click(view.getByRole("button"));
    const fileRow = view.container.querySelector('[title="src/alpha.ts"]');
    expect(fileRow).not.toBeNull();
    fireEvent.click(fileRow as HTMLElement);
    expect(onOpenCodeViewer).toHaveBeenCalledTimes(1);
    const source = onOpenCodeViewer.mock.calls[0]?.[0];
    expect(source?.type).toBe("patch");
    expect(source?.patch).toContain("--- a/src/alpha.ts");
  });

  it("не падает на невалидном кадре (проекция отбрасывает ранее)", () => {
    const payload = { ...fullPayload(), status: "exploded" } as unknown as ZCodeFileTransactionEventPayload;
    // Store не валидирует схему сам (это делает проекция), но обязан не бросать:
    // сюда попадает только то, что уже прошло safeParse.
    expect(() => useFileTransactionStore.getState().applyPayload(payload)).not.toThrow();
    // И панель с пустым набором не рендерится вовсе, не показывая пустышку.
    const view = renderWithIntl(
      createElement(FileTransactionSummaryPanel, {
        transactions: [],
        workspacePath: WORKSPACE,
      }),
    );
    expect(view.container.innerHTML).toBe("");
  });

  it("строит view без патча, когда structuredPatch невалиден", () => {
    const view = toFileTransactionView(
      fullPayload({
        files: [
          {
            path: "src/gamma.ts",
            displayPath: "src/gamma.ts",
            operation: "update",
            additions: 1,
            deletions: 1,
            structuredPatch: [{ nope: true }],
          },
        ],
      } as Partial<ZCodeFileTransactionEventPayload>),
    );
    expect(view.files[0]?.unifiedPatch).toBeUndefined();
    expect(view.files[0]?.additions).toBe(1);
  });
});
