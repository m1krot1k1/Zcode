// @vitest-environment jsdom

import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeIndexStatus } from "../src/agent-workbench/contract.js";

const mocks = vi.hoisted(() => ({
  services: null as Record<string, unknown> | null,
  intl: {
    formatMessage: (descriptor: { id: string }, values?: Record<string, string | number>) => {
      if (descriptor.id === "codeGraph.kind.function") return "Функция";
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

vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  const noop = () => null;
  return {
    Background: noop,
    BackgroundVariant: { Dots: "dots" },
    Controls: noop,
    MarkerType: { ArrowClosed: "arrowclosed" },
    MiniMap: noop,
    ReactFlow: ({
      nodes,
      edges,
      onNodeClick,
    }: {
      nodes: Array<{ id: string; data: { name: string } }>;
      edges?: Array<{ id: string; type?: string; style?: { stroke?: string } }>;
      onNodeClick?: (event: unknown, node: { id: string }) => void;
    }) =>
      React.createElement(
        "div",
        null,
        (edges ?? []).map((edge) =>
          React.createElement("span", {
            key: edge.id,
            "data-testid": "code-graph-edge",
            "data-stroke": edge.style?.stroke ?? "",
            "data-type": edge.type ?? "",
          }),
        ),
        nodes.map((node) =>
          React.createElement(
            "button",
            { key: node.id, onClick: (event: unknown) => onNodeClick?.(event, node) },
            node.data.name,
          ),
        ),
      ),
    Handle: ({
      className,
      type,
      position,
    }: {
      className?: string;
      type?: string;
      position?: string;
    }) =>
      React.createElement("span", {
        "data-testid": "code-graph-handle",
        "data-handle": type,
        "data-position": position,
        className,
      }),
    Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  };
});

import { CodeGraphExplorer } from "../src/agent-workbench/CodeGraphExplorer.js";
import { CODE_GRAPH_NODE_TYPES, createGraphNodes } from "../src/agent-workbench/CodeGraphNodes.js";

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
    await waitFor(() =>
      expect(screen.getAllByText("codeGraph.statusFailed").length).toBeGreaterThan(0),
    );
    expect(screen.queryByText("codeGraph.loading")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "codeGraph.retryStatus" }));
    await screen.findByText("1 file");
    await waitFor(() => expect(codeIndex.getGraphOverview).toHaveBeenCalledOnce());
  });

  it("filters node kinds in the bounded graph slice", async () => {
    const status = {
      state: "ready",
      partial: false,
      generation: 1,
      counts: { files: 1, chunks: 1, symbols: 1, edges: 0 },
      embedding: { configured: false, available: false, phase: "not-configured" },
      diagnostics: [],
    } satisfies CodeIndexStatus;
    const graph = {
      nodes: [
        {
          id: "src/a.ts::fn:run",
          name: "run",
          kind: "function",
          path: "src/a.ts",
          startLine: 4,
          degree: 0,
        },
      ],
      edges: [],
      partial: false,
    };
    const getGraphOverview = vi.fn().mockResolvedValue(graph);
    mocks.services = {
      codeIntelligenceService: {
        getStatus: vi.fn().mockResolvedValue(status),
        watchWorkspace: vi.fn(() => new Promise<void>(() => undefined)),
        getGraphOverview,
      },
    };

    render(createElement(CodeGraphExplorer, { workspacePath: "/workspace" }));
    const workspace = screen.getByTestId("usage-code-graph");
    expect(workspace.getAttribute("data-layout")).toBe("workspace");
    expect(workspace.className).toContain("flex-1");
    expect(workspace.className).toContain("lg:h-full");
    expect(workspace.className).toContain("lg:min-h-0");
    expect(workspace.className).toContain("@container/code-graph");
    const grid = workspace.querySelector(".grid");
    expect(grid?.className).toContain(
      "@min-[700px]/code-graph:grid-cols-[120px_minmax(0,1fr)_168px]",
    );
    expect(grid?.className).toContain(
      "@min-[960px]/code-graph:grid-cols-[180px_minmax(0,1fr)_260px]",
    );
    expect(grid?.className).toContain(
      "@min-[1200px]/code-graph:grid-cols-[208px_minmax(0,1fr)_300px]",
    );
    expect(screen.getByTestId("usage-code-graph-canvas").className).toContain(
      "@min-[700px]/code-graph:h-full",
    );
    expect(screen.getByTestId("usage-code-graph-canvas").className).toContain(
      "@min-[700px]/code-graph:min-h-0",
    );
    expect(
      screen.getByRole("heading", { name: "codeGraph.filters" }).closest("aside")?.className,
    ).toContain("@min-[700px]/code-graph:order-none");
    expect(
      screen.getByRole("heading", { name: "codeGraph.inspector" }).closest("aside")?.className,
    ).toContain("@min-[700px]/code-graph:order-none");
    await waitFor(() => expect(getGraphOverview).toHaveBeenCalled());
    expect(getGraphOverview.mock.calls[0]?.[0]).toMatchObject({ limit: 60 });
    const kindFilter = await screen.findByRole("button", { name: /Функция/ });
    expect(screen.queryByText("function")).toBeNull();
    expect(kindFilter.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(kindFilter);
    expect(await screen.findByText("codeGraph.noNodes")).toBeTruthy();
    expect(kindFilter.getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps the last successful graph visible when refresh fails", async () => {
    const status = {
      state: "ready",
      partial: false,
      generation: 1,
      counts: { files: 1, chunks: 1, symbols: 1, edges: 0 },
      embedding: { configured: false, available: false, phase: "not-configured" },
      diagnostics: [],
    } satisfies CodeIndexStatus;
    const graph = {
      nodes: [
        {
          id: "src/a.ts::fn:run",
          name: "run",
          kind: "function",
          path: "src/a.ts",
          startLine: 4,
          degree: 0,
        },
      ],
      edges: [],
      partial: false,
    };
    const getGraphOverview = vi
      .fn()
      .mockResolvedValueOnce(graph)
      .mockRejectedValueOnce(new Error("offline"));
    mocks.services = {
      codeIntelligenceService: {
        getStatus: vi.fn().mockResolvedValue(status),
        watchWorkspace: vi.fn(() => new Promise<void>(() => undefined)),
        getGraphOverview,
      },
    };

    render(createElement(CodeGraphExplorer, { workspacePath: "/workspace" }));
    await screen.findAllByText("run");
    fireEvent.click(screen.getByRole("button", { name: "codeGraph.refresh" }));
    await screen.findByText("codeGraph.loadFailed");
    expect(screen.getAllByText("run").length).toBeGreaterThan(0);
  });

  it("stops the initial graph spinner after an overview failure and retries successfully", async () => {
    const status = {
      state: "ready",
      partial: false,
      generation: 1,
      counts: { files: 1, chunks: 1, symbols: 1, edges: 0 },
      embedding: { configured: false, available: false, phase: "not-configured" },
      diagnostics: [],
    } satisfies CodeIndexStatus;
    const graph = {
      nodes: [
        {
          id: "src/a.ts::fn:run",
          name: "run",
          kind: "function",
          path: "src/a.ts",
          startLine: 4,
          degree: 0,
        },
      ],
      edges: [],
      partial: false,
    };
    const getGraphOverview = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(graph);
    mocks.services = {
      codeIntelligenceService: {
        getStatus: vi.fn().mockResolvedValue(status),
        watchWorkspace: vi.fn(() => new Promise<void>(() => undefined)),
        getGraphOverview,
      },
    };

    render(createElement(CodeGraphExplorer, { workspacePath: "/workspace" }));
    await waitFor(() => expect(getGraphOverview).toHaveBeenCalledOnce());
    await screen.findByRole("button", { name: "codeGraph.retryStatus" });
    expect(screen.getByTestId("usage-code-graph-canvas").textContent).toContain(
      "codeGraph.loadFailed",
    );
    expect(screen.getByTestId("usage-code-graph-canvas").textContent).not.toContain(
      "codeGraph.loading",
    );

    fireEvent.click(screen.getByRole("button", { name: "codeGraph.retryStatus" }));
    await waitFor(() => expect(getGraphOverview).toHaveBeenCalledTimes(2));
    await screen.findAllByText("run");
    expect(screen.getByTestId("usage-code-graph-canvas").textContent).not.toContain(
      "codeGraph.loadFailed",
    );
  });

  it("searches indexed code, opens the symbol inspector, and focuses its relationship slice", async () => {
    const status = {
      state: "ready",
      partial: true,
      generation: 3,
      counts: { files: 2, chunks: 2, symbols: 2, edges: 1 },
      embedding: { configured: true, available: true, phase: "ready" },
      diagnostics: ["partial coverage"],
    } satisfies CodeIndexStatus;
    const caller = {
      id: "src/caller.ts::fn:caller",
      name: "caller",
      kind: "function",
      path: "src/caller.ts",
      startLine: 2,
      degree: 1,
    };
    const target = {
      id: "src/target.ts::fn:target",
      name: "target",
      kind: "function",
      path: "src/target.ts",
      startLine: 8,
      degree: 1,
    };
    const overview = {
      nodes: [caller, target],
      edges: [{ source: caller.id, target: target.id, relation: "calls" as const }],
      partial: true,
    };
    const focusedOverview = { ...overview, focusId: target.id };
    const codeIndex = {
      getStatus: vi.fn().mockResolvedValue(status),
      watchWorkspace: vi.fn(() => new Promise<void>(() => undefined)),
      getGraphOverview: vi.fn().mockResolvedValueOnce(overview).mockResolvedValue(focusedOverview),
      search: vi.fn().mockResolvedValue({
        results: [{ path: target.path, startLine: target.startLine, symbolName: target.name }],
      }),
    };
    mocks.services = { codeIntelligenceService: codeIndex };

    render(createElement(CodeGraphExplorer, { workspacePath: "/workspace" }));
    await screen.findByRole("button", { name: "caller" });
    expect(screen.getByTestId("code-graph-edge").getAttribute("data-stroke")).toBe(
      "var(--color-terminal-bright-cyan)",
    );
    expect(screen.getByTestId("code-graph-edge").getAttribute("data-type")).toBe("default");
    expect(screen.getByText("codeGraph.partial")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "caller" }));
    expect(screen.getByText("src/caller.ts:2")).toBeTruthy();
    expect(screen.getByText("codeGraph.outgoing")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "target" })).toHaveLength(2);

    const search = screen.getByTestId("usage-code-graph-search");
    fireEvent.change(search, { target: { value: "target implementation" } });
    fireEvent.click(screen.getByRole("button", { name: "codeGraph.search" }));
    await screen.findByRole("button", { name: /target.*src\/target.ts:8/ });
    expect(codeIndex.search).toHaveBeenCalledWith(
      expect.objectContaining({ query: "target implementation", limit: 12 }),
    );
    fireEvent.click(screen.getByRole("button", { name: /target.*src\/target.ts:8/ }));
    await waitFor(() => expect(codeIndex.getGraphOverview).toHaveBeenCalledTimes(2));
    expect(codeIndex.getGraphOverview).toHaveBeenLastCalledWith(
      expect.objectContaining({
        focus: { symbol: "target", path: target.path, startLine: target.startLine },
      }),
    );
    await screen.findByText("src/target.ts:8");
  });

  it("spreads symbols and draws visible handles with the symbol name on the node", () => {
    const nodes = Array.from({ length: 12 }, (_, index) => ({
      id: `n${index}`,
      name: `symbol${index}`,
      kind: "function",
      path: "src/a.ts",
      startLine: index + 1,
      degree: 12 - index,
    }));
    const edges = nodes.slice(1).map((node, index) => ({
      source: nodes[index]!.id,
      target: node.id,
      relation: "calls" as const,
    }));
    const placed = createGraphNodes({ nodes, edges, partial: false }, nodes[0]!.id, (id) => id);
    const xs = placed.map((node) => node.position.x);
    const ys = placed.map((node) => node.position.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(400);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(40);
    expect(new Set(placed.map((node) => `${node.position.x}:${node.position.y}`)).size).toBe(
      placed.length,
    );
    expect(placed[0]?.selected).toBe(true);

    const NodeView = CODE_GRAPH_NODE_TYPES.codeSymbol!;
    render(
      createElement(NodeView, {
        id: "n0",
        data: placed[0]!.data,
        selected: true,
        type: "codeSymbol",
        dragging: false,
        zIndex: 0,
        selectable: true,
        deletable: false,
        draggable: false,
        isConnectable: false,
        positionAbsoluteX: 0,
        positionAbsoluteY: 0,
      }),
    );
    expect(screen.getByText("symbol0")).toBeTruthy();
    const handles = screen.getAllByTestId("code-graph-handle");
    expect(handles).toHaveLength(2);
    for (const handle of handles) {
      expect(handle.className).not.toContain("opacity-0");
      expect(handle.className).toContain("bg-foreground");
    }
  });
});
