// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ZCodeUncensoredSettingsStatus } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import ruRU from "@/i18n/locales/ru-RU.json" with { type: "json" };
import {
  UncensoredModelSettings,
  type UncensoredModelSettingsPort,
} from "@/settings/model-provider-section/container/UncensoredModelSettings.js";
import { useModelProviderNavigation } from "@/settings/model-provider-section/useModelProviderNavigation.js";

afterEach(cleanup);

beforeAll(() => {
  // Radix Switch measures itself; jsdom has no ResizeObserver.
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

const workspaceRef = {
  workspacePath: "/workspace/demo",
  workspaceIdentity: "workspace-demo",
};

const emptyStatus: ZCodeUncensoredSettingsStatus = { providers: [] };

const configuredStatus: ZCodeUncensoredSettingsStatus = {
  providers: [
    {
      id: "provider-alpha",
      name: "Alpha",
      apiUrl: "https://alpha.example/v1/chat/completions",
      apiKeyConfigured: true,
      models: [
        { id: "model-alpha", enabled: true },
        { id: "model-beta", enabled: false },
      ],
    },
  ],
};

function createPort(initial: ZCodeUncensoredSettingsStatus) {
  const getConfig = vi.fn(async () => initial);
  const updateConfig = vi.fn(
    async (
      _workspace: typeof workspaceRef,
      write: Parameters<UncensoredModelSettingsPort["updateConfig"]>[1],
    ): Promise<ZCodeUncensoredSettingsStatus> => ({
      providers: write.providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        apiUrl: provider.apiUrl,
        apiKeyConfigured:
          provider.apiKey === null
            ? false
            : provider.apiKey !== undefined
              ? true
              : (initial.providers.find((entry) => entry.id === provider.id)?.apiKeyConfigured ??
                false),
        models: provider.models,
      })),
    }),
  );
  return { getConfig, updateConfig };
}

type PortMock = ReturnType<typeof createPort>;

function renderSettings(port: PortMock | undefined, locale: "en-US" | "zh-CN" | "ru-RU" = "en-US") {
  return render(
    <ZCodeIntlProvider initialLocale={locale}>
      <UncensoredModelSettings
        port={port as unknown as UncensoredModelSettingsPort | undefined}
        workspaceRef={workspaceRef}
      />
    </ZCodeIntlProvider>,
  );
}

