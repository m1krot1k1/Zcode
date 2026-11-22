import { describe, expect, it, vi } from "vitest";
import { LocalCliProviderCatalogSource } from "../src/model-provider/providerRuntime.js";
import type { ObservableSettingService } from "../src/setting/observableSettingService.js";

function settingsService(values: {
  openCodeCliEnabled?: boolean;
  cursorCliEnabled?: boolean;
}): ObservableSettingService {
  return {
    get: async () => values,
    onDidUpdate: () => () => {},
  } as unknown as ObservableSettingService;
}

const availableOpenCode = {
  getCliStatus: async () => ({
    status: "available" as const,
    version: "1.19.3",
    executablePath: "/tmp/opencode",
  }),
  listModels: async () => ({
    status: "available" as const,
    authentication: "not-checked" as const,
    models: [
      {
        modelId: "anthropic/claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
        reasoningVariants: ["low", "high", "max"] as const,
        inputFormat: {
          supportsText: true,
          supportsImage: true,
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: false,
        },
        outputSupportsText: true,
      },
    ],
  }),
};

const availableCursor = {
  getCliStatus: async () => ({
    status: "available" as const,
    version: "2025.09.25",
    executablePath: "/Users/me/.local/bin/cursor-agent",
  }),
  listModels: async () => ({
    status: "available" as const,
    authentication: "not-checked" as const,
    models: [
      { modelId: "composer-1", name: "Composer 1", source: "cli" as const },
      { modelId: "claude-4.5-sonnet", name: "Claude 4.5 Sonnet", source: "cli" as const },
    ],
  }),
};

const missingCli = {
  getCliStatus: async () => ({
    status: "missing" as const,
    diagnostic: "not-found",
    installCommand: "curl https://cursor.com/install -fsS | bash",
  }),
  listModels: async () => ({ status: "unavailable" as const, diagnostic: "not-found" }),
};

describe("LocalCliProviderCatalogSource", () => {
  it("публикует пустой snapshot при выключенных настройках", async () => {
    const source = new LocalCliProviderCatalogSource(
      settingsService({}),
      availableOpenCode,
      availableCursor,
    );
    const snapshot = await source.read();
    expect(snapshot.providers).toEqual([]);
    expect(snapshot.cliExecutablePath).toBeUndefined();
    expect(snapshot.cliExecutablePaths).toBeUndefined();
  });

  it("публикует Cursor отдельно без OpenCode", async () => {
    const source = new LocalCliProviderCatalogSource(
      settingsService({ cursorCliEnabled: true }),
      availableOpenCode,
      availableCursor,
    );
    const snapshot = await source.read();
    expect(snapshot.providers.map((provider) => provider.providerId)).toEqual(["cursor"]);
    const [provider] = snapshot.providers;
    expect(provider?.providerName).toBe("Cursor CLI");
    expect(provider?.config.access.toJSON()).toEqual({ type: "local-auth" });
    expect(provider?.config.api.toJSON()).toEqual({ type: "cursor-cli" });
    expect(provider?.models.map((model) => model.modelId)).toEqual([
      "composer-1",
      "claude-4.5-sonnet",
    ]);
    expect(snapshot.cliExecutablePaths).toEqual({
      cursor: "/Users/me/.local/bin/cursor-agent",
    });
    expect(snapshot.cliExecutablePath).toBeUndefined();
  });

  it("публикует оба CLI и сохраняет путь каждого", async () => {
    const source = new LocalCliProviderCatalogSource(
      settingsService({ openCodeCliEnabled: true, cursorCliEnabled: true }),
      availableOpenCode,
      availableCursor,
    );
    const snapshot = await source.read();
    expect(snapshot.providers.map((provider) => provider.providerId)).toEqual([
      "opencode",
      "cursor",
    ]);
    expect(snapshot.cliExecutablePath).toBe("/tmp/opencode");
    expect(snapshot.cliExecutablePaths).toEqual({
      opencode: "/tmp/opencode",
      cursor: "/Users/me/.local/bin/cursor-agent",
    });
  });

  it("не публикует Cursor при отсутствии бинаря и не скрывает OpenCode", async () => {
    const source = new LocalCliProviderCatalogSource(
      settingsService({ openCodeCliEnabled: true, cursorCliEnabled: true }),
      availableOpenCode,
      missingCli,
    );
    const snapshot = await source.read();
    expect(snapshot.providers.map((provider) => provider.providerId)).toEqual(["opencode"]);
    expect(snapshot.cliExecutablePaths).toEqual({ opencode: "/tmp/opencode" });
  });

  it("сбой Cursor-каталога не ломает публикацию OpenCode", async () => {
    const failingCursor = {
      getCliStatus: async () => {
        throw new Error("boom");
      },
      listModels: async () => {
        throw new Error("boom");
      },
    };
    const source = new LocalCliProviderCatalogSource(
      settingsService({ openCodeCliEnabled: true, cursorCliEnabled: true }),
      availableOpenCode,
      failingCursor,
    );
    const snapshot = await source.read();
    expect(snapshot.providers.map((provider) => provider.providerId)).toEqual(["opencode"]);
  });

  it("инвалидируется при изменении cursorCliEnabled", async () => {
    let listener: ((event: { keys: readonly string[] }) => void) | undefined;
    const settings = {
      get: async () => ({ cursorCliEnabled: true }),
      onDidUpdate: (next: (event: { keys: readonly string[] }) => void) => {
        listener = next;
        return () => {};
      },
    } as unknown as ObservableSettingService;
    const source = new LocalCliProviderCatalogSource(settings, undefined, availableCursor);
    const onChange = vi.fn();
    source.onDidChange(onChange);
    listener?.({ keys: ["cursorCliEnabled"] });
    expect(onChange).toHaveBeenCalledWith("setting-updated");
  });
});
