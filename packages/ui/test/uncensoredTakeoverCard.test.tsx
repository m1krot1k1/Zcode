// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { SubagentRow } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ConversationRowView } from "@/v4/ConversationRowView.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import type { UncensoredTakeover } from "@/v4/uncensored-takeover/contract.js";
import { UncensoredTakeoverCard } from "@/v4/uncensored-takeover/index.js";

const context: ConversationRowRenderContext = {
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
  sessionId: "session-1",
  theme: "system",
  workspacePath: "/workspace",
};

const ruRU: Record<string, string> = JSON.parse(
  readFileSync(join(process.cwd(), "packages/ui/src/i18n/locales/ru-RU.json"), "utf8"),
);

const CHAT_KEYS = [
  "chat.uncensoredTakeover.title",
  "chat.uncensoredTakeover.item",
  "chat.uncensoredTakeover.model",
  "chat.uncensoredTakeover.reason",
  "chat.uncensoredTakeover.output",
  "chat.uncensoredTakeover.status.running",
  "chat.uncensoredTakeover.status.done",
  "chat.uncensoredTakeover.status.refused",
  "chat.uncensoredTakeover.status.error",
  "chat.uncensoredTakeover.status.no-enabled-models",
  "chat.uncensoredTakeover.noEnabledModels",
] as const;

const STATUS_LABELS = {
  running: "Running",
  done: "Completed",
  refused: "Refused",
  error: "Failed",
  "no-enabled-models": "No enabled models",
} as const;

const STATUS_ROLES = {
  running: "status",
  done: null,
  refused: "alert",
  error: "alert",
  "no-enabled-models": null,
} as const;

function takeover(overrides: Partial<UncensoredTakeover> = {}): UncensoredTakeover {
  return {
    taskId: "session-1",
    itemIndex: 2,
    itemText: "Add the missing regression test",
    modelId: "fallback-model-a",
    status: "done",
    output: "Added the regression test.",
    ...overrides,
  };
}

function renderCard(payload: UncensoredTakeover, locale: "en-US" | "zh-CN" = "en-US") {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(UncensoredTakeoverCard, { takeover: payload }),
    ),
  );
}

function subagentRow(overrides: Partial<SubagentRow> = {}): SubagentRow {
  return {
    rowId: 7,
    turnId: "turn-1",
    createdAt: 1_800_000_000_000,
    createdAtSeq: 7,
    kind: "subagent",
    subagentType: "uncensored-takeover",
    status: "success",
    summaryText: "Fallback handled item 3",
    ...overrides,
  } as SubagentRow;
}

afterEach(() => cleanup());

describe("UncensoredTakeoverCard content", () => {
  it("renders 1-based item index, item text, model, status, reason and full output", () => {
    renderCard(
      takeover({
        itemIndex: 4,
        itemText: "Fix the failing test",
        modelId: "fallback-model-b",
        status: "done",
        reason: "content-filter",
        output: "The failing test now passes.",
      }),
    );

    expect(screen.getByTestId("uncensored-takeover-item").textContent).toBe(
      "Item 5: Fix the failing test",
    );
    expect(screen.getByTestId("uncensored-takeover-status").textContent).toBe("Completed");
    expect(screen.getByText("Model: fallback-model-b")).toBeTruthy();
    expect(screen.getByText("Reason: content-filter")).toBeTruthy();
    expect(screen.getByText("Output")).toBeTruthy();
    expect(screen.getByTestId("uncensored-takeover-output").textContent).toBe(
      "The failing test now passes.",
    );
    expect(screen.getByTestId("uncensored-takeover-card").getAttribute("data-takeover-status")).toBe(
      "done",
    );
  });

  it("localizes the card through the active chat catalog", () => {
    renderCard(takeover({ itemIndex: 0 }), "zh-CN");

    expect(screen.getByText("回退模型接管")).toBeTruthy();
    expect(screen.getByTestId("uncensored-takeover-item").textContent).toBe(
      "第 1 项：Add the missing regression test",
    );
    expect(screen.getByTestId("uncensored-takeover-status").textContent).toBe("已完成");
    expect(screen.getByText("模型：fallback-model-a")).toBeTruthy();
  });

  it("renders the em-dash placeholder for a null model and hides an empty output block", () => {
    renderCard(
      takeover({
        modelId: null,
        status: "error",
        output: "",
        reason: "content-filter",
      }),
    );

    expect(screen.getByText("Model: —")).toBeTruthy();
    expect(screen.queryByTestId("uncensored-takeover-output")).toBeNull();
    expect(screen.getByTestId("uncensored-takeover-status").textContent).toBe("Failed");
  });

  it("shows an explicit no-enabled-models hint without an empty output block", () => {
    renderCard(
      takeover({ modelId: null, status: "no-enabled-models", output: "" }),
    );

    expect(screen.getByText("No enabled models")).toBeTruthy();
    expect(
      screen.getByText("Enable at least one fallback model in settings."),
    ).toBeTruthy();
    expect(screen.queryByTestId("uncensored-takeover-output")).toBeNull();
  });
});