describe("Uncensored provider settings section", () => {
  it("renders providers, urls, models and the masked key state", async () => {
    const port = createPort(configuredStatus);
    renderSettings(port);

    expect(await screen.findByDisplayValue("Alpha")).toBeTruthy();
    expect((screen.getByTestId("uncensored-provider-url") as HTMLInputElement).value).toBe(
      "https://alpha.example/v1/chat/completions",
    );
    expect(port.getConfig).toHaveBeenCalledWith(workspaceRef);
    expect(screen.getByText("Token saved; leave blank to keep it")).toBeTruthy();

    const idInputs = screen.getAllByTestId("uncensored-model-id") as HTMLInputElement[];
    expect(idInputs.map((input) => input.value)).toEqual(["model-alpha", "model-beta"]);
    const switches = screen.getAllByRole("switch");
    expect(switches[0]?.getAttribute("aria-checked")).toBe("true");
    expect(switches[1]?.getAttribute("aria-checked")).toBe("false");
  });

  it("adds a provider with ordered models and a write-only key, then adopts the masked status", async () => {
    const port = createPort(emptyStatus);
    renderSettings(port);
    await screen.findByTestId("uncensored-provider-add");

    fireEvent.click(screen.getByTestId("uncensored-provider-add"));
    fireEvent.change(screen.getByTestId("uncensored-provider-name"), {
      target: { value: "Fallback" },
    });
    fireEvent.change(screen.getByTestId("uncensored-provider-url"), {
      target: { value: "https://fallback.example/v1/chat/completions" },
    });
    fireEvent.change(screen.getByTestId("uncensored-provider-key"), {
      target: { value: "sk-test" },
    });
    fireEvent.click(screen.getByTestId("uncensored-model-add"));
    fireEvent.change(screen.getAllByTestId("uncensored-model-id")[0]!, {
      target: { value: "model-one" },
    });
    fireEvent.click(screen.getByTestId("uncensored-model-add"));
    fireEvent.change(screen.getAllByTestId("uncensored-model-id")[1]!, {
      target: { value: "model-two" },
    });
    fireEvent.click(screen.getAllByRole("switch")[1]!);
    fireEvent.click(screen.getAllByTestId("uncensored-model-up")[1]!);
    fireEvent.click(screen.getByTestId("uncensored-model-save"));

    expect(await screen.findByText("Settings saved.")).toBeTruthy();
    expect(port.updateConfig).toHaveBeenCalledWith(workspaceRef, {
      providers: [
        {
          id: expect.any(String),
          name: "Fallback",
          apiUrl: "https://fallback.example/v1/chat/completions",
          apiKey: "sk-test",
          models: [
            { id: "model-two", enabled: false },
            { id: "model-one", enabled: true },
          ],
        },
      ],
    });
    // Ключ не хранится в форме после сохранения и не рендерится.
    expect((screen.getByTestId("uncensored-provider-key") as HTMLInputElement).value).toBe("");
    expect(screen.queryByDisplayValue("sk-test")).toBeNull();
  });

  it("omits apiKey for a blank key and sends null when clearing one provider key", async () => {
    const port = createPort(configuredStatus);
    renderSettings(port);
    await screen.findByDisplayValue("Alpha");

    fireEvent.click(screen.getByTestId("uncensored-model-save"));
    await waitFor(() => expect(port.updateConfig).toHaveBeenCalledTimes(1));
    const blankKeyWrite = port.updateConfig.mock.calls[0]![1];
    expect(blankKeyWrite.providers[0]).not.toHaveProperty("apiKey");

    fireEvent.click(await screen.findByTestId("uncensored-provider-clear-key"));
    await waitFor(() => expect(port.updateConfig).toHaveBeenCalledTimes(2));
    expect(port.updateConfig.mock.calls[1]![1].providers[0]).toMatchObject({
      id: "provider-alpha",
      apiKey: null,
    });
  });

  it("blocks saving with an empty provider name, invalid url and empty or duplicate model ids", async () => {
    const port = createPort(emptyStatus);
    renderSettings(port);
    await screen.findByTestId("uncensored-provider-add");

    fireEvent.click(screen.getByTestId("uncensored-provider-add"));
    fireEvent.click(screen.getByTestId("uncensored-model-save"));

    expect(await screen.findByText("Enter a provider name.")).toBeTruthy();
    expect(await screen.findByText("Enter an absolute http(s) URL with a path.")).toBeTruthy();
    expect(port.updateConfig).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId("uncensored-provider-name"), {
      target: { value: "Fallback" },
    });
    fireEvent.change(screen.getByTestId("uncensored-provider-url"), {
      target: { value: "https://fallback.example/v1/chat/completions" },
    });
    fireEvent.click(screen.getByTestId("uncensored-model-add"));
    fireEvent.click(screen.getByTestId("uncensored-model-save"));
    expect(await screen.findByText("Model id must not be empty.")).toBeTruthy();
    expect(port.updateConfig).not.toHaveBeenCalled();

    fireEvent.change(screen.getAllByTestId("uncensored-model-id")[0]!, {
      target: { value: "duplicate-model" },
    });
    fireEvent.click(screen.getByTestId("uncensored-model-add"));
    fireEvent.change(screen.getAllByTestId("uncensored-model-id")[1]!, {
      target: { value: "duplicate-model" },
    });
    fireEvent.click(screen.getByTestId("uncensored-model-save"));

    expect((await screen.findAllByText("Model ids must be unique.")).length).toBe(2);
    expect(port.updateConfig).not.toHaveBeenCalled();
  });

  it("caps the provider list at 20 and the model list at 50", async () => {
    const twentyProviders: ZCodeUncensoredSettingsStatus = {
      providers: Array.from({ length: 20 }, (_, index) => ({
        id: `provider-${index}`,
        name: `Provider ${index}`,
        apiUrl: `https://provider-${index}.example/v1/chat`,
        apiKeyConfigured: false,
        models: [],
      })),
    };
    const port = createPort(twentyProviders);
    renderSettings(port);
    await screen.findByDisplayValue("Provider 0");
    expect(screen.getAllByTestId("uncensored-provider-row")).toHaveLength(20);
    expect((screen.getByTestId("uncensored-provider-add") as HTMLButtonElement).disabled).toBe(true);

    cleanup();
    const portWithModels = createPort({
      providers: [
        {
          id: "provider-a",
          name: "Alpha",
          apiUrl: "https://alpha.example/v1/chat",
          apiKeyConfigured: false,
          models: Array.from({ length: 49 }, (_, index) => ({
            id: `model-${index}`,
            enabled: true,
          })),
        },
      ],
    });
    renderSettings(portWithModels);
    await screen.findByDisplayValue("Alpha");
    fireEvent.click(screen.getByTestId("uncensored-model-add"));
    expect(screen.getAllByTestId("uncensored-model-row")).toHaveLength(50);
    expect((screen.getByTestId("uncensored-model-add") as HTMLButtonElement).disabled).toBe(true);
  });

  it("surfaces save and load failures and retries loading", async () => {
    const port = createPort(emptyStatus);
    port.updateConfig.mockRejectedValueOnce(new Error("write failed"));
    renderSettings(port);
    await screen.findByTestId("uncensored-provider-add");

    fireEvent.click(screen.getByTestId("uncensored-provider-add"));
    fireEvent.change(screen.getByTestId("uncensored-provider-name"), {
      target: { value: "Fallback" },
    });
    fireEvent.change(screen.getByTestId("uncensored-provider-url"), {
      target: { value: "https://fallback.example/v1/chat/completions" },
    });
    fireEvent.click(screen.getByTestId("uncensored-model-save"));
    expect(await screen.findByText("Could not save settings.")).toBeTruthy();

    cleanup();
    const failingPort = {
      getConfig: vi
        .fn()
        .mockRejectedValueOnce(new Error("read failed"))
        .mockResolvedValueOnce(configuredStatus),
      updateConfig: vi.fn(),
    };
    renderSettings(failingPort as unknown as PortMock);
    expect(await screen.findByText("Could not load settings.")).toBeTruthy();
    fireEvent.click(screen.getByTestId("uncensored-model-retry"));
    expect(await screen.findByDisplayValue("Alpha")).toBeTruthy();
    expect(failingPort.getConfig).toHaveBeenCalledTimes(2);
  });

  it("restores saved providers after unmount and remount", async () => {
    const port = createPort(configuredStatus);
    const first = renderSettings(port);
    await screen.findByDisplayValue("Alpha");
    first.unmount();

    renderSettings(port);
    expect(await screen.findByDisplayValue("Alpha")).toBeTruthy();
    const idInputs = screen.getAllByTestId("uncensored-model-id") as HTMLInputElement[];
    expect(idInputs.map((input) => input.value)).toEqual(["model-alpha", "model-beta"]);
  });

  it("renders nothing without the port and gates the navigation item per locale", async () => {
    const { container } = renderSettings(undefined);
    expect(container.firstChild).toBeNull();

    const intlFor = (messages: Record<string, string>) => ({
      formatMessage: ({ id }: { id: string }) => messages[id] ?? id,
    });
    const baseOptions = {
      presetProviders: [],
      modelProviders: [],
      selectedNodeKey: null,
      setSelectedNodeKey: () => {},
      codeIntelligenceAvailable: true,
    };
    const findItem = (groups: Array<{ items: Array<{ key: string; label: string }> }>) =>
      groups
        .flatMap((group) => group.items)
        .find((item) => item.key === "workspace-intelligence:uncensored-models");

    const withoutService = renderHook(() =>
      useModelProviderNavigation({
        ...baseOptions,
        uncensoredSettingsAvailable: false,
        intl: intlFor(enUS),
      }),
    );
    expect(findItem(withoutService.result.current.navigationGroups)).toBeUndefined();
    withoutService.unmount();

    const locales = [
      [enUS, "Uncensored providers"],
      [zhCN, "无审查提供方"],
      [ruRU, "Uncensored провайдеры"],
    ] as const;
    for (const [messages, expected] of locales) {
      const rendered = renderHook(() =>
        useModelProviderNavigation({
          ...baseOptions,
          uncensoredSettingsAvailable: true,
          intl: intlFor(messages),
        }),
      );
      expect(findItem(rendered.result.current.navigationGroups)?.label).toBe(expected);
      rendered.unmount();
    }
  });

  it("keeps settings.uncensored keys in all three catalogs", () => {
    const keys = Object.keys(enUS).filter((key) => key.startsWith("settings.uncensored."));
    expect(keys.length).toBeGreaterThanOrEqual(28);
    for (const key of keys) {
      expect(zhCN[key], `zh-CN missing ${key}`).toBeTruthy();
      expect(ruRU[key], `ru-RU missing ${key}`).toBeTruthy();
    }
    expect(enUS["settings.uncensored.navigationLabel"]).toBe("Uncensored providers");
    expect(zhCN["settings.uncensored.navigationLabel"]).toBe("无审查提供方");
    expect(ruRU["settings.uncensored.navigationLabel"]).toBe("Uncensored провайдеры");
  });

  it("uses only design-system typography tokens in the component source", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "packages/ui/src/settings/model-provider-section/container/UncensoredModelSettings.tsx",
      ),
      "utf8",
    );
    expect(source).not.toMatch(/\btext-(?:base|sm|xs|lg|xl)\b/);
    expect(source).not.toContain("text-[");
    expect(source).not.toContain("fontSize");
    expect(source).toContain("text-ui-settings-title");
  });
});
