import { createConnection, createServer, type Socket } from "node:net";
import { delimiter } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { AgentErrorCode } from "@zcode/contracts";
import {
  acquireOpenCodeSocksProxyLease,
  createOpenCodeTaskBridge,
} from "../src/model/opencode-session.js";
import {
  createOpenCodeDiagnosticFetch,
  createOpenCodeModelProvider,
  preferOpenCodeE2ECliOnPath,
  projectOpenCodePrompt,
} from "../src/model/model-execution.js";

describe("projectOpenCodePrompt", () => {
  it("translates ZCode agent and skill guidance for OpenCode without mutating history", () => {
    const canonicalPrompt = [
      {
        role: "system" as const,
        content:
          "For complex tasks, delegate them with Agent. Use only agent types listed in the current Agent system-reminder, and launch independent calls together in one response.",
      },
      {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: [
              "Available named agent types for Agent/Task tools:",
              "- start: ZCode entry role",
              "- reviewer: Reviews code",
              "- test-specialist: Runs tests (Tools: Bash)",
              "The following skills are available for use with the Skill tool:",
              "- review: Review code (file: /workspace/.zcode/skills/review/SKILL.md)",
            ].join("\n"),
          },
        ],
      },
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "Use ZCode Agent for the nested task." }],
      },
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "What is in this image?" },
          {
            type: "file" as const,
            mediaType: "image/png",
            data: new Uint8Array([1, 2, 3]),
          },
        ],
      },
    ];

    const projected = projectOpenCodePrompt(canonicalPrompt, true, true);
    const systemText = projected[0].role === "system" ? projected[0].content : "";
    const contextText =
      projected[1].role === "user"
        ? projected[1].content[0].type === "text"
          ? projected[1].content[0].text
          : ""
        : "";

    expect(systemText).toContain("zcode_task");
    expect(systemText).toContain("exact active ZCode profile ID");
    expect(systemText).toContain("do not use OpenCode's native `task` tool");
    expect(contextText).toContain("start: ZCode entry role");
    expect(contextText).toContain("reviewer: Reviews code");
    expect(contextText).not.toContain("general-purpose");
    expect(contextText).not.toContain("Explore");
    expect(contextText).toContain("test-specialist: Runs tests");
    expect(contextText).toContain("(Tools: Bash)");
    expect(contextText).toContain("`zcode_skill` with its exact skill name");
    expect(contextText).not.toContain("native `read`");
    expect(contextText).not.toContain("/workspace/.zcode/skills/review/SKILL.md");
    expect(projected[2]).toEqual(canonicalPrompt[2]);
    expect(projected[3]).toEqual(canonicalPrompt[3]);
    expect(canonicalPrompt[0].content).toContain(
      "agent types listed in the current Agent system-reminder",
    );
    expect(canonicalPrompt[1].content[0].text).toContain(
      "Available named agent types for Agent/Task tools:",
    );
  });

  it("does not direct OpenCode to its task tool when ZCode delegation is unavailable", () => {
    const prompt = [
      {
        role: "system" as const,
        content:
          "For complex tasks, delegate them with Agent. Use only agent types listed in the current Agent system-reminder,.",
      },
    ];
    const projected = projectOpenCodePrompt(prompt);
    expect(projected[0].role).toBe("system");
    if (projected[0].role === "system") {
      expect(projected[0].content).toContain("ZCode agent delegation is unavailable");
      expect(projected[0].content).toContain("instead of using OpenCode's native `task` tool");
    }
  });

  it("does not expose skill paths or claim load access when Core withheld Skill", () => {
    const prompt = [
      {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: "The following skills are available for use with the Skill tool:\n- review: Review code (file: /private/workspace/.zcode/skills/review/SKILL.md)",
          },
        ],
      },
    ];
    const projected = projectOpenCodePrompt(prompt, false, false);
    const text = projected[0]?.role === "user" ? projected[0].content[0]?.text : "";
    expect(text).toContain("cannot load them because the ZCode Skill capability is unavailable");
    expect(text).not.toContain("/private/workspace/.zcode/skills/review/SKILL.md");
    expect(text).not.toContain("native `read`");
  });

  it("leaves prompts without ZCode runtime markers unchanged", () => {
    const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }];
    expect(projectOpenCodePrompt(prompt)).toEqual(prompt);
  });
});

