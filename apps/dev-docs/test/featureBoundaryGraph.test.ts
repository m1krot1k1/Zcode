import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  getFeatureBoundaryGraphStats,
  getFeatureBoundaryNeighborhood,
  type FeatureBoundaryGraph,
} from "@/data/featureBoundaryGraph.js";
import { normalizeFeatureBoundaryGraph } from "@/data/featureBoundaryGraphSource.js";

const fixture: FeatureBoundaryGraph = {
  schemaVersion: 1,
  graphId: "fixture",
  purpose: "test",
  nodes: [
    {
      id: "capability.alpha",
      kind: "capability",
      label: "Alpha",
      aliases: [],
      docs: [],
      codeSeeds: [],
      invariants: [],
    },
    {
      id: "service.beta",
      kind: "service",
      label: "Beta",
      aliases: [],
      docs: [],
      codeSeeds: [],
      invariants: [],
    },
    {
      id: "state.gamma",
      kind: "state-owner",
      label: "Gamma",
      aliases: [],
      docs: [],
      codeSeeds: [],
      invariants: [],
    },
  ],
  edges: [
    {
      from: "capability.alpha",
      to: "service.beta",
      type: "served-by",
      rank: "must-inspect",
    },
    {
      from: "state.gamma",
      to: "capability.alpha",
      type: "projects-to",
      rank: "should-inspect",
    },
  ],
};

describe("feature boundary graph helpers", () => {
  it("保留节点、边和按类型统计", () => {
    expect(getFeatureBoundaryGraphStats(fixture)).toEqual({
      nodeCount: 3,
      edgeCount: 2,
      unresolvedEndpointCount: 0,
      kindCounts: {
        capability: 1,
        service: 1,
        "state-owner": 1,
      },
    });
  });

  it("返回选中节点的一阶邻居，并补出未声明端点", () => {
    const graph: FeatureBoundaryGraph = {
      ...fixture,
      edges: [
        ...fixture.edges,
        {
          from: "capability.alpha",
          to: "missing.delta",
          type: "depends-on",
          rank: "conditional",
        },
      ],
    };

    const neighborhood = getFeatureBoundaryNeighborhood(graph, "capability.alpha");
    expect(neighborhood.nodes.map((node) => node.id)).toEqual([
      "capability.alpha",
      "service.beta",
      "state.gamma",
      "missing.delta",
    ]);
    expect(neighborhood.edges).toHaveLength(3);
    expect(neighborhood.edges[2]).toMatchObject({
      source: "capability.alpha",
      target: "missing.delta",
    });
  });

  it("解析当前 feature boundary YAML 并保留未声明端点", async () => {
    const source = await readFile(
      resolve(
        process.cwd(),
        "../../.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml",
      ),
      "utf8",
    );
    const raw = parseYaml(source) as {
      nodes: Array<{ id: string }>;
      edges: Array<{ from: string; to: string }>;
    };
    const graph = normalizeFeatureBoundaryGraph(raw);
    const stats = getFeatureBoundaryGraphStats(graph);

    // 期望值从 YAML 本身推导，避免图增长后固定数字（此前是 324/629）变成永久失败。
    // 同时校验真实的图不变量：id 唯一、normalize 不丢节点、边数不变、未声明端点
    // 集合与 unresolved 节点完全一致。这些断言在空图或重复 id 时也会失败。
    const declaredIds = raw.nodes.map((node) => node.id);
    expect(declaredIds.length).toBeGreaterThan(0);
    expect(raw.edges.length).toBeGreaterThan(0);
    expect(new Set(declaredIds).size).toBe(declaredIds.length);

    const declaredIdSet = new Set(declaredIds);
    const missingEndpoints = new Set<string>();
    for (const edge of raw.edges) {
      for (const endpoint of [edge.from, edge.to]) {
        if (!declaredIdSet.has(endpoint)) missingEndpoints.add(endpoint);
      }
    }

    expect(stats.nodeCount).toBe(declaredIds.length + missingEndpoints.size);
    expect(stats.edgeCount).toBe(raw.edges.length);
    expect(stats.unresolvedEndpointCount).toBe(missingEndpoints.size);
    expect(graph.nodes.filter((node) => node.kind === "unresolved").map((node) => node.id)).toEqual(
      [...missingEndpoints].sort(),
    );
  });
});
