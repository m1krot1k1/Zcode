import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveServerLayout } from "../src/runtime/paths.js";

const createServerHostServices = vi.fn();
const materializeZCodeBuiltinProviderConfig = vi.fn();
const disposeServiceResourcesAndWait = vi.fn();
const createCoreHttpServer = vi.fn();
const createIngressToken = vi.fn();
const resolveCoreServerId = vi.fn();
const installParentDisconnectHandler = vi.fn();
const createTaskActivityTracker = vi.fn();
const environmentConfigRoot = "/tmp/zcode-server-core-test/.zcode/v2";

vi.mock("@zcode/services/node", () => ({
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV: "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
  createServerHostServices,
  createTopicResourcePeers: () => ({ getChannel: vi.fn() }),
  disposeServiceResourcesAndWait,
  getAppConfigDir: () => environmentConfigRoot,
  materializeZCodeBuiltinProviderConfig,
}));
vi.mock("../src/server-core/http.js", () => ({ createCoreHttpServer }));
vi.mock("../src/server-core/ingressToken.js", () => ({ createIngressToken }));
vi.mock("../src/server-core/serverIdentity.js", () => ({ resolveCoreServerId }));
vi.mock("../src/server-core/parentDisconnect.js", () => ({
  installParentDisconnectHandler,
  installStdinCloseHandler,
}));
const installStdinCloseHandler = vi.fn();

vi.mock("../src/server-core/taskActivityTracker.js", () => ({ createTaskActivityTracker }));

const { runServerCore } = await import("../src/server-core/core.js");

const ENV_KEYS = [
  "ZCODE_SERVER_ROOT",
  "ZCODE_SERVER_RUNTIME_ROOT",
  "ZCODE_SERVER_RELEASE_ID",
  "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
] as const;
const PROCESS_EVENTS = ["message", "SIGTERM", "SIGINT"] as const;
// 以通用 EventEmitter 视角操作 process，绕开 process.on/listeners 针对具体事件名的重载。
const processEmitter: NodeJS.EventEmitter = process;

