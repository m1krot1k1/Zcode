// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { CursorAgentSettingsPanel } from "@/cursor-agent-settings/CursorAgentSettingsPanel.js";

const mounted: Array<() => void> = [];

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

function renderPanel(runtime: Record<string, unknown>, onEnabledChange = vi.fn(), enabled = false) {
  const view = render(
    <ZCodeIntlProvider initialLocale="en-US">
      <ServiceProvider services={{ cursorCliRuntime: runtime } as unknown as IServiceAccessor}>
        <CursorAgentSettingsPanel enabled={enabled} onEnabledChange={onEnabledChange} />
      </ServiceProvider>
    </ZCodeIntlProvider>,
  );
  mounted.push(view.unmount);
  return { onEnabledChange };
}

describe("Cursor CLI provider settings", () => {
  it("shows the detected version and the Host model catalog, and saves enablement", async () => {
    const runtime = {
      getCliStatus: vi.fn(async () => ({
        status: "available" as const,
        version: "2025.11.1",
        executablePath: "/some/machine/path/cursor-agent",
      })),
      listModels: vi.fn(async () => ({
        status: "available" as const,
        authentication: "not-checked" as const,
        models: [
          { modelId: "composer-1", name: "Composer 1", source: "cli" as const },
          { modelId: "claude-4.5-sonnet", name: "Claude 4.5 Sonnet", source: "cli" as const },
        ],
      })),
    };
    const { onEnabledChange } = renderPanel(runtime);

    await screen.findByText("Cursor CLI detected (2025.11.1)");
    expect(runtime.getCliStatus).toHaveBeenCalledOnce();
    expect(runtime.listModels).toHaveBeenCalledOnce();
    expect(await screen.findByText("2 models available")).toBeTruthy();
    expect(screen.getByText("Composer 1")).toBeTruthy();
    expect(screen.getByText("Claude 4.5 Sonnet")).toBeTruthy();

    const toggle = screen.getByRole("switch", { name: "Enable Cursor CLI" });
    expect(toggle.hasAttribute("disabled")).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect(onEnabledChange).toHaveBeenCalledWith(true));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("installs via the official installer, re-checks and enables the provider", async () => {
    const runtime = {
      getCliStatus: vi
        .fn()
        .mockResolvedValueOnce({
          status: "missing" as const,
          diagnostic: "cursor.cli-missing",
          installCommand: "curl https://cursor.com/install -fsS | bash",
        })
        .mockResolvedValueOnce({
          status: "available" as const,
          version: "2025.11.1",
          executablePath: "/user/bin/cursor-agent",
        }),
      listModels: vi.fn(async () => ({
        status: "available" as const,
        authentication: "not-checked" as const,
        models: [{ modelId: "composer-1", name: "Composer 1", source: "cli" as const }],
      })),
      installCli: vi.fn(async () => ({
        status: "installed" as const,
        version: "2025.11.1",
        executablePath: "/user/bin/cursor-agent",
      })),
    };
    const { onEnabledChange } = renderPanel(runtime);

    fireEvent.click(await screen.findByTestId("cursor-cli-install"));
    await waitFor(() => expect(runtime.installCli).toHaveBeenCalledOnce());
    await waitFor(() => expect(onEnabledChange).toHaveBeenCalledWith(true));
    expect(await screen.findByText("Cursor CLI detected (2025.11.1)")).toBeTruthy();
  });

  it("reports a failed install without enabling the provider", async () => {
    const runtime = {
      getCliStatus: vi.fn(async () => ({
        status: "missing" as const,
        diagnostic: "cursor.cli-missing",
        installCommand: "curl https://cursor.com/install -fsS | bash",
      })),
      listModels: vi.fn(async () => ({
        status: "available" as const,
        authentication: "not-checked" as const,
        models: [{ modelId: "composer-1", name: "Composer 1", source: "cli" as const }],
      })),
      installCli: vi.fn(async () => ({
        status: "failed" as const,
        diagnostic: "install-verification-failed",
        installCommand: "curl https://cursor.com/install -fsS | bash",
      })),
    };
    const { onEnabledChange } = renderPanel(runtime);

    fireEvent.click(await screen.findByTestId("cursor-cli-install"));
    await waitFor(() => expect(runtime.installCli).toHaveBeenCalledOnce());
    expect(
      await screen.findByText(/installer finished, but cursor-agent is still not available/i),
    ).toBeTruthy();
    expect(onEnabledChange).not.toHaveBeenCalled();
  });

  it("shows the fixed diagnostic and install command when the CLI is missing and re-checks on demand", async () => {
    const runtime = {
      getCliStatus: vi
        .fn()
        .mockResolvedValueOnce({
          status: "missing" as const,
          diagnostic: "cursor.cli-missing",
          installCommand: "curl https://cursor.com/install -fsS | bash",
        })
        .mockResolvedValueOnce({
          status: "available" as const,
          version: "2025.11.1",
          executablePath: "/user/bin/cursor-agent",
        }),
      listModels: vi.fn(async () => ({
        status: "available" as const,
        authentication: "not-checked" as const,
        models: [{ modelId: "composer-1", name: "Composer 1", source: "cli" as const }],
      })),
    };
    renderPanel(runtime);

    await screen.findByText("Cursor CLI is not installed");
    expect(screen.getByTestId("cursor-cli-diagnostic").textContent).toBe("cursor.cli-missing");
    expect(screen.getByTestId("cursor-cli-install-command").textContent).toBe(
      "curl https://cursor.com/install -fsS | bash",
    );
    // Установка доступна по кнопке (как у OpenCode), рядом остаётся официальная команда.
    expect(screen.getByRole("button", { name: "Install Cursor CLI" })).toBeTruthy();
    expect(runtime.listModels).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await screen.findByText("Cursor CLI detected (2025.11.1)");
    expect(runtime.getCliStatus).toHaveBeenCalledTimes(2);
    expect(runtime.listModels).toHaveBeenCalledOnce();
  });

  it("keeps the switch usable when the Host channel is absent but disables retry", async () => {
    const view = render(
      <ZCodeIntlProvider initialLocale="en-US">
        <ServiceProvider services={{} as unknown as IServiceAccessor}>
          <CursorAgentSettingsPanel enabled={false} onEnabledChange={vi.fn()} />
        </ServiceProvider>
      </ZCodeIntlProvider>,
    );
    mounted.push(view.unmount);

    await screen.findByText("Cursor CLI is unavailable on the Host that owns this workspace");
    expect(screen.getByRole("switch", { name: "Enable Cursor CLI" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  });

  it("restores the off state with a visible error when saving fails", async () => {
    const runtime = {
      getCliStatus: vi.fn(async () => ({
        status: "available" as const,
        version: "2025.11.1",
        executablePath: "/user/bin/cursor-agent",
      })),
      listModels: vi.fn(async () => ({
        status: "available" as const,
        authentication: "not-checked" as const,
        models: [],
      })),
    };
    const onEnabledChange = vi.fn(async () => {
      throw new Error("settings write failed");
    });
    renderPanel(runtime, onEnabledChange);

    const toggle = await screen.findByRole("switch", { name: "Enable Cursor CLI" });
    fireEvent.click(toggle);

    await screen.findByText(
      "Could not save Cursor CLI. The provider was left disabled; try again.",
    );
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(onEnabledChange).toHaveBeenCalledWith(true);
  });
});