describe("OpenCode ZCode task bridge", () => {
  it("exposes authenticated invocation-scoped ZCode task and skill MCP tools", async () => {
    const received: unknown[] = [];
    const bridge = await createOpenCodeTaskBridge({
      executeTask: async (input) => {
        received.push(input);
        return "actual ZCode child transcript";
      },
      executeSkill: async (input) => {
        received.push(input);
        return "UNIQUE_ZCODE_SKILL_BODY_MARKER";
      },
    });
    const otherBridge = await createOpenCodeTaskBridge({
      executeSkill: async () => "other invocation",
    });
    const client = new Client({ name: "bridge-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(bridge.url), {
      requestInit: { headers: { Authorization: `Bearer ${bridge.bearerToken}` } },
    });
    const otherClient = new Client({ name: "bridge-isolation-test", version: "1.0.0" });
    const otherTransport = new StreamableHTTPClientTransport(new URL(otherBridge.url), {
      requestInit: { headers: { Authorization: `Bearer ${otherBridge.bearerToken}` } },
    });

    try {
      const unauthorized = await fetch(bridge.url, { method: "POST" });
      expect(unauthorized.status).toBe(401);
      await client.connect(transport);
      const result = await client.callTool({
        name: "zcode_task",
        arguments: {
          description: "Inspect the runtime",
          prompt: "Return the branch name",
          subagent_type: "test-specialist",
        },
      });
      expect(result).toMatchObject({
        content: [{ type: "text", text: "actual ZCode child transcript" }],
      });
      expect(received[0]).toEqual({
        description: "Inspect the runtime",
        prompt: "Return the branch name",
        subagent_type: "test-specialist",
      });
      const skillResult = await client.callTool({
        name: "zcode_skill",
        arguments: { skill: "review" },
      });
      expect(skillResult).toMatchObject({
        content: [{ type: "text", text: "UNIQUE_ZCODE_SKILL_BODY_MARKER" }],
      });
      expect(received[1]).toEqual({ skill: "review" });
      await otherClient.connect(otherTransport);
      await expect(otherClient.listTools()).resolves.toMatchObject({
        tools: [{ name: "zcode_skill" }],
      });
    } finally {
      await Promise.all([client.close(), otherClient.close()]);
      await Promise.all([bridge.dispose(), otherBridge.dispose()]);
    }
    await expect(
      fetch(bridge.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${bridge.bearerToken}` },
      }),
    ).rejects.toThrow();
  });

  it("stops admitting calls on cancellation and waits for an active child before disposing", async () => {
    const controller = new AbortController();
    let finishTask!: (result: string) => void;
    let taskStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      taskStarted = resolve;
    });
    const bridge = await createOpenCodeTaskBridge(
      {
        executeTask: () =>
          new Promise<string>((resolve) => {
            finishTask = resolve;
            taskStarted();
          }),
      },
      controller.signal,
    );
    const client = new Client({ name: "bridge-cancel-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(bridge.url), {
      requestInit: { headers: { Authorization: `Bearer ${bridge.bearerToken}` } },
    });
    await client.connect(transport);
    await expect(client.listTools()).resolves.toMatchObject({ tools: [{ name: "zcode_task" }] });
    const call = client.callTool({
      name: "zcode_task",
      arguments: { description: "Wait", prompt: "Wait", subagent_type: "general-purpose" },
    });
    await started;
    controller.abort();
    const disposal = bridge.dispose();
    let disposed = false;
    void disposal.then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disposed).toBe(false);
    finishTask("completed child");
    await expect(call).resolves.toMatchObject({
      content: [{ type: "text", text: "completed child" }],
    });
    await disposal;
    await client.close();
  }, 10_000);

  it("returns only the active profile roster for a known role error and redacts every other task error", async () => {
    const roleError = Object.assign(
      new Error(
        "Agent type 'general-purpose' is not available. Choose one exact active role ID: researcher, implementer, reviewer",
      ),
      { code: AgentErrorCode.UNKNOWN_AGENT_TYPE },
    );
    const bridge = await createOpenCodeTaskBridge({
      executeTask: async () => {
        throw roleError;
      },
    });
    const client = new Client({ name: "bridge-safe-error-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(bridge.url), {
      requestInit: { headers: { Authorization: `Bearer ${bridge.bearerToken}` } },
    });
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "zcode_task",
        arguments: { description: "Test", prompt: "Test", subagent_type: "general-purpose" },
      });
      expect(result).toMatchObject({
        isError: true,
        content: [
          {
            type: "text",
            text: "That ZCode agent profile is unavailable. Retry with one exact active role ID: researcher, implementer, reviewer.",
          },
        ],
      });
      expect(JSON.stringify(result)).not.toContain("general-purpose");

      const genericBridge = await createOpenCodeTaskBridge({
        executeTask: async () => {
          throw Object.assign(
            new Error(
              "Agent type 'general-purpose' is not available. Choose one exact active role ID: /Users/alice/project, Bearer abcdefghijklmnop",
            ),
            { code: AgentErrorCode.UNKNOWN_AGENT_TYPE },
          );
        },
      });
      const genericClient = new Client({ name: "bridge-generic-error-test", version: "1.0.0" });
      const genericTransport = new StreamableHTTPClientTransport(new URL(genericBridge.url), {
        requestInit: { headers: { Authorization: `Bearer ${genericBridge.bearerToken}` } },
      });
      try {
        await genericClient.connect(genericTransport);
        const genericResult = await genericClient.callTool({
          name: "zcode_task",
          arguments: { description: "Test", prompt: "Test", subagent_type: "reviewer" },
        });
        expect(genericResult).toMatchObject({
          isError: true,
          content: [
            {
              type: "text",
              text: "The ZCode agent task failed. See the ZCode conversation for details.",
            },
          ],
        });
        expect(JSON.stringify(genericResult)).not.toContain("secret");
        expect(JSON.stringify(genericResult)).not.toContain("/Users/alice");
      } finally {
        await genericClient.close();
        await genericBridge.dispose();
      }
    } finally {
      await client.close();
      await bridge.dispose();
    }
  });
});

describe("createOpenCodeDiagnosticFetch", () => {
  it("preserves only bounded, sanitized session-create HTTP diagnostics", async () => {
    const fetch = createOpenCodeDiagnosticFetch(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "AUTH_REQUIRED",
              message:
                "Unauthorized https://provider.example/private?token=secret /Users/alice/project Bearer abc123456789 sk-abcdefghijklmnop",
            },
            debug: "must not pass through",
          }),
          { status: 401 },
        ),
    );

    const response = await fetch(new Request("http://127.0.0.1:4096/session", { method: "POST" }));
    const diagnostic = await response.json();
    expect(response.status).toBe(401);
    expect(diagnostic).toEqual({
      statusCode: 401,
      code: "AUTH_REQUIRED",
      message: "Unauthorized [URL] [path] Bearer [redacted] [redacted]",
    });
    expect(JSON.stringify(diagnostic)).not.toContain("provider.example");
    expect(JSON.stringify(diagnostic)).not.toContain("/Users/alice");
    expect(JSON.stringify(diagnostic)).not.toContain("secret");
    expect(JSON.stringify(diagnostic)).not.toContain("must not pass through");
  });

  it.each(["message", "prompt_async"] as const)(
    "preserves safe HTTP diagnostics when OpenCode %s returns an error",
    async (endpoint) => {
      const fetch = createOpenCodeDiagnosticFetch(
        async () =>
          new Response(
            JSON.stringify({
              name: "UnknownError",
              data: {
                message: "Unexpected server error. Check server logs for details.",
                code: "INTERNAL_ERROR",
                debug: "must not pass through",
              },
            }),
            { status: 500 },
          ),
      );

      const response = await fetch(
        new Request(`http://127.0.0.1:4096/session/ses_safe/${endpoint}`, { method: "POST" }),
      );
      const diagnostic = await response.json();
      expect(response.status).toBe(500);
      expect(diagnostic).toEqual({
        statusCode: 500,
        code: "INTERNAL_ERROR",
        message:
          'OpenCode request diagnostic: {"statusCode":500,"code":"INTERNAL_ERROR","message":"Unexpected server error. Check server logs for details."}',
      });
      expect(JSON.stringify(diagnostic)).not.toContain("must not pass through");
    },
  );

  it("does not modify non-session requests and preserves aborts", async () => {
    const ordinaryResponse = new Response("ok", { status: 200 });
    const fetch = createOpenCodeDiagnosticFetch(async () => ordinaryResponse);
    await expect(
      fetch(new Request("http://127.0.0.1:4096/provider", { method: "POST" })),
    ).resolves.toBe(ordinaryResponse);

    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const abortedFetch = createOpenCodeDiagnosticFetch(async () => {
      throw abort;
    });
    await expect(
      abortedFetch(new Request("http://127.0.0.1:4096/session", { method: "POST" })),
    ).rejects.toBe(abort);
  });

  it("normalizes transport failures without leaking the URL or raw error text", async () => {
    const transportError = Object.assign(
      new TypeError("fetch failed for http://127.0.0.1:4096/session?token=secret"),
      { code: "ECONNREFUSED" },
    );
    const fetch = createOpenCodeDiagnosticFetch(async () => {
      throw transportError;
    });

    await expect(
      fetch(new Request("http://127.0.0.1:4096/session", { method: "POST" })),
    ).rejects.toMatchObject({
      name: "OpenCodeTransportError",
      code: "ECONNREFUSED",
      message: "OpenCode local server request failed.",
    });
  });
});

describe("preferOpenCodeE2ECliOnPath", () => {
  it("puts the E2E fixture directory ahead of Homebrew on PATH", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: ["/opt/homebrew/bin", "/usr/bin"].join(delimiter),
      ZCODE_E2E_OPENCODE_CLI_PATH: "/tmp/e2e/.opencode/bin/opencode",
    };
    preferOpenCodeE2ECliOnPath(env);
    const entries = env.PATH?.split(delimiter) ?? [];
    expect(entries[0]).toBe("/tmp/e2e/.opencode/bin");
    expect(entries.filter((entry) => entry === "/tmp/e2e/.opencode/bin")).toEqual([
      "/tmp/e2e/.opencode/bin",
    ]);
    expect(entries).toContain("/opt/homebrew/bin");
  });
});

