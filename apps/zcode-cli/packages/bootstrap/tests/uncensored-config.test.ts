import { describe, expect, it, vi } from "vitest";
import { createUncensoredConfigPort } from "../src/zcode-protocol/uncensored-config.js";

describe("createUncensoredConfigPort", () => {
  it("refreshes the provider registry after the Host returns mirror config", async () => {
    const calls: string[] = [];
    const context = {
      deps: {
        refreshProviderRegistry: async (reason: string) => {
          calls.push(reason);
        },
      },
      logger: { warn: vi.fn() },
      requestClient: async () => {
        calls.push("request");
        return { providers: [] };
      },
    };
    const port = createUncensoredConfigPort(context as never);
    await port.getConfig({ workspacePath: "/workspace" });
    expect(calls).toEqual(["request", "uncensored-takeover"]);
  });

  it("keeps the config when registry refresh fails", async () => {
    const context = {
      deps: {
        refreshProviderRegistry: async () => {
          throw new Error("refresh failed");
        },
      },
      logger: { warn: vi.fn() },
      requestClient: async () => ({ providers: [] }),
    };
    const port = createUncensoredConfigPort(context as never);
    await expect(port.getConfig({ workspacePath: "/workspace" })).resolves.toEqual({
      providers: [],
    });
    expect(context.logger.warn).toHaveBeenCalled();
  });
});
