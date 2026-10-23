import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createOpenCodeModelProvider,
  preferOpenCodeE2ECliOnPath,
} from "../src/model/model-execution.js";

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