describe("OpenCode SOCKS proxy bridge", () => {
  it("does not silently disable an invalid or unsupported configured proxy", async () => {
    await expect(acquireOpenCodeSocksProxyLease("not-a-proxy-url", {})).rejects.toThrow(
      "opencode.proxy-configuration-invalid",
    );
    await expect(acquireOpenCodeSocksProxyLease("socks4://127.0.0.1:1080", {})).rejects.toThrow(
      "opencode.proxy-protocol-unsupported",
    );
    await expect(
      acquireOpenCodeSocksProxyLease("http://127.0.0.1:8080", {}),
    ).resolves.toBeUndefined();
  });

  it("tunnels HTTPS CONNECT through authenticated SOCKS5 and restores proxy environment", async () => {
    const targetServer = createServer(() => {});
    await listen(targetServer);
    const targetAddress = targetServer.address();
    if (!targetAddress || typeof targetAddress === "string") throw new Error("missing target port");

    const socksServer = createServer((socket) => {
      void handleSocksFixture(socket, targetAddress.port);
    });
    await listen(socksServer);
    const socksAddress = socksServer.address();
    if (!socksAddress || typeof socksAddress === "string") throw new Error("missing SOCKS port");

    const environment: NodeJS.ProcessEnv = { HTTPS_PROXY: "https://original.invalid" };
    const lease = await acquireOpenCodeSocksProxyLease(
      `socks5://test-user:test-password@127.0.0.1:${socksAddress.port}`,
      environment,
    );
    expect(lease).toBeDefined();
    expect(environment.HTTPS_PROXY).toBe(lease?.localProxyUrl);
    const response = await sendConnect(lease!.localProxyUrl, targetAddress.port);
    expect(response).toBe("connected-through-socks");

    await lease?.dispose();
    expect(environment.HTTPS_PROXY).toBe("https://original.invalid");
    await close(socksServer);
    await close(targetServer);
  });
});