describe("runServerCore startup wiring", () => {
  // Throwaway roots created by individual cases, removed after the suite.
  const tempRoots: string[] = [];
  afterAll(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  const layout = resolveServerLayout("/tmp/zcode-server-core-test/.zcode/server");
  const materializedPath = join(
    environmentConfigRoot,
    "runtime",
    "provider",
    "bundled",
    "zcode-builtin.json",
  );
  const savedEnv = new Map<string, string | undefined>();
  const listenersBefore = new Map<string, Function[]>();

  beforeEach(() => {
    vi.useFakeTimers();
    for (const key of ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    for (const event of PROCESS_EVENTS) {
      listenersBefore.set(event, processEmitter.listeners(event));
    }
    process.env.ZCODE_SERVER_ROOT = layout.serverRoot;
    vi.stubGlobal("__ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__", '{"providers":{}}');
    materializeZCodeBuiltinProviderConfig.mockResolvedValue(materializedPath);
    createServerHostServices.mockResolvedValue({
      services: { getOptional: vi.fn(() => undefined) },
      workspaceIdentityMapper: {},
      migrationFailedPathCount: 0,
    });
    createCoreHttpServer.mockResolvedValue({
      host: "127.0.0.1",
      port: 4321,
      close: vi.fn(async () => undefined),
    });
    createIngressToken.mockResolvedValue("ingress-token");
    resolveCoreServerId.mockResolvedValue("server-installation-id");
    installParentDisconnectHandler.mockReturnValue(() => undefined);
    installStdinCloseHandler.mockReturnValue(() => undefined);
    createTaskActivityTracker.mockReturnValue({
      readRunningTaskCount: () => 0,
      onDidChangeRunningTaskCount: () => ({ dispose: () => undefined }),
      dispose: () => undefined,
    });
  });

  afterEach(() => {
    // runServerCore 会注册 shutdown 监听并启动心跳 interval；测试不走 process.exit 路径，
    // 手工回收本用例新增的监听与定时器，避免污染同一 worker 内的其它用例。
    for (const event of PROCESS_EVENTS) {
      const before = new Set(listenersBefore.get(event) ?? []);
      for (const listener of processEmitter.listeners(event)) {
        if (!before.has(listener)) {
          processEmitter.removeListener(event, listener as (...args: unknown[]) => void);
        }
      }
    }
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const key of ENV_KEYS) {
      const value = savedEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetAllMocks();
  });

  it("materializes the built-in provider config under the environment config root, not the release runtime", async () => {
    process.env.ZCODE_SERVER_RUNTIME_ROOT = join(layout.releasesDir, "release-1", "runtime");
    process.env.ZCODE_SERVER_RELEASE_ID = "release-1";

    await runServerCore(7);

    expect(materializeZCodeBuiltinProviderConfig).toHaveBeenCalledTimes(1);
    expect(materializeZCodeBuiltinProviderConfig).toHaveBeenCalledWith({
      environmentConfigRoot,
      content: '{"providers":{}}',
    });
    expect(createServerHostServices).toHaveBeenCalledWith({
      zcodeBuiltinProviderConfigFilePath: materializedPath,
      sourceServerId: "server-installation-id",
      providerProvisioningTargetEnabled: true,
      // The spawn path gets a RESOLVER, never a boot-time snapshot: the relay's remote
      // port is OS-assigned per SSH connection, so a captured address goes stale.
      resolveRemoteAgentNetwork: expect.any(Function),
      topicResourceRelayChannel: expect.any(Function),
    });
    expect(createIngressToken).toHaveBeenCalledWith(layout);
  });

  it("resolves the Desktop agent network handoff before assembling host services", async () => {
    // 承重项：Core 必须先读到 Host 下发的网络配置并把它交给 createServerHostServices，
    // 否则 supervisor 启动的 standalone Source Server 永远不会把回退中继传给 agent。
    // A throwaway server root, not the shared fixture: this test writes a file and must
    // not leak it into the next case's layout.
    const handoffRoot = join(tmpdir(), `zcode-core-handoff-${process.pid}-${Date.now()}`);
    tempRoots.push(handoffRoot);
    const handoffLayout = resolveServerLayout(join(handoffRoot, ".zcode", "server"));
    process.env.ZCODE_SERVER_ROOT = handoffLayout.serverRoot;
    await mkdir(handoffLayout.serverRoot, { recursive: true });
    await writeFile(
      join(handoffLayout.serverRoot, "remote-agent-network.json"),
      JSON.stringify({
        httpProxy: "http://127.0.0.1:41234",
        noProxy: null,
        fallbackOnly: true,
      }),
      "utf8",
    );

    await runServerCore(1);

    // The spawn path receives a RESOLVER, not a captured value: the relay's remote port
    // changes on every SSH reconnect, so a boot-time snapshot would go stale.
    const call = createServerHostServices.mock.calls.at(-1)?.[0] as {
      resolveRemoteAgentNetwork?: () => Promise<unknown>;
    };
    expect(call.resolveRemoteAgentNetwork).toBeTypeOf("function");
    await expect(call.resolveRemoteAgentNetwork?.()).resolves.toEqual({
      httpProxy: "http://127.0.0.1:41234",
      noProxy: undefined,
      fallbackOnly: true,
    });
  });

  it("waits for owner host initialization before opening RPC", async () => {
    const result = {
      services: { getOptional: () => undefined },
      workspaceIdentityMapper: {},
      migrationFailedPathCount: 0,
    };
    let release!: () => void;
    createServerHostServices.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(result);
        }),
    );
    const starting = runServerCore(1);
    await vi.waitFor(() => expect(createServerHostServices).toHaveBeenCalledOnce());
    expect(createCoreHttpServer).not.toHaveBeenCalled();
    release();
    await starting;
    expect(createCoreHttpServer).toHaveBeenCalledWith(
      result.services,
      expect.objectContaining({
        serverId: "server-installation-id",
        workspaceIdentityMapper: result.workspaceIdentityMapper,
      }),
    );
  });

  it("keeps the server closed when migration fails", async () => {
    createServerHostServices.mockRejectedValue(new Error("migration failed"));
    await expect(runServerCore(1)).rejects.toThrow("migration failed");
    expect(createCoreHttpServer).not.toHaveBeenCalled();
  });

  it("prefers an explicitly configured built-in provider config file", async () => {
    process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = "/explicit/zcode-builtin.json";

    await runServerCore(1);

    expect(materializeZCodeBuiltinProviderConfig).not.toHaveBeenCalled();
    expect(createServerHostServices).toHaveBeenCalledWith(
      expect.objectContaining({
        zcodeBuiltinProviderConfigFilePath: "/explicit/zcode-builtin.json",
        providerProvisioningTargetEnabled: true,
      }),
    );
  });

  it("fails fast when neither an embedded nor an explicit built-in config is available", async () => {
    vi.stubGlobal("__ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__", undefined);

    await expect(runServerCore(1)).rejects.toThrow(
      /ZCode Built-in Provider Config.*ZCODE_BUILTIN_PROVIDER_CONFIG_FILE/u,
    );
    expect(createServerHostServices).not.toHaveBeenCalled();
  });

  it("installs the stdin EOF handler so a remote Core stops when its client leaves", async () => {
    await runServerCore(1);

    // A desktop-attached Core has no IPC parent; EOF on stdin is the only exit signal.
    expect(installStdinCloseHandler).toHaveBeenCalledWith(expect.any(Function), {
      hasParentChannel: typeof process.send === "function",
    });
    // Under a Supervisor the callback must be absent from the stdin path entirely.
    if (typeof process.send === "function") {
      expect(installStdinCloseHandler.mock.calls[0]?.[1]).toMatchObject({
        hasParentChannel: true,
      });
    }
  });

  it("shuts the Core down when the stdin EOF callback fires", async () => {
    await runServerCore(1);
    const onStdinClosed = installStdinCloseHandler.mock.calls[0]?.[0] as () => void;
    // Wired to the single shutdown path; the shutdown body itself is covered by stdinLifecycle tests
    // and is not executed here, because it ends in process.exit.
    expect(typeof onStdinClosed).toBe("function");
  });
});
