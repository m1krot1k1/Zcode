/// <reference types="node" />
import { describe, expect, it } from "vitest";
import {
  createMessageId,
  createPartId,
  createProjectId,
  createSessionId,
  createToolCallId,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../src/storage/index.js";

describe("Increment 4.1 (F-06): SqliteSessionStore diagnostics persistence (finishReason, repairAttempts, rawTruncatedInputPreview, stateTransitions)", () => {
  it("persists and reads assistant finishReason, rawTruncatedInputPreview, repairAttempts, stateTransitions, and tool repair metadata", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    try {
      const sessionID = createSessionId("sess_sqlite_diag");
      const userMessageID = createMessageId("msg_user_diag");
      const assistantMessageID = createMessageId("msg_asst_diag");
      const now = 1_700_000_100_000;

      await store.createSession({
        directory: "/workspace/diag",
        id: sessionID,
        path: "/workspace/diag",
        permission: { mode: "build" },
        projectID: createProjectId("proj_diag"),
        slug: "sqlite-diag",
        time: { created: now, updated: now },
        title: "SQLite Diagnostics",
        titleSource: "custom",
        version: "3.17.122",
      });

      await store.saveMessage({
        agent: "main",
        id: userMessageID,
        role: "user",
        sessionID,
        time: { created: now },
      });

      await store.saveMessage({
        agent: "main",
        cost: 0,
        finish: "length",
        id: assistantMessageID,
        mode: "build",
        parentID: userMessageID,
        path: { cwd: "/workspace/diag", root: "/workspace/diag" },
        rawFinishReason: "max_tokens",
        rawTruncatedInputPreview: '{"file_path":"src/index.ts","content":"unterminated',
        repairAttempts: [
          {
            appliedStages: ["strip_markdown_fences", "fix_trailing_commas"],
            attemptIndex: 0,
            durationMs: 1.25,
            originalRawByteLength: 512,
            repairedSuccessfully: true,
          },
        ],
        role: "assistant",
        sessionID,
        stateTransitions: [
          {
            atMs: now + 5,
            from: "idle",
            reason: "turn_started",
            to: "processing_input",
          },
          {
            atMs: now + 20,
            from: "processing_input",
            reason: "model_request",
            to: "awaiting_model_response",
          },
        ],
        time: { completed: now + 100, created: now + 10 },
        tokens: { cache: { read: 4_096, write: 0 }, input: 8_000, output: 8_192, reasoning: 6_000 },
      });

      await store.savePart({
        callID: createToolCallId("call_diag_1"),
        id: createPartId("part_tool_diag_1"),
        messageID: assistantMessageID,
        sessionID,
        state: {
          error: "TOOL_CALL_TRUNCATED_BY_MAX_TOKENS",
          failureDiagnostics: {
            failureKind: "truncated_by_max_tokens",
            rawTruncatedInputPreview: '{"file_path":"src/index.ts","content":"unterminated',
            rawTruncatedInputTotalBytes: 8_910,
            repairAttempts: [
              {
                appliedStages: ["fix_trailing_commas"],
                attemptIndex: 0,
                durationMs: 0.5,
                originalRawByteLength: 8_910,
                repairedSuccessfully: false,
                remainingValidationErrors: ["Truncated by maxOutputTokens"],
              },
            ],
          },
          input: {},
          status: "error",
          time: { end: now + 80, start: now + 50 },
        },
        tool: "Write",
        type: "tool",
      });

      const hydrated = await store.messages({ sessionID });
      expect(hydrated).toHaveLength(2);

      const savedAssistant = hydrated[1]!;
      expect(savedAssistant.info.role).toBe("assistant");
      if (savedAssistant.info.role === "assistant") {
        expect(savedAssistant.info.finish).toBe("length");
        expect(savedAssistant.info.rawFinishReason).toBe("max_tokens");
        expect(savedAssistant.info.rawTruncatedInputPreview).toBe(
          '{"file_path":"src/index.ts","content":"unterminated',
        );
        expect(savedAssistant.info.repairAttempts).toHaveLength(1);
        expect(savedAssistant.info.repairAttempts?.[0]?.repairedSuccessfully).toBe(true);
        expect(savedAssistant.info.stateTransitions).toHaveLength(2);
      }

      const toolPart = savedAssistant.parts[0];
      expect(toolPart?.type).toBe("tool");
      if (toolPart?.type === "tool" && toolPart.state.status === "error") {
        expect(toolPart.state.failureDiagnostics?.failureKind).toBe("truncated_by_max_tokens");
        expect(toolPart.state.failureDiagnostics?.rawTruncatedInputTotalBytes).toBe(8_910);
        expect(toolPart.state.failureDiagnostics?.repairAttempts?.[0]?.repairedSuccessfully).toBe(
          false,
        );
      }
    } finally {
      store.close();
    }
  });
});
