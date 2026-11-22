import { describe, expect, it } from "vitest";
import { BROWSER_TELEMETRY_DEFAULTS } from "./contract.js";
import { cliBrowserTelemetryModule } from "./module.js";

describe("cli-browser-telemetry contract", () => {
  it("объявляет модуль с публичными входами index/contract", () => {
    expect(cliBrowserTelemetryModule.id).toBe("cli-browser-telemetry");
    expect(cliBrowserTelemetryModule.publicEntrypoints).toEqual(["index.ts", "contract.ts"]);
    // Зависимость от общего контракта наблюдения (@zcode/shared/browser-use):
    // схема BrowserActionObservation живёт в shared, поэтому requires не пуст.
    expect(cliBrowserTelemetryModule.requires).toEqual(["shared"]);
  });

  it("по умолчанию оставляет диалог агенту с защитным таймаутом", () => {
    // Политика record + таймаут: агент может ответить на confirm/prompt,
    // но зависший диалог не блокирует страницу вечно.
    expect(BROWSER_TELEMETRY_DEFAULTS.dialogPolicy).toBe("record");
    expect(BROWSER_TELEMETRY_DEFAULTS.dialogAutoDismissMs).toBeGreaterThan(0);
  });

  it("по умолчанию не прикладывает кадр к здоровому наблюдению", () => {
    expect(BROWSER_TELEMETRY_DEFAULTS.screenshotAlways).toBe(false);
  });

  it("потолок микро-стабилизации больше окна тишины", () => {
    expect(BROWSER_TELEMETRY_DEFAULTS.maxSettleMs).toBeGreaterThan(
      BROWSER_TELEMETRY_DEFAULTS.quietWindowMs,
    );
  });
});
