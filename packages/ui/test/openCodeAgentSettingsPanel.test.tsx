// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { OpenCodeAgentSettingsPanel } from "@/opencode-agent-settings/OpenCodeAgentSettingsPanel.js";
import type { OpenCodeAgentConfigOption } from "@/opencode-agent-settings/contract.js";

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined;

const modelOption = (): OpenCodeAgentConfigOption => ({
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "zen/free-model",
  options: [
    { value: "zen/free-model", name: "Free model" },
    { value: "local/test", name: "Local test" },
  ],
});

const modeOption = (): OpenCodeAgentConfigOption => ({
  id: "mode",
  name: "Agent",
  category: "mode",
  type: "select",
  currentValue: "build",
  options: [
    { value: "build", name: "Build" },
    { value: "plan", name: "Plan" },
  ],
});

const testResources: Array<() => void> = [];

afterEach(() => {
  for (const dispose of testResources.splice(0)) dispose();
});

describe("OpenCode agent settings panel", () => {
  it("shows a safe actionable diagnostic when the local ACP service cannot start", async () => {
    const runtime = {
      getCliStatus: vi.fn(async () => ({
        status: "available" as const,
        version: "OpenCode 1.19.3",
        executablePath: "/usr/local/bin/opencode",
      })),
      startSession: vi.fn(async () => {
        throw new Error("opencode.acp-local-server-unavailable");
      }),
      disposeAllAndWait: vi.fn(async () => undefined),
    };
    const services = { openCodeAcpRuntime: runtime } as unknown as IServiceAccessor;
    const platform = {
      selectDirectory: vi.fn(async () => "/workspace"),
      openExternal: vi.fn(),
    } as unknown as IPlatformService;
    const view = render(
      <ZCodeIntlProvider initialLocale="en-US">
        <ServiceProvider services={services}>
          <PlatformProvider platform={platform}>
            <OpenCodeAgentSettingsPanel
              initialWorkspacePath="/workspace"
              remoteWorkspaceActive={false}
            />
          </PlatformProvider>
        </ServiceProvider>
      </ZCodeIntlProvider>,
    );
    testResources.push(view.unmount);

    await screen.findByText("OpenCode CLI detected (OpenCode 1.19.3)");
    expect(screen.getByText("Local CLI · no API key")).toBeTruthy();
    fireEvent.click(await screen.findByTestId("opencode-start-session"));
    await screen.findByText(
      "OpenCode could not start its local service. Check that local network access is available, then retry.",
    );
    expect(runtime.startSession).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/test-only-opencode-stderr-secret/u)).toBeNull();
  });

  it("localizes a CLI that disappears after the availability check", async () => {
    const runtime = {
      getCliStatus: vi.fn(async () => ({
        status: "available" as const,
        version: "OpenCode 1.19.3",
        executablePath: "/usr/local/bin/opencode",
      })),
      startSession: vi.fn(async () => {
        throw new Error("opencode.cli-missing");
      }),
      disposeAllAndWait: vi.fn(async () => undefined),
    };
    const services = { openCodeAcpRuntime: runtime } as unknown as IServiceAccessor;
    const platform = {
      selectDirectory: vi.fn(async () => "/workspace"),
      openExternal: vi.fn(),
    } as unknown as IPlatformService;
    const view = render(
      <ZCodeIntlProvider initialLocale="en-US">
        <ServiceProvider services={services}>
          <PlatformProvider platform={platform}>
            <OpenCodeAgentSettingsPanel
              initialWorkspacePath="/workspace"
              remoteWorkspaceActive={false}
            />
          </PlatformProvider>
        </ServiceProvider>
      </ZCodeIntlProvider>,
    );
    testResources.push(view.unmount);

    await screen.findByText("OpenCode CLI detected (OpenCode 1.19.3)");
    fireEvent.click(await screen.findByTestId("opencode-start-session"));
    await screen.findByText(
      "OpenCode CLI could not be started because it is no longer available. Install it or select its executable, then retry.",
    );
  });

  it("starts only on explicit action and requires applying the live model and mode before prompting", async () => {
    const sessionId = "session-1";
    let options = [modelOption(), modeOption()];
    let publishUpdate: ((update: unknown) => void) | undefined;
    const permissionEmitter = new Emitter<
      | {
          type: "requested";
          request: {
            requestId: string;
            sessionId: string;
            toolTitle: string;
            toolKind: string;
            inputSummary: string;
            options: Array<{
              optionId: string;
              kind: "allow_once" | "allow_always" | "reject_once";
              name: string;
            }>;
          };
        }
      | { type: "resolved"; requestId: string; sessionId: string }
    >();
    let finishPrompt: (() => void) | undefined;
    let permissionSequence = 0;
    let activePermissionId = "";
    const runtime = {
      getCliStatus: vi.fn(async () => ({
        status: "available" as const,
        version: "OpenCode 1.19.3",
        executablePath: "/usr/local/bin/opencode",
      })),
      installCli: vi.fn(async () => ({
        status: "failed" as const,
        diagnostic: "opencode.install-failed",
      })),
      startSession: vi.fn(async ({ cwd }: { cwd: string }) => ({
        sessionId,
        cwd,
        configOptions: options,
      })),
      setConfigOption: vi.fn(
        async ({ configId, value }: { configId: string; value: string | boolean }) => {
          const current = options.find((option) => option.id === configId);
          if (current?.type === "select" && typeof value === "string") current.currentValue = value;
          options = [...options];
          return { sessionId, cwd: "/workspace", configOptions: options };
        },
      ),
      prompt: vi.fn(async () => {
        const requestId = `permission-${++permissionSequence}`;
        activePermissionId = requestId;
        permissionEmitter.fire({
          type: "requested",
          request: {
            requestId,
            sessionId,
            toolTitle: "Run shell command",
            toolKind: "execute",
            inputSummary: '{"command":"echo approved"}',
            options: [
              { optionId: "allow-once", kind: "allow_once", name: "Run this command once" },
              { optionId: "allow-always", kind: "allow_always", name: "Always allow command" },
              { optionId: "reject-once", kind: "reject_once", name: "Reject this command once" },
            ],
          },
        });
        await new Promise<void>((resolve) => (finishPrompt = resolve));
        return { stopReason: "end_turn" };
      }),
      cancel: vi.fn(async () => {
        permissionEmitter.fire({
          type: "resolved",
          requestId: activePermissionId,
          sessionId,
        });
        finishPrompt?.();
      }),
      respondToPermission: vi.fn(
        async ({ requestId }: { requestId: string; sessionId: string; optionId: string }) => {
          permissionEmitter.fire({ type: "resolved", requestId, sessionId });
          finishPrompt?.();
        },
      ),
      closeSession: vi.fn(async () => undefined),
      onSessionUpdate: vi.fn(() => (listener: (update: unknown) => void) => {
        publishUpdate = listener;
        return {
          dispose: () => {
            publishUpdate = undefined;
          },
        };
      }),
      onPermissionEvent: vi.fn(() => permissionEmitter.event),
      disposeAllAndWait: vi.fn(async () => undefined),
    };
    const services = { openCodeAcpRuntime: runtime } as unknown as IServiceAccessor;
    const platform = {
      selectDirectory: vi.fn(async () => "/workspace"),
      openExternal: vi.fn(),
    } as unknown as IPlatformService;
    const view = render(
      <ZCodeIntlProvider initialLocale="en-US">
        <ServiceProvider services={services}>
          <PlatformProvider platform={platform}>
            <OpenCodeAgentSettingsPanel
              initialWorkspacePath="/workspace"
              remoteWorkspaceActive={false}
            />
          </PlatformProvider>
        </ServiceProvider>
      </ZCodeIntlProvider>,
    );
    testResources.push(view.unmount);

    await screen.findByText("OpenCode CLI detected (OpenCode 1.19.3)");
    expect(runtime.startSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("opencode-start-session"));
    await screen.findByTestId("opencode-session-panel");

    const prompt = screen.getByLabelText("Prompt OpenCode");
    expect((prompt as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("combobox", { name: "Model from OpenCode" }));
    fireEvent.click(await screen.findByRole("option", { name: "Local test" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply model selection" }));
    await waitFor(() =>
      expect(runtime.setConfigOption).toHaveBeenCalledWith({
        sessionId,
        configId: "model",
        value: "local/test",
      }),
    );
    expect((prompt as HTMLTextAreaElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("combobox", { name: "Agent mode from OpenCode" }));
    fireEvent.click(await screen.findByRole("option", { name: "Plan" }));
    await waitFor(() =>
      expect(runtime.setConfigOption).toHaveBeenCalledWith({
        sessionId,
        configId: "mode",
        value: "plan",
      }),
    );
    expect((prompt as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Apply model selection" }));
    await waitFor(() => expect((prompt as HTMLTextAreaElement).disabled).toBe(false));

    fireEvent.change(prompt, { target: { value: "Please inspect this workspace" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to OpenCode" }));
    await waitFor(() =>
      expect(runtime.prompt).toHaveBeenCalledWith({
        sessionId,
        text: "Please inspect this workspace",
      }),
    );
    const permissionPanel = await screen.findByTestId("opencode-permission-requests");
    expect(within(permissionPanel).getByText("Run shell command")).toBeTruthy();
    expect(within(permissionPanel).getByText('{"command":"echo approved"}')).toBeTruthy();
    expect(runtime.respondToPermission).not.toHaveBeenCalled();
    fireEvent.click(
      within(permissionPanel).getByRole("button", {
        name: "Always allow command",
      }),
    );
    await waitFor(() =>
      expect(runtime.respondToPermission).toHaveBeenCalledWith({
        sessionId,
        requestId: "permission-1",
        optionId: "allow-always",
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("opencode-permission-requests")).toBeNull());
    publishUpdate?.({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Fake agent reply" },
    });
    await within(screen.getByTestId("opencode-transcript")).findByText("Fake agent reply");

    fireEvent.change(prompt, { target: { value: "Check cancellation clears pending permission" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to OpenCode" }));
    const secondPermissionPanel = await screen.findByTestId("opencode-permission-requests");
    expect(
      within(secondPermissionPanel).getByRole("button", {
        name: "Reject this command once",
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel OpenCode run" }));
    await waitFor(() => expect(screen.queryByTestId("opencode-permission-requests")).toBeNull());
    expect(runtime.cancel).toHaveBeenCalledWith({ sessionId });
  });

  it("requires explicit confirmation when ACP exposes no selectable model", async () => {
    const sessionId = "default-session";
    const permissionEmitter = new Emitter<
      | {
          type: "requested";
          request: {
            requestId: string;
            sessionId: string;
            toolTitle: string;
            options: Array<{
              optionId: string;
              kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
              name: string;
            }>;
          };
        }
      | { type: "resolved"; requestId: string; sessionId: string }
    >();
    const runtime = {
      getCliStatus: vi.fn(async () => ({
        status: "available" as const,
        version: "OpenCode 1.19.3",
        executablePath: "/usr/local/bin/opencode",
      })),
      startSession: vi.fn(async ({ cwd }: { cwd: string }) => ({
        sessionId,
        cwd,
        configOptions: [modeOption()],
      })),
      setConfigOption: vi.fn(),
      prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
      cancel: vi.fn(async () => undefined),
      respondToPermission: vi.fn(async () => undefined),
      closeSession: vi.fn(async () => undefined),
      onSessionUpdate: vi.fn(() => () => ({ dispose: () => undefined })),
      onPermissionEvent: vi.fn(() => permissionEmitter.event),
    };
    const services = { openCodeAcpRuntime: runtime } as unknown as IServiceAccessor;
    const platform = {
      selectDirectory: vi.fn(),
      openExternal: vi.fn(),
    } as unknown as IPlatformService;
    const view = render(
      <ZCodeIntlProvider initialLocale="en-US">
        <ServiceProvider services={services}>
          <PlatformProvider platform={platform}>
            <OpenCodeAgentSettingsPanel
              initialWorkspacePath="/workspace"
              remoteWorkspaceActive={false}
            />
          </PlatformProvider>
        </ServiceProvider>
      </ZCodeIntlProvider>,
    );
    testResources.push(view.unmount);

    await screen.findByText("OpenCode CLI detected (OpenCode 1.19.3)");
    fireEvent.click(screen.getByTestId("opencode-start-session"));
    await screen.findByText("OpenCode default model");
    expect((screen.getByLabelText("Prompt OpenCode") as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Use OpenCode default" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Prompt OpenCode") as HTMLTextAreaElement).disabled).toBe(
        false,
      ),
    );
  });

  it("reports an ACP handshake error without attempting an automatic upgrade", async () => {
    const runtime = {
      getCliStatus: vi.fn(async () => ({
        status: "available" as const,
        version: "OpenCode 1.19.3",
        executablePath: "/usr/local/bin/opencode",
      })),
      installCli: vi.fn(async () => ({
        status: "failed" as const,
        diagnostic: "opencode.install-failed",
      })),
      startSession: vi.fn(async () => {
        throw new Error("opencode.acp-initialize-failed");
      }),
      closeSession: vi.fn(async () => undefined),
      onSessionUpdate: vi.fn(() => () => ({ dispose: () => undefined })),
      onPermissionEvent: vi.fn(() => () => ({ dispose: () => undefined })),
    };
    const services = { openCodeAcpRuntime: runtime } as unknown as IServiceAccessor;
    const platform = {
      selectDirectory: vi.fn(),
      openExternal: vi.fn(),
    } as unknown as IPlatformService;
    const view = render(
      <ZCodeIntlProvider initialLocale="en-US">
        <ServiceProvider services={services}>
          <PlatformProvider platform={platform}>
            <OpenCodeAgentSettingsPanel
              initialWorkspacePath="/workspace"
              remoteWorkspaceActive={false}
            />
          </PlatformProvider>
        </ServiceProvider>
      </ZCodeIntlProvider>,
    );
    testResources.push(view.unmount);

    await screen.findByText("OpenCode CLI detected (OpenCode 1.19.3)");
    expect(runtime.installCli).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("opencode-start-session"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("does not support the expected ACP handshake");
    expect(runtime.installCli).not.toHaveBeenCalled();
    expect(within(alert).queryByRole("button")).toBeNull();
  });
});
