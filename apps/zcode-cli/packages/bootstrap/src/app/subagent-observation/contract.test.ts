import { describe, expect, it } from "vitest";

import { exampleCliSubagentObservation } from "./contract.example.js";
import type { SubagentObservation } from "./contract.js";
import { cliSubagentObservationModule } from "./module.js";

describe("cli-subagent-observation contract", () => {
  it("declares the managed app module", () => {
    expect(cliSubagentObservationModule.id).toBe("cli-subagent-observation");
  });

  it("reads one bounded page through the observation contract", async () => {
    const result = { revision: 1, childSessionIds: [], running: [], ended: { total: 0, items: [] } };
    const observation = {
      readSubagents: async (input) => {
        expect(input).toEqual({ endedLimit: 20 });
        return result;
      },
      readSubagentTranscript: async () => {
        throw new Error("not used by this example");
      },
    } satisfies SubagentObservation;

    await expect(exampleCliSubagentObservation(observation)).resolves.toEqual(result);
  });
});
