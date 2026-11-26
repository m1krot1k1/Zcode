import { describe, expect, it, vi } from "vitest";
import type { ZCodeUncensoredGetConfigResult } from "@zcode/shared";
import { syncUncensoredSettingsToTarget } from "@/root/uncensoredRemoteSync.js";

const UNKNOWN = "\u0000";

function localConfig(): ZCodeUncensoredGetConfigResult {
  return {
    providers: [
      {
        id: "p1",
        name: "nano-gpt",
        apiUrl: "https://api.nano-gpt.com/api/v1/chat",
        apiKey: `sk${UNKNOWN}secret`,
        models: [{ id: "deepseek/x:thinking", enabled: true }],
      },
    ],
  };
}

function ports(overrides: {
  local?: ZCodeUncensoredGetConfigResult;
  target?: { providers: { name: string; models: { id: string }[] }[] };
}) {
  const writeTarget = vi.fn(async () => undefined);
  const refreshTarget = vi.fn(async () => undefined);
  return {
    writeTarget,
    refreshTarget,
    ports: {
      readLocal: async () => overrides.local ?? localConfig(),
      readTarget: async () => overrides.target ?? { providers: [] },
      writeTarget,
      refreshTarget,
    },
  };
}

describe("syncUncensoredSettingsToTarget", () => {
  it("переносит провайдеров с ключом и моделями в целевой Environment", async () => {
    const { ports: p, writeTarget, refreshTarget } = ports({});
    await expect(syncUncensoredSettingsToTarget(p)).resolves.toBe("synced");
    expect(writeTarget).toHaveBeenCalledWith({
      providers: [
        {
          id: "p1",
          name: "nano-gpt",
          apiUrl: "https://api.nano-gpt.com/api/v1/chat",
          apiKey: `sk${UNKNOWN}secret`,
          models: [{ id: "deepseek/x:thinking", enabled: true }],
        },
      ],
    });
    expect(refreshTarget).toHaveBeenCalledTimes(1);
  });

  it("не перезаписывает Environment, если набор провайдеров и моделей совпадает", async () => {
    const {
      ports: p,
      writeTarget,
      refreshTarget,
    } = ports({
      target: { providers: [{ name: "nano-gpt", models: [{ id: "deepseek/x:thinking" }] }] },
    });
    await expect(syncUncensoredSettingsToTarget(p)).resolves.toBe("unchanged");
    expect(writeTarget).not.toHaveBeenCalled();
    expect(refreshTarget).not.toHaveBeenCalled();
  });

  it("перезаписывает Environment, если у провайдера другой набор моделей", async () => {
    const { ports: p, writeTarget } = ports({
      target: { providers: [{ name: "nano-gpt", models: [{ id: "other" }] }] },
    });
    await expect(syncUncensoredSettingsToTarget(p)).resolves.toBe("synced");
    expect(writeTarget).toHaveBeenCalledTimes(1);
  });

  it("перезаписывает Environment, если там остался лишний провайдер", async () => {
    const { ports: p, writeTarget } = ports({
      target: {
        providers: [
          { name: "nano-gpt", models: [{ id: "deepseek/x:thinking" }] },
          { name: "stale", models: [] },
        ],
      },
    });
    await expect(syncUncensoredSettingsToTarget(p)).resolves.toBe("synced");
    expect(writeTarget).toHaveBeenCalledTimes(1);
  });

  it("ничего не пишет, если локальной конфигурации нет", async () => {
    const { ports: p, writeTarget } = ports({ local: { providers: [] } });
    await expect(syncUncensoredSettingsToTarget(p)).resolves.toBe("empty");
    expect(writeTarget).not.toHaveBeenCalled();
  });

  it("пробрасывает ошибку записи, не вызывая refresh", async () => {
    const { ports: p, refreshTarget } = ports({});
    p.writeTarget = vi.fn(async () => {
      throw new Error("remote unavailable");
    });
    await expect(syncUncensoredSettingsToTarget(p)).rejects.toThrow("remote unavailable");
    expect(refreshTarget).not.toHaveBeenCalled();
  });
});
