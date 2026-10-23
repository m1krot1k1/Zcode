import { describe, expect, it } from "vitest";
import { createOpenCodeModelProvider } from "../src/model/model-execution.js";

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
