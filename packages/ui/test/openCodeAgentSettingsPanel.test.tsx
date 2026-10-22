// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { OpenCodeAgentSettingsPanel } from "@/opencode-agent-settings/OpenCodeAgentSettingsPanel.js";

const mounted: Array<() => void> = [];

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

function renderPanel(runtime: Record<string, unknown>, onEnabledChange = vi.fn(), enabled = false) {
  const view = render(
    <ZCodeIntlProvider initialLocale="en-US">
      <ServiceProvider services={{ openCodeAcpRuntime: runtime } as unknown as IServiceAccessor}>
        <OpenCodeAgentSettingsPanel enabled={enabled} onEnabledChange={onEnabledChange} />
      </ServiceProvider>
    </ZCodeIntlProvider>,
  );
  mounted.push(view.unmount);
  return { onEnabledChange };
}

describe("OpenCode CLI provider settings", () => {
  it("checks the CLI on load and exposes only provider enablement when available", async () => {
    const runtime = {
      getCliStatus: vi.fn(async () => ({
        status: "available" as const,
        version: "1.19.3",
        executablePath: "/some/machine/path/opencode",
      })),
      installCli: vi.fn(),
    };
    const { onEnabledChange } = renderPanel(runtime);

    await screen.findByText("OpenCode CLI detected (1.19.3)");
    expect(runtime.getCliStatus).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("switch", { name: "Enable OpenCode CLI" }).hasAttribute("disabled"),
    ).toBe(false);
    const toggle = screen.getByRole("switch", { name: "Enable OpenCode CLI" });
    fireEvent.click(toggle);
    expect(onEnabledChange).toHaveBeenCalledWith(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("button", { name: "Install OpenCode" })).toBeNull();
    expect(screen.queryByText("Workspace folder")).toBeNull();
    expect(screen.queryByRole("button", { name: "Start OpenCode session" })).toBeNull();
    expect(screen.queryByLabelText("Prompt OpenCode")).toBeNull();
    expect(runtime.installCli).not.toHaveBeenCalled();
  });

  it("shows enablement immediately and restores the off state with a visible error if saving fails", async () => {
    const runtime = {
      getCliStatus: vi.fn(async () => ({
        status: "available" as const,
        version: "1.19.3",
      })),
      installCli: vi.fn(),
    };
    const onEnabledChange = vi.fn(async () => {
      throw new Error("settings write failed");
    });
    renderPanel(runtime, onEnabledChange);

    const toggle = await screen.findByRole("switch", { name: "Enable OpenCode CLI" });
    fireEvent.click(toggle);

    await screen.findByText(
      "Could not save OpenCode CLI. The provider was left disabled; try again.",
    );
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(onEnabledChange).toHaveBeenCalledWith(true);
  });

  it("offers direct installation for a missing CLI and verifies before enabling it", async () => {
    const runtime = {
      getCliStatus: vi
        .fn()
        .mockResolvedValueOnce({
          status: "missing" as const,
          diagnostic: "opencode.cli-missing",
          installSupported: true,
        })
        .mockResolvedValueOnce({
          status: "available" as const,
          version: "1.19.3",
          executablePath: "/user/bin/opencode",
        }),
      installCli: vi.fn(async () => ({
        status: "installed" as const,
        version: "1.19.3",
        executablePath: "/user/bin/opencode",
      })),
    };
    const { onEnabledChange } = renderPanel(runtime);

    await screen.findByText("OpenCode CLI is not installed");
    const installButton = screen.getByRole("button", {
      name: "Install OpenCode",
    });
    fireEvent.click(installButton);
    await screen.findByText("OpenCode CLI detected (1.19.3)");
    expect(runtime.installCli).toHaveBeenCalledOnce();
    expect(runtime.getCliStatus).toHaveBeenCalledTimes(2);
    expect(onEnabledChange).toHaveBeenCalledWith(true);
  });

  it("does not offer installation when this platform is unsupported", async () => {
    const runtime = {
      getCliStatus: vi.fn(async () => ({
        status: "missing" as const,
        diagnostic: "opencode.install-platform-unsupported",
        installSupported: false,
      })),
      installCli: vi.fn(),
    };
    renderPanel(runtime);

    await screen.findByText(/Automatic installation is not available/u);
    expect(screen.queryByRole("button", { name: "Install OpenCode" })).toBeNull();
    expect(
      screen.getByRole("switch", { name: "Enable OpenCode CLI" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(runtime.installCli).not.toHaveBeenCalled();
  });

  it("renders a safe fixed diagnostic and allows a retry when detection fails", async () => {
    const runtime = {
      getCliStatus: vi
        .fn()
        .mockRejectedValueOnce(new Error("/private/user/path/token"))
        .mockResolvedValueOnce({
          status: "available" as const,
          version: "1.19.3",
          executablePath: "/user/bin/opencode",
        }),
      installCli: vi.fn(),
    };
    renderPanel(runtime);

    await screen.findByText("OpenCode CLI could not be checked");
    expect(screen.queryByText(/private\/user\/path/u)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("OpenCode CLI detected (1.19.3)");
    expect(runtime.getCliStatus).toHaveBeenCalledTimes(2);
  });
});
