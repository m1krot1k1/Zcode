import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createOpenCodeDiagnosticFetch,
  createOpenCodeModelProvider,
  preferOpenCodeE2ECliOnPath,
} from "../src/model/model-execution.js";

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
