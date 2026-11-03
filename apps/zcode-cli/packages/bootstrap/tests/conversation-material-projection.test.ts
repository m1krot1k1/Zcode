import { describe, expect, it } from "vitest";
import {
  buildUserInputRow,
  classifyTurnInterruptReason,
} from "../src/zcode-protocol-v4/projection-rows.js";

describe("conversation material projection", () => {
  it.each(["", "weather?"])("keeps model-only bot instructions out of visible body %j", (text) => {
    const source = { botId: "bot", chatId: "chat", provider: "feishu" as const };
    const row = buildUserInputRow(
      { rowId: 1, turnId: "turn", createdAt: 1, createdAtSeq: 1 },
      {
        input: "expanded model material",
        intent: { kind: "sendText", text, botGroupSource: source },
      },
    );
    expect(row.text).toBe(text);
    expect(row.botGroupSource).toEqual(source);
    expect(row.conversationQuotes).toBeUndefined();
  });
});

describe("classifyTurnInterruptReason", () => {
  it("preserveQueueAutoDrainOnCancel 视为用户主动停止", () => {
    expect(
      classifyTurnInterruptReason({
        resultType: "cancelled",
        abortReason: "v4 sendQueuedNow preempts active turn",
        preserveQueueAutoDrainOnCancel: true,
      }),
    ).toEqual({ interruptReason: "user" });
  });

  it.each([
    ["Root run token budget exhausted", "token budget"],
    ["Root run time budget exhausted", "time budget"],
    // admission 拒绝预留时的真实原文带 rootRunId（session:turn）后缀，必须整句归类为 budget，
    // 否则会落到 error 分支并把 session/turn id 透给 UI。
    ["Root run resource budget is exhausted: session_1:turn_1", "resource budget"],
    ["root run resource budget exhausted", "resource budget"],
  ])("预算耗尽 %j → budget", (abortReason, detail) => {
    expect(classifyTurnInterruptReason({ resultType: "cancelled", abortReason })).toEqual({
      interruptReason: "budget",
      interruptDetail: detail,
    });
  });

  it.each([
    "ZCode Protocol owner disconnected",
    "v4 sendQueuedNow preempts active turn",
    "ZCode Protocol runtime stopping",
  ])("抢占原因 %j → preempted", (abortReason) => {
    expect(classifyTurnInterruptReason({ resultType: "cancelled", abortReason })).toEqual({
      interruptReason: "preempted",
    });
  });

  it("v4 session stopped → user", () => {
    expect(
      classifyTurnInterruptReason({ resultType: "cancelled", abortReason: "v4 session stopped" }),
    ).toEqual({ interruptReason: "user" });
  });

  it("未知原因归为 error 并截断到 240", () => {
    const result = classifyTurnInterruptReason({
      resultType: "cancelled",
      abortReason: "x".repeat(300),
    });
    expect(result.interruptReason).toBe("error");
    expect(result.interruptDetail).toHaveLength(240);
  });

  it("无原因与非 cancelled 结果不写字段", () => {
    expect(classifyTurnInterruptReason({ resultType: "cancelled" })).toEqual({});
    expect(classifyTurnInterruptReason({ resultType: "success", abortReason: "boom" })).toEqual({});
  });

  it("异常输入不抛错", () => {
    expect(() =>
      classifyTurnInterruptReason({ resultType: "cancelled", abortReason: undefined }),
    ).not.toThrow();
  });
});
