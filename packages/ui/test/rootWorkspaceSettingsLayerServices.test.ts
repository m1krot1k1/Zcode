import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";

vi.mock("@/project-sidebar/index.js", () => ({
  ProjectDirectoryProvider: ({ children }: { children: unknown }) => children,
}));

const workspaceSettingsLayerMock = vi.fn(() => null);

vi.mock("../src/App.js", () => ({
  App: () => null,
}));

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/root/WorkspaceSettingsLayer.js", () => ({
  WorkspaceSettingsLayer: (props: Record<string, unknown>) => {
    workspaceSettingsLayerMock(props);
    return createElement("div", null, "settings");
  },
}));

// RootWorkspaceContent 挂载时会调用 useUncensoredSettingsRemoteSync，它经
// useBaseWorkspaceServices() → useServices() 读取根服务。本用例只关心 settings
// 遮罩拿到的是 workspace 作用域的服务，因此给出最小实现，让断言仍落在
// workspaceScopedServices 上。
vi.mock("../src/hooks/useServices.js", () => ({
  ServiceProvider: ({ children }: { children: unknown }) => children,
  useServices: () => ({}),
  useOptionalServices: () => ({}),
}));

function makeServices(id: string): IServiceAccessor {
  return { __testId: id } as unknown as IServiceAccessor;
}

describe("RootWorkspaceContent settings layer services", () => {
  beforeEach(() => {
    workspaceSettingsLayerMock.mockClear();
  });

  it("passes workspace-scoped services into the settings overlay", async () => {
    const { RootWorkspaceContent } = await import("../src/root/RootWorkspaceContent.js");
    const workspaceScopedServices = makeServices("remote-workspace");

    renderToStaticMarkup(
      createElement(RootWorkspaceContent, {
        workspaceScopedServices,
        workspaceShellPath: "/workspace/remote",
        workspaceIdentity: "remote:ssh:host:/workspace/remote",
        workspaceRemoteSessionId: "remote-session-1",
        activeWorkspacePath: "/workspace/remote",
        isSettingsTabActive: true,
        handleConnectRemote: vi.fn(),
        handleSelectRemoteProject: vi.fn(),
        handleCancelRemoteProject: vi.fn(),
        handleReconnectRemoteWorkspace: vi.fn(),
        handleCreateTask: vi.fn(),
        handleOpenWorkspace: vi.fn(),
        remoteWorkspaceSessions: [],
        allowRemoteWorkspace: true,
        handleBackFromSettings: vi.fn(),
        user: null,
        reconnectingRemoteWorkspaceKeys: [],
        remoteWorkspaceErrorByWorkspaceKey: {},

        allowOpenWorkspace: true,
      }),
    );

    expect(workspaceSettingsLayerMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceScopedServices }),
    );
  });
});
