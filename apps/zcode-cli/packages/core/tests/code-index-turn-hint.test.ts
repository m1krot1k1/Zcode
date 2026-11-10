import { createSessionId } from "@zcode/contracts";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../src/runtime.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import {
  buildCodeIndexTurnHint,
  sharedReadFileStateForChild,
} from "../src/runtime/helpers/runtime-reminders.js";
import { createAgentToolEntry } from "../src/tool/handlers/agent.js";
import { codeIndexToolEntry } from "../src/tool/handlers/code-index.js";
import type { ReadFileStateMap } from "../src/tool/types.js";
import { createTestSessionEventStore } from "./test-event-store.js";

const readyStatus = {
  action: "status" as const,
  status: {
    state: "ready" as const,
    generation: 1,
    counts: { files: 1, chunks: 1, symbols: 1, edges: 0 },
    embedding: { configured: false, available: false },
    diagnostics: [],
  },
};

describe("code index turn hint", () => {
  it("adds a lexical hint when the index is ready and skips it on timeout", async () => {
    const port = {
      query: vi.fn(async (request: { action: string; lexicalOnly?: boolean }) => {
        if (request.action === "status") return readyStatus;
        expect(request.lexicalOnly).toBe(true);
        return {
          action: "search",
          semantic: false,
          partial: false,
          results: [
            {
              path: "src/runtime.ts",
              startLine: 10,
              endLine: 18,
              symbolName: "runTurn",
              excerpt: "function runTurn() { return 1; }",
              match: "lexical",
              score: 1,
            },
          ],
        };
      }),
    };
    const hint = await buildCodeIndexTurnHint({
      port,
      query: "where is runTurn",
      signal: new AbortController().signal,
    });
    expect(hint).toContain("src/runtime.ts:10-18 runTurn");
    expect(hint).toContain("offset = startLine");
    expect(port.query).toHaveBeenCalledTimes(2);

    const slow = {
      query: vi.fn((_request: unknown, context: { signal: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      }),
    };
    await expect(
      buildCodeIndexTurnHint({
        port: slow,
        query: "slow index",
        signal: new AbortController().signal,
      }),
    ).resolves.toBeNull();
  });

  it("does not search while the index is still building", async () => {
    const port = {
      query: vi.fn(async () => ({
        ...readyStatus,
        status: { ...readyStatus.status, state: "indexing" },
      })),
    };
    await expect(
      buildCodeIndexTurnHint({
        port,
        query: "runTurn",
        signal: new AbortController().signal,
      }),
    ).resolves.toBeNull();
    expect(port.query).toHaveBeenCalledTimes(1);
  });
});

describe("code index read contract", () => {
  it("uses the same ranged-read rule in the CodeIndex and Agent tool descriptions", () => {
    expect(codeIndexToolEntry.metadata.description).toContain("offset = startLine");
    expect(createAgentToolEntry().metadata.description).toContain("offset = startLine");
  });

  it("shares the parent read cache only for the same workspace", () => {
    const shared: ReadFileStateMap = new Map();
    expect(sharedReadFileStateForChild("/repo", "/repo/", shared)).toEqual({
      sharedReadFileState: shared,
    });
    expect(sharedReadFileStateForChild("/repo", "/other", shared)).toEqual({});
    const runtime = new AgentRuntime(
      createSessionId("read-cache"),
      { workingDirectory: "/repo" },
      {
        eventStore: createTestSessionEventStore(),
        sharedReadFileState: shared,
      },
    ) as unknown as AgentRuntimeInternal;
    expect(runtime.readFileState).toBe(shared);
  });
});
