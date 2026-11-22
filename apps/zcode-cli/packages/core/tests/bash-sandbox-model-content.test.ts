import { describe, expect, it } from "vitest";
import { formatBashModelContent } from "../src/tool/handlers/bash-model-content.js";

const base = {
  interrupted: false,
  isImage: false,
  noOutputExpected: false,
  status: "completed",
  stderr: "",
  stdout: "ok",
};

describe("Bash model content: фактическая песочница", () => {
  // Причина фикса: структурное поле `sandbox` доходило до UI/телеметрии, но не
  // попадало в текст для модели, хотя системный промпт Bash обещает `sandbox.mode`.
  it("показывает фактический режим изоляции в тексте для модели", () => {
    const content = formatBashModelContent({
      ...base,
      sandbox: { filesystemIsolated: true, mode: "bwrap", networkIsolated: false },
    });
    expect(typeof content).toBe("string");
    expect(content).toContain("sandbox: mode=bwrap");
    expect(content).toContain("filesystemIsolated=true");
    expect(content).toContain("networkIsolated=false");
  });

  it("показывает причину деградации, когда песочница недоступна", () => {
    const content = formatBashModelContent({
      ...base,
      sandbox: {
        filesystemIsolated: false,
        mode: "degraded",
        networkIsolated: false,
        reason: "bwrap is not installed",
      },
    });
    expect(content).toContain("mode=degraded");
    expect(content).toContain("reason: bwrap is not installed");
  });

  it("не добавляет строку песочницы, если адаптер её не сообщил", () => {
    const content = formatBashModelContent({ ...base });
    expect(content).not.toContain("[sandbox:");
    expect(content).toBe("ok");
  });
});
