import { describe, expect, it } from "vitest";
import { coalesceConsecutiveZCodeAssistants } from "../src/zcodePersistedMessageMerge.js";
import { deserializeZcodeSessionFile, serializeZcodeSessionFile } from "../src/validation.js";

describe("Increment 4.1 (F-06): .zcode-session diagnostics serialization & backward compatibility", () => {
  it("serializes and deserializes finishReason, rawTruncatedInputPreview, repairAttempts, and stateTransitions in .zcode-session", () => {
    const serialized = serializeZcodeSessionFile({
      meta: {
        createdAt: 1_700_000_000_000,
        mode: "default",
        provider: "claude",
        taskId: "task_diag_roundtrip",
        title: "Session diagnostics roundtrip",
        traceId: "trace_diag_roundtrip",
        updatedAt: 1_700_000_001_000,
        workspacePath: "/workspace/project",
      },
      messages: [
        {
          content: "Create module",
          id: "msg_user_1",
          role: "user",
          timestamp: 1_700_000_000_100,
        },
        {
          content: "Splitting file creation after token truncation...",
          finishReason: "length",
          id: "msg_asst_1",
          rawTruncatedInputPreview: '{"file_path":"src/big.ts","content":"export const x =',
          repairAttempts: [
            {
              appliedStages: ["strip_markdown_fences", "coerce_scalar_types_by_schema"],
              attemptIndex: 0,
              durationMs: 1.5,
              originalRawByteLength: 240,
              repairedSuccessfully: true,
            },
          ],
          role: "assistant",
          stateTransitions: [
            {
              atMs: 1_700_000_000_120,
              from: "idle",
              reason: "turn_started",
              to: "processing_input",
            },
            {
              atMs: 1_700_000_000_150,
              from: "processing_input",
              reason: "model_request",
              to: "awaiting_model_response",
            },
          ],
          timestamp: 1_700_000_000_200,
          tools: [
            {
              input: { file_path: "src/big.ts" },
              rawTruncatedInputPreview: '{"file_path":"src/big.ts","content":"export const x =',
              repairAttempts: [
                {
                  appliedStages: ["fix_trailing_commas"],
                  attemptIndex: 0,
                  durationMs: 0.8,
                  originalRawByteLength: 128,
                  repairedSuccessfully: false,
                  remainingValidationErrors: ["content: Required"],
                },
              ],
              status: "failed",
              toolName: "Write",
            },
          ],
        },
      ],
      stateTransitions: [
        {
          atMs: 1_700_000_000_120,
          from: "idle",
          reason: "turn_started",
          to: "processing_input",
        },
        {
          atMs: 1_700_000_000_900,
          from: "streaming_response",
          reason: "completed",
          to: "completing",
        },
      ],
    });

    const restored = deserializeZcodeSessionFile(serialized);
    const assistant = restored.messages[1]!;

    expect(assistant.finishReason).toBe("length");
    expect(assistant.rawTruncatedInputPreview).toBe(
      '{"file_path":"src/big.ts","content":"export const x =',
    );
    expect(assistant.repairAttempts).toHaveLength(1);
    expect(assistant.repairAttempts?.[0]?.repairedSuccessfully).toBe(true);
    expect(assistant.repairAttempts?.[0]?.appliedStages).toEqual([
      "strip_markdown_fences",
      "coerce_scalar_types_by_schema",
    ]);
    expect(assistant.stateTransitions).toHaveLength(2);
    expect(assistant.tools?.[0]?.rawTruncatedInputPreview).toContain("src/big.ts");
    expect(assistant.tools?.[0]?.repairAttempts?.[0]?.remainingValidationErrors).toEqual([
      "content: Required",
    ]);
    expect(restored.stateTransitions).toHaveLength(2);
  });

  it("maintains 100% backward compatibility when reading legacy .zcode-session files without diagnostic fields", () => {
    const legacyRawJson = JSON.stringify({
      meta: {
        createdAt: 100,
        mode: "default",
        provider: "codex",
        taskId: "legacy_task_01",
        title: "Legacy session archive",
        traceId: "legacy_trace_01",
        updatedAt: 200,
        workspacePath: "/legacy/repo",
      },
      messages: [
        {
          content: "Hello",
          role: "user",
          timestamp: 110,
        },
        {
          content: "Done",
          role: "assistant",
          timestamp: 150,
          tools: [
            {
              input: { file_path: "README.md" },
              output: "# Title",
              status: "completed",
              toolName: "Read",
            },
          ],
        },
      ],
    });

    const parsedLegacy = deserializeZcodeSessionFile(legacyRawJson);
    expect(parsedLegacy.meta.taskId).toBe("legacy_task_01");
    expect(parsedLegacy.messages).toHaveLength(2);
    expect(parsedLegacy.messages[1]?.finishReason).toBeUndefined();
    expect(parsedLegacy.messages[1]?.repairAttempts).toBeUndefined();
    expect(parsedLegacy.stateTransitions).toBeUndefined();
  });

  it("preserves repairAttempts, stateTransitions, and finishReason when coalescing multi-step assistant turns", () => {
    const coalesced = coalesceConsecutiveZCodeAssistants([
      {
        content: "Fix it",
        id: "u1",
        role: "user",
        timestamp: 10,
      },
      {
        content: "Step 1 ",
        finishReason: "length",
        id: "a1",
        rawTruncatedInputPreview: '{"partial":true',
        repairAttempts: [
          {
            appliedStages: ["fix_trailing_commas"],
            attemptIndex: 0,
            durationMs: 1,
            originalRawByteLength: 40,
            repairedSuccessfully: true,
          },
        ],
        role: "assistant",
        stateTransitions: [{ atMs: 11, from: "idle", to: "processing_input" }],
        timestamp: 12,
      },
      {
        content: "Step 2",
        finishReason: "stop",
        id: "a2",
        repairAttempts: [
          {
            appliedStages: ["coerce_scalar_types_by_schema"],
            attemptIndex: 1,
            durationMs: 2,
            originalRawByteLength: 60,
            repairedSuccessfully: true,
          },
        ],
        role: "assistant",
        stateTransitions: [{ atMs: 20, from: "streaming_response", to: "completing" }],
        timestamp: 20,
      },
    ]);

    expect(coalesced).toHaveLength(2);
    const mergedAssistant = coalesced[1]!;
    expect(mergedAssistant.finishReason).toBe("stop");
    expect(mergedAssistant.rawTruncatedInputPreview).toBe('{"partial":true');
    expect(mergedAssistant.repairAttempts).toHaveLength(2);
    expect(mergedAssistant.stateTransitions).toHaveLength(2);
  });
});
