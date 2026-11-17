import { describe, expect, it } from "vitest";
import { LINUX_CUA_DEFAULTS } from "./contract.js";
import { servicesCuaLinuxHostModule } from "./module.js";

describe("services-cua-linux-host contract", () => {
  it("объявляет managed-модуль с публичными входами", () => {
    expect(servicesCuaLinuxHostModule.id).toBe("services-cua-linux-host");
    expect(servicesCuaLinuxHostModule.publicEntrypoints).toEqual(["index.ts", "contract.ts"]);
    // Зависимость ровно одна — общий сервисный логгер из unmanaged-корня services.
    expect(servicesCuaLinuxHostModule.requires).toEqual(["services"]);
  });

  it("держит бюджет кадра и потолки ожидания явными", () => {
    expect(LINUX_CUA_DEFAULTS.maxFrameBytes).toBeGreaterThan(0);
    expect(LINUX_CUA_DEFAULTS.captureTimeoutMs).toBeGreaterThan(0);
    expect(LINUX_CUA_DEFAULTS.portalTimeoutMs).toBeGreaterThan(0);
    // Кэш probe не должен быть нулевым: иначе каждый клик перепроверяет окружение.
    expect(LINUX_CUA_DEFAULTS.probeCacheMs).toBeGreaterThan(0);
  });
});
