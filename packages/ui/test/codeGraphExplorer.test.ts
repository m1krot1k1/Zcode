// @vitest-environment jsdom

import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeIndexStatus } from "../src/agent-workbench/contract.js";

const mocks = vi.hoisted(() => ({
  services: null as Record<string, unknown> | null,
  intl: {
    formatMessage: (descriptor: { id: string }, values?: Record<string, string | number>) => {
      if (descriptor.id === "codeGraph.files") {
        const count = values?.count ?? 0;
        return `${count} file${count === 1 ? "" : "s"}`;
      }
      if (descriptor.id === "codeGraph.symbols") return `${values?.count ?? 0} symbols`;
      if (descriptor.id === "codeGraph.links") return `${values?.count ?? 0} links`;
      return descriptor.id;
    },
  },
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => mocks.services,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: mocks.intl }),
}));

import { CodeGraphExplorer } from "../src/agent-workbench/CodeGraphExplorer.js";

afterEach(() => {
  cleanup();
  mocks.services = null;
});

describe("CodeGraphExplorer status loading", () => {
  it("does not show zero counts while status loads and offers retry after a status failure", async () => {
    let rejectInitialStatus!: (reason: unknown) => void;
    const initialStatus = new Promise<CodeIndexStatus>((_resolve, reject) => {
      rejectInitialStatus = reject;
    });
    const readyStatus = {
      state: "ready",
      partial: false,
      generation: 1,
      counts: { files: 1, chunks: 1, symbols: 1, edges: 0 },
      embedding: { configured: false, available: false, phase: "not-configured" },
      diagnostics: [],
    } satisfies CodeIndexStatus;
    const codeIndex = {
      getStatus: vi.fn().mockReturnValueOnce(initialStatus).mockResolvedValue(readyStatus),
      watchWorkspace: vi.fn(() => new Promise<void>(() => undefined)),
      getGraphOverview: vi.fn(() => new Promise(() => undefined)),
    };
    mocks.services = { codeIntelligenceService: codeIndex };

    render(createElement(CodeGraphExplorer, { workspacePath: "/workspace" }));
    expect(screen.getAllByText("codeGraph.statusLoading").length).toBeGreaterThan(0);
    expect(screen.queryByText("0 files")).toBeNull();

    await act(async () => rejectInitialStatus(new Error("status unavailable")));
    await waitFor(() => expect(screen.getAllByText("codeGraph.statusFailed").length).toBeGreaterThan(0));
    expect(screen.queryByText("codeGraph.loading")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "codeGraph.retryStatus" }));
    await screen.findByText("1 file");
    await waitFor(() => expect(codeIndex.getGraphOverview).toHaveBeenCalledOnce());
  });
});
