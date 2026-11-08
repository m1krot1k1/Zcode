// @vitest-environment jsdom

import { createElement } from "react";
import type { HTMLAttributes, ReactNode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeIndexStatus } from "../src/agent-workbench/contract.js";

const mocks = vi.hoisted(() => ({
  services: null as Record<string, unknown> | null,
  intl: {
    formatMessage: (descriptor: { id: string }) => descriptor.id,
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

afterEach(() => {
  cleanup();
  mocks.services = null;
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
    expect(screen.queryByText(diagnostic)).toBeNull();
    expect(document.querySelector(".text-amber-600, .text-amber-400")).toBeNull();
  });
});
