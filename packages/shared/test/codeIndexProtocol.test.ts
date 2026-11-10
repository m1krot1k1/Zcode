import { describe, expect, it } from "vitest";
import {
  zcodeCodeIndexQueryParamsSchema,
  zcodeCodeIndexQueryResultSchema,
} from "../src/zcode-protocol/index.js";

describe("CodeIndex protocol contract", () => {
  it("accepts bounded read-only queries and rejects paths outside the workspace", () => {
    expect(
      zcodeCodeIndexQueryParamsSchema.safeParse({ sessionId: "session-1", action: "status" })
        .success,
    ).toBe(true);
    expect(
      zcodeCodeIndexQueryParamsSchema.safeParse({
        sessionId: "session-1",
        action: "search",
        query: "AgentRuntime",
        limit: 12,
      }).success,
    ).toBe(true);
    for (const changedPath of ["/etc/passwd", "C:\\Users\\secret.ts", "../outside.ts"]) {
      expect(
        zcodeCodeIndexQueryParamsSchema.safeParse({
          sessionId: "session-1",
          action: "impact",
          changedPaths: [changedPath],
        }).success,
      ).toBe(false);
    }
  });

  it("accepts a capped chunk excerpt and a lexical-only search", () => {
    const excerpt = "x".repeat(4000);
    expect(
      zcodeCodeIndexQueryResultSchema.safeParse({
        action: "search",
        semantic: false,
        partial: false,
        results: [
          {
            path: "src/wide.ts",
            startLine: 1,
            endLine: 40,
            excerpt,
            excerptTruncated: true,
            match: "lexical",
            score: 1,
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      zcodeCodeIndexQueryParamsSchema.safeParse({
        sessionId: "session-1",
        action: "search",
        query: "wideExcerpt",
        lexicalOnly: true,
      }).success,
    ).toBe(true);
    expect(
      zcodeCodeIndexQueryResultSchema.safeParse({
        action: "search",
        semantic: false,
        partial: false,
        results: [
          {
            path: "src/wide.ts",
            startLine: 1,
            endLine: 40,
            excerpt: "x".repeat(4097),
            match: "lexical",
            score: 1,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects Host-local embedding endpoints in agent-visible status", () => {
    expect(
      zcodeCodeIndexQueryResultSchema.safeParse({
        action: "status",
        status: {
          state: "ready",
          generation: 1,
          counts: { files: 1, chunks: 1, symbols: 1, edges: 0 },
          embedding: {
            configured: true,
            model: "nomic-embed-text",
            available: true,
            endpoint: "http://127.0.0.1:11434/api/embed",
          },
          diagnostics: [],
        },
      }).success,
    ).toBe(false);
  });
});