async function handleSocksFixture(socket: Socket, targetPort: number): Promise<void> {
  try {
    const greeting = await readFixtureBytes(socket, 4);
    expect([...greeting]).toEqual([5, 2, 0, 2]);
    socket.write(Buffer.from([5, 2]));
    const authHeader = await readFixtureBytes(socket, 2);
    const username = await readFixtureBytes(socket, authHeader[1]);
    const passwordLength = (await readFixtureBytes(socket, 1))[0];
    const password = await readFixtureBytes(socket, passwordLength);
    expect(username.toString() + password.toString()).toBe("test-usertest-password");
    socket.write(Buffer.from([1, 0]));
    const request = await readFixtureBytes(socket, 10);
    expect(request[0]).toBe(5);
    const target = createConnection({ host: "127.0.0.1", port: targetPort });
    await new Promise<void>((resolve, reject) => {
      target.once("connect", resolve);
      target.once("error", reject);
    });
    socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
    socket.once("close", () => target.destroy());
    target.once("close", () => socket.destroy());
    socket.pipe(target);
    target.pipe(socket);
    target.write(request.subarray(10));
  } catch {
    socket.destroy();
  }
}

const fixtureSocketBuffers = new WeakMap<Socket, Buffer>();
const fixtureSocketWaiters = new WeakMap<
  Socket,
  Array<{ length: number; resolve: (data: Buffer) => void }>