describe("UncensoredTakeoverCard statuses and accessibility", () => {
  it.each(Object.entries(STATUS_LABELS))(
    "renders the %s status label and role",
    (status, label) => {
      renderCard(takeover({ status: status as UncensoredTakeover["status"] }));

      const badge = screen.getByTestId("uncensored-takeover-status");
      expect(badge.textContent).toBe(label);
      expect(badge.getAttribute("role")).toBe(STATUS_ROLES[status as keyof typeof STATUS_ROLES]);
      expect(badge.className).toContain("text-");
    },
  );

  it("associates the card heading and output heading with the scrollable output region", () => {
    renderCard(takeover({ output: "line 1\nline 2" }));

    const output = screen.getByTestId("uncensored-takeover-output");
    expect(output.getAttribute("role")).toBe("region");
    expect(output.getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("region", { name: /Fallback model takeover Output/ })).toBe(output);
    expect(output.className).toContain("overflow-auto");
    expect(output.className).toContain("max-h-64");
    expect(output.className).toContain("font-mono");
    expect(output.textContent).toBe("line 1\nline 2");
  });

  it("clamps long item text while keeping the full text as the title affordance", () => {
    const longItem = `${"x".repeat(3999)}…`;
    renderCard(takeover({ itemText: longItem }));

    const item = screen.getByTestId("uncensored-takeover-item");
    expect(item.getAttribute("title")).toBe(longItem);
    expect(item.className).toContain("line-clamp-3");
    expect(item.className).toContain("wrap-anywhere");
    expect(item.textContent?.endsWith("…")).toBe(true);
  });

  it("keeps unbroken long output intact inside the bounded scroll region", () => {
    const longOutput = `${"a".repeat(8000)}END`;
    renderCard(takeover({ output: longOutput }));

    const output = screen.getByTestId("uncensored-takeover-output");
    expect(output.textContent).toBe(longOutput);
    expect(output.className).toContain("overflow-auto");
    expect(output.className).toContain("break-words");
    expect(output.className).toContain("wrap-anywhere");
  });
});

describe("SubagentRowView takeover wiring", () => {
  function renderRow(row: SubagentRow): string {
    return renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(ConversationRowView, { context, row }),
      ),
    );
  }

  it("renders the takeover card only for rows that carry takeover facts", () => {
    const withTakeover = renderRow(subagentRow({ takeover: takeover() }));
    expect(withTakeover).toContain('data-testid="uncensored-takeover-card"');
    expect(withTakeover).toContain("Fallback model takeover");
    expect(withTakeover).toContain("Model: fallback-model-a");

    const withoutTakeover = renderRow(subagentRow({ subagentType: "task" }));
    expect(withoutTakeover).not.toContain('data-testid="uncensored-takeover-card"');
    expect(withoutTakeover).toContain("task · success — Fallback handled item 3");
  });
});

describe("UncensoredTakeoverCard i18n and typography", () => {
  it("declares every chat key in all three catalogs", () => {
    for (const key of CHAT_KEYS) {
      expect(enUS[key], `en-US ${key}`).toBeTruthy();
      expect(zhCN[key], `zh-CN ${key}`).toBeTruthy();
      expect(ruRU[key], `ru-RU ${key}`).toBeTruthy();
    }
    expect(enUS["chat.uncensoredTakeover.item"]).toBe("Item {index}: {text}");
    expect(zhCN["chat.uncensoredTakeover.model"]).toBe("模型：{model}");
    expect(ruRU["chat.uncensoredTakeover.noEnabledModels"]).toBe(
      "Включите хотя бы одну резервную модель в настройках.",
    );
  });

  it("uses only the text-ui-* scale and no inline font sizing", () => {
    const source = readFileSync(
      join(process.cwd(), "packages/ui/src/v4/uncensored-takeover/UncensoredTakeoverCard.tsx"),
      "utf8",
    );
    expect(source).toMatch(/text-ui-base/);
    expect(source).toMatch(/text-ui-sm/);
    expect(source).not.toMatch(/\btext-sm\b/);
    expect(source).not.toMatch(/\btext-xs\b/);
    expect(source).not.toMatch(/\btext-base\b/);
    expect(source).not.toMatch(/\btext-lg\b/);
    expect(source).not.toMatch(/\btext-xl\b/);
    expect(source).not.toMatch(/text-\[\d/);
    expect(source).not.toMatch(/fontSize/);
    expect(source).not.toMatch(/document\.documentElement\.style\.fontSize/);
  });
});
