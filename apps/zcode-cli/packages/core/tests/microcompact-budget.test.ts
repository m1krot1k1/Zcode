import { describe, expect, it } from "vitest";
import {
  buildDefaultMicrocompactThreshold,
  getAutoCompactThreshold,
  maybeLocalMicrocompactMessages,
  type LocalMicrocompactMessage,
} from "../src/compact/index.js";

function buildToolRound(
  index: number,
  toolName: "Read" | "Bash" | "Grep",
  input: Record<string, unknown>,
  payloadChunk: string,
): LocalMicrocompactMessage[] {
  const id = `call_${toolName.toLowerCase()}_${index}`;
  return [
    {
      content: "",
      role: "assistant",
      toolCalls: [{ id, input, name: toolName }],
    },
    {
      content: payloadChunk.repeat(180),
      role: "tool",
      toolCallId: id,
      toolName,
    },
  ];
}

describe("Increment 4.1 (F-04): effective working context ceiling & quantized cache-friendly microcompact", () => {
  it("uses the full model window in auto mode and still honors an explicit lower ceiling", () => {
    const oneMillionAutoThreshold = getAutoCompactThreshold({
      contextWindow: 1_000_000,
    });
    // 1M - 21K output reserve - 13K buffer.
    expect(oneMillionAutoThreshold).toBe(966_000);

    const defaultMicroThreshold = buildDefaultMicrocompactThreshold(oneMillionAutoThreshold);
    expect(defaultMicroThreshold).toBe(Math.floor(966_000 * 0.9));
    // 0 — это auto, а не «порог ноль»: иначе microcompact маскировал бы всё сразу.
    expect(buildDefaultMicrocompactThreshold(oneMillionAutoThreshold, 0)).toBe(
      Math.floor(966_000 * 0.9),
    );

  });

  it("masks stale Read / Bash / Grep observations with target metadata + sha256 in quantized group steps", () => {
    const baseRounds: LocalMicrocompactMessage[] = [
      ...buildToolRound(1, "Read", { file_path: "src/engine.ts" }, "read-body-line-1 "),
      ...buildToolRound(2, "Bash", { command: "pnpm test:unit" }, "stdout-log-entry "),
      ...buildToolRound(3, "Grep", { pattern: "executeTurn" }, "grep-match-row "),
      ...buildToolRound(4, "Read", { file_path: "src/turn.ts" }, "read-body-line-4 "),
      ...buildToolRound(5, "Read", { file_path: "src/recent-5.ts" }, "recent-5-data "),
      ...buildToolRound(6, "Read", { file_path: "src/recent-6.ts" }, "recent-6-data "),
    ];

    const resolveInput = (msg: LocalMicrocompactMessage) => {
      if (msg.toolCallId === "call_read_1") return { file_path: "src/engine.ts" };
      if (msg.toolCallId === "call_bash_2") return { command: "pnpm test:unit" };
      if (msg.toolCallId === "call_grep_3") return { pattern: "executeTurn" };
      if (msg.toolCallId === "call_read_4") return { file_path: "src/turn.ts" };
      return undefined;
    };

    const atSixRounds = maybeLocalMicrocompactMessages({
      config: {
        groupQuantum: 4,
        keepRecentToolResults: 2,
        minTokenSavings: 1,
        thresholdTokens: 1,
      },
      messages: baseRounds,
      resolveToolInput: resolveInput,
    });

    // С groupQuantum=4 и 6 кандидатами (keepRecent=2 -> 4 кандидата на очистку) ровно 1 квант (4 группы) замаскирован.
    expect(String(atSixRounds.messages[1]?.content)).toContain("Read path=src/engine.ts");
    expect(String(atSixRounds.messages[1]?.content)).toContain("sha256=");
    expect(String(atSixRounds.messages[3]?.content)).toContain("Bash");
    expect(String(atSixRounds.messages[3]?.content)).toContain("sha256=");
    expect(String(atSixRounds.messages[5]?.content)).toContain("Grep");
    expect(String(atSixRounds.messages[5]?.content)).toContain("sha256=");

    // Добавление одного нового шага (#7: 7 кандидатов, keepRecent=2 -> 5 кандидатов, кратно groupQuantum=4 даёт всё те же 4!)
    // НЕ должно маскировать группу #5 и ломать закэшированный префикс на одиночном ходу!
    const atSevenRounds = maybeLocalMicrocompactMessages({
      config: {
        groupQuantum: 4,
        keepRecentToolResults: 2,
        minTokenSavings: 1,
        thresholdTokens: 1,
      },
      messages: [
        ...atSixRounds.messages,
        ...buildToolRound(7, "Read", { file_path: "src/recent-7.ts" }, "recent-7-data "),
      ],
      resolveToolInput: resolveInput,
    });

    expect(atSevenRounds.messages.slice(0, atSixRounds.messages.length)).toEqual(
      atSixRounds.messages,
    );
  });
});