>();
const fixtureSocketReaders = new WeakSet<Socket>();

function readFixtureBytes(socket: Socket, length: number): Promise<Buffer> {
  const buffered = fixtureSocketBuffers.get(socket) ?? Buffer.alloc(0);
  if (buffered.length >= length) {
    fixtureSocketBuffers.set(socket, buffered.subarray(length));
    return Promise.resolve(buffered.subarray(0, length));
  }
  return new Promise((resolve, reject) => {
    const waiters = fixtureSocketWaiters.get(socket) ?? [];
    waiters.push({ length, resolve });
    fixtureSocketWaiters.set(socket, waiters);
    if (!fixtureSocketReaders.has(socket)) {
      fixtureSocketReaders.add(socket);
      socket.on("data", (chunk: Buffer) => {
        let data = Buffer.concat([fixtureSocketBuffers.get(socket) ?? Buffer.alloc(0), chunk]);
        const pending = fixtureSocketWaiters.get(socket) ?? [];
        while (pending.length > 0 && data.length >= pending[0].length) {
          const waiter = pending.shift()!;
          waiter.resolve(data.subarray(0, waiter.length));
          data = data.subarray(waiter.length);
        }
        fixtureSocketBuffers.set(socket, data);
      });
      socket.once("error", reject);
    }
  });
}

async function listen(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function sendConnect(proxyUrl: string, targetPort: number): Promise<string> {
  const proxy = new URL(proxyUrl);
  const socket = createConnection({ host: proxy.hostname, port: Number(proxy.port) });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`);
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      const boundary = data.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      socket.off("data", onData);
      const response = data.subarray(0, boundary).toString();
      socket.destroy();
      if (!response.includes("200 Connection Established")) {
        reject(new Error("OpenCode SOCKS bridge did not establish CONNECT"));
        return;
      }
      resolve("connected-through-socks");
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

describe("createOpenCodeModelProvider", () => {
  it("owns an isolated provider and removes only its new signal handlers on dispose", async () => {
    const initialSigintListeners = process.listeners("SIGINT");
    const initialSigtermListeners = process.listeners("SIGTERM");

    const first = await createOpenCodeModelProvider();
    const second = await createOpenCodeModelProvider();

    const firstManager = (first.provider as { getClientManager(): unknown }).getClientManager();
    const secondManager = (second.provider as { getClientManager(): unknown }).getClientManager();
    expect(firstManager).not.toBe(secondManager);
    expect(process.listeners("SIGINT").length).toBe(initialSigintListeners.length + 2);
    expect(process.listeners("SIGTERM").length).toBe(initialSigtermListeners.length + 2);

    await Promise.all([first.provider.dispose(), second.dispose()]);
    await first.dispose();

    expect(process.listeners("SIGINT")).toEqual(initialSigintListeners);
    expect(process.listeners("SIGTERM")).toEqual(initialSigtermListeners);
  });
});
