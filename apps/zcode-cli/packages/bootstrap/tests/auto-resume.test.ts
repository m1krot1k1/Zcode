import type { MessageWithParts } from "@zcode/contracts";
import { describe, expect, it } from "vitest";
import {
  AUTO_RESUME_PROMPT_PREFIX,
  findInterruptedUserMessage,
} from "../src/zcode-protocol/auto-resume.js";

function userMessage(id: string, text: string): MessageWithParts {
  return {
    info: { id, role: "user" },
    parts: [{ type: "text", text }],
  } as unknown as MessageWithParts;
}

function toolMessage(status: "pending" | "running" | "completed"): MessageWithParts {
  return {
    info: { id: "assistant", role: "assistant" },
    parts: [{ type: "tool", tool: "Bash", state: { status } }],
  } as unknown as MessageWithParts;
}

describe("auto-resume interrupted turn", () => {
  it("finds the last user submission when no tool is pending", () => {
    expect(
      findInterruptedUserMessage([
        userMessage("old", "old request"),
        userMessage("last", "implement the feature"),
        toolMessage("completed"),
      ]),
    ).toEqual({
      messageId: "last",
      text: "implement the feature",
      hasPendingTool: false,
    });
  });

  it("blocks auto-resume when a tool outcome is unknown", () => {
    expect(
      findInterruptedUserMessage([
        userMessage("last", "implement the feature"),
        toolMessage("running"),
      ])?.hasPendingTool,
    ).toBe(true);
  });

  it("does not auto-resume its own continuation prompt", () => {
    expect(
      findInterruptedUserMessage([
        userMessage("auto", `${AUTO_RESUME_PROMPT_PREFIX} Continue the interrupted task.`),
      ]),
    ).toBeUndefined();
  });

  it("returns undefined when there is no user text", () => {
    expect(findInterruptedUserMessage([])).toBeUndefined();
    expect(
      findInterruptedUserMessage([
        {
          info: { id: "assistant", role: "assistant" },
          parts: [{ type: "text", text: "answer" }],
        } as unknown as MessageWithParts,
      ]),
    ).toBeUndefined();
  });
});
