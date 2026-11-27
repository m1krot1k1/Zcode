import { describe, expect, it } from "vitest";

import { cliCoreTakeoverToolsModule } from "./module.js";
import { TAKEOVER_TOOL_ROUNDS, takeoverRoundMessages } from "./tools.js";

// Контракт не зависит от реализации: проверяем манифест и форму раунда.
describe("cli-core-takeover-tools contract", () => {
  it("объявляет ровно свой публичный вход и не даёт циклов", () => {
    expect(cliCoreTakeoverToolsModule.publicEntrypoints).toEqual(["index.ts", "contract.ts"]);
    expect(cliCoreTakeoverToolsModule.requires).not.toContain("cli-core-takeover-tools");
  });

  it("раунд несёт assistant с вызовами и tool-результаты", () => {
    const messages = takeoverRoundMessages(
      "Смотрю порты",
      [{ id: "c1", name: "Bash", input: { command: "ls" } }],
      [{ toolCallId: "c1", toolName: "Bash", content: "ok", isError: false }],
    );
    expect(messages.map((message) => message.role)).toEqual(["assistant", "tool"]);
    expect(messages[0]?.content).toContain("Bash");
    expect(TAKEOVER_TOOL_ROUNDS).toBeGreaterThan(0);
  });
});
