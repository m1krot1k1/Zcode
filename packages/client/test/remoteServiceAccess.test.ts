import { describe, expect, it, vi } from "vitest";
import type { IChannel, IChannelClient } from "@zcode/rpc";
import {
  ICodeIntelligenceService,
  IProactiveSuggestionService,
  ISourceServerManagementService,
} from "@zcode/services";
import { IOpenCodeAcpRuntime } from "@zcode/services";
import { RemoteServiceAccess } from "../src/remoteServiceAccess.js";

const channel: IChannel = {
  call: vi.fn(),
  listen: vi.fn(),
};

describe("RemoteServiceAccess", () => {
  it("公开配置经独立频道 RPC 读取", async () => {
    const call = vi.fn(async () => ({ pluginStoreOrder: null }));
    const requested: string[] = [];
    const services = new RemoteServiceAccess({
      getChannel: (name) => {
        requested.push(name);
        return { call, listen: vi.fn() } as IChannel;
      },
    });
    expect(await services.clientConfigService.getSnapshot({ forceRefresh: true })).toEqual({
      pluginStoreOrder: null,
    });
    expect(requested).toContain("client-config");
    expect(call.mock.calls[0]?.slice(0, 2)).toEqual(["getSnapshot", [{ forceRefresh: true }]]);
  });

  it("проксирует proactive-suggestion в canonical канал Host", async () => {
    const response = {
      requestId: "request-1234",
      suggestion: "Run the failing test",
      reason: null,
      latencyMs: 5,
      modelUsed: null,
    };
    const call = vi.fn(async () => response);
    const requested: string[] = [];
    const services = new RemoteServiceAccess({
      getChannel: (name) => {
        requested.push(name);
        return { call, listen: vi.fn() } as IChannel;
      },
    });

    await expect(
      services.proactiveSuggestionService!.complete({
        requestId: "request-1234",
        workspacePath: "/repo",
        sessionId: "session-1",
        turnId: "turn-1",
        draftEmpty: true,
        context: {
          messages: [],
          assistantResult: null,
          toolResults: [],
          testResults: [],
          diffs: [],
          openFiles: [],
        },
      }),
    ).resolves.toEqual(response);
    expect(requested).toContain(IProactiveSuggestionService.channelName);
    expect(call).toHaveBeenCalledOnce();
    expect(call.mock.calls[0]?.[0]).toBe("complete");
  });
});

describe("RemoteServiceAccess optional channels", () => {
  it("constructs the explicitly requested OpenCode ACP process-owner proxy", async () => {
    const requested: string[] = [];
    const getChannel = vi.fn((name: string) => {
      requested.push(name);
      return {
        call: vi.fn(async () => ({
          status: "available",
          version: "OpenCode 1.19.3",
          executablePath: "/srv/.opencode/bin/opencode",
        })),
        listen: vi.fn(),
      } as IChannel;
    });
    const services = new RemoteServiceAccess({ getChannel } as IChannelClient, {
      openCodeAcpRuntime: true,
    });

    expect(services.openCodeAcpRuntime).toBeDefined();
    await expect(services.openCodeAcpRuntime!.getCliStatus()).resolves.toMatchObject({
      status: "available",
      executablePath: "/srv/.opencode/bin/opencode",
    });
    expect(requested).toContain(IOpenCodeAcpRuntime.channelName);
  });

  it("keeps parameterized ACP subscriptions as callable dynamic RPC events", () => {
    const payload = { sessionUpdate: "agent_message_chunk" };
    const dispose = { dispose: vi.fn() };
    const listen = vi.fn((event: string, arg?: unknown) => {
      expect(event).toBe("onDynamicSessionUpdate");
      expect(arg).toEqual({ sessionId: "session-1" });
      return (listener: (value: unknown) => void) => {
        listener(payload);
        return dispose;
      };
    });
    const services = new RemoteServiceAccess(
      {
        getChannel: () => ({ call: vi.fn(), listen }) as unknown as IChannel,
      } as IChannelClient,
      { openCodeAcpRuntime: true },
    );
    const listener = vi.fn();

    const subscription = services.openCodeAcpRuntime!.onDynamicSessionUpdate({
      sessionId: "session-1",
    })(listener);

    expect(subscription).toBe(dispose);
    expect(listener).toHaveBeenCalledWith(payload);
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it("does not construct a Source management proxy for scopes that do not publish it", () => {
    const getChannel = vi.fn(() => channel);
    const services = new RemoteServiceAccess({ getChannel } as IChannelClient, {
      sourceServerManagementService: false,
    });

    expect(services.sourceServerManagementService).toBeUndefined();
    expect(getChannel).not.toHaveBeenCalledWith(ISourceServerManagementService.channelName);
  });

  it("constructs the code-index proxy only for an opted-in local Desktop Host", async () => {
    const getChannel = vi.fn(
      () =>
        ({
          call: vi.fn(async () => ({ state: "unindexed" })),
          listen: vi.fn(),
        }) as unknown as IChannel,
    );
    const defaultServices = new RemoteServiceAccess({ getChannel } as IChannelClient);
    expect(defaultServices.codeIntelligenceService).toBeUndefined();
    expect(getChannel).not.toHaveBeenCalledWith(ICodeIntelligenceService.channelName);

    const services = new RemoteServiceAccess({ getChannel } as IChannelClient, {
      codeIntelligenceService: true,
    });
    expect(services.codeIntelligenceService).toBeDefined();
    await expect(
      services.codeIntelligenceService!.getStatus({ workspacePath: "/workspace" }),
    ).resolves.toMatchObject({ state: "unindexed" });
    expect(getChannel).toHaveBeenCalledWith(ICodeIntelligenceService.channelName);
  });
});

it("MRO02：窗口目录只由显式能力创建，原工作区 project 频道保留", async () => {
  const calls: string[] = [];
  const getChannel = vi.fn((name: string) => ({
    call: async () => {
      calls.push(name);
      return name === "window-project-changes" ? { version: 1 } : { projects: [], tasks: [] };
    },
    listen: vi.fn(),
  }));
  const legacy = new RemoteServiceAccess({ getChannel });
  expect(legacy.windowProjectDirectory).toBeUndefined();
  expect(getChannel).not.toHaveBeenCalledWith("window-project");
  const services = new RemoteServiceAccess({ getChannel }, { windowProjectDirectory: true });
  expect(services.windowProjectDirectory).toBeDefined();
  await services.windowProjectDirectory!.changesService.getCapabilities();
  await services.windowProjectDirectory!.projectService.readTree();
  await services.projectService.readTree();
  expect(calls).toEqual(["window-project-changes", "window-project", "project"]);
});
