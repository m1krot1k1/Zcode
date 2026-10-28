import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { SubagentDrilldown } from "@/v4/SubagentDrilldown.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";

const projectionState = vi.hoisted(() => ({
  value: {
    status: "live",
    snapshot: {
      rows: {
        window: [
          {
            kind: "turnHeader",
            rowId: "turn-1",
            turnId: "turn-1",
            state: "running",
          },
          {
            kind: "toolCall",
            toolCallId: "tool-1",
            toolName: "Read",
            status: "running",
            inputText: '{"filePath":"/private/secret.txt"}',
            input: { filePath: "/private/secret.txt" },
          },
        ],
      },
    },
    lastError: null,
  } as unknown,
}));

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({ layer: { acquire: () => ({ release: () => {} }) } }),
}));

vi.mock("@/v4/useConversationProjection.js", () => ({
  useConversationProjection: () => projectionState.value,
}));

describe("SubagentDrilldown", () => {
  it("shows safe tool progress before child assistant text arrives", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(SubagentDrilldown, {
          childSessionId: "child-1",
          context: {} as ConversationRowRenderContext,
        }),
      ),
    );

    expect(html).toContain("Agent activity");
    expect(html).toContain("Read");
    expect(html).toContain("Running");
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("secret.txt");
    expect(html).not.toContain("No output yet");
  });

  it("uses a neutral working indicator when the child has not emitted text or tool rows", () => {
    projectionState.value = {
      status: "live",
      snapshot: {
        rows: {
          window: [
            {
              kind: "turnHeader",
              rowId: "turn-2",
              turnId: "turn-2",
              state: "running",
            },
          ],
        },
      },
      lastError: null,
    };

    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(SubagentDrilldown, {
          childSessionId: "child-2",
          context: {} as ConversationRowRenderContext,
        }),
      ),
    );

    expect(html).toContain("Working…");
    expect(html).not.toContain("general-purpose");
  });

  it("does not claim that the child is working when only the projection subscription is live", () => {
    projectionState.value = {
      status: "live",
      snapshot: {
        rows: {
          window: [
            {
              kind: "toolCall",
              toolCallId: "tool-streaming",
              toolName: "Read",
              status: "inputStreaming",
              inputText: "{}",
            },
          ],
        },
      },
      lastError: null,
    };

    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(SubagentDrilldown, {
          childSessionId: "child-3",
          context: {} as ConversationRowRenderContext,
        }),
      ),
    );

    expect(html).toContain("Preparing");
    expect(html).not.toContain("Working…");
  });

  it("shows working while the latest child turn remains running after a tool completes", () => {
    projectionState.value = {
      status: "live",
      snapshot: {
        rows: {
          window: [
            {
              kind: "turnHeader",
              rowId: "turn-4",
              turnId: "turn-4",
              state: "running",
            },
            {
              kind: "toolCall",
              toolCallId: "tool-done",
              toolName: "Read",
              status: "success",
              inputText: "{}",
            },
          ],
        },
      },
      lastError: null,
    };

    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(SubagentDrilldown, {
          childSessionId: "child-4",
          context: {} as ConversationRowRenderContext,
        }),
      ),
    );

    expect(html).toContain("Done");
    expect(html).toContain("Working…");
  });
});
