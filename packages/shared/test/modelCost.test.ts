import { describe, expect, it } from "vitest";
import { calculateModelCostUsd } from "../src/model-cost.js";

describe("calculateModelCostUsd", () => {
  it("returns a non-zero cost when the model has a known price", () => {
    const cost = calculateModelCostUsd("gpt-4o", {
      input: 1_000_000,
      output: 1_000_000,
    });

    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeCloseTo(12.5, 6);
  });

  it("returns undefined for an unknown model instead of pretending it is free", () => {
    expect(
      calculateModelCostUsd("zcode-unknown-priced-model", {
        input: 1000,
        output: 1000,
      }),
    ).toBeUndefined();
  });

  it("returns undefined when there is no token usage to price", () => {
    expect(calculateModelCostUsd("gpt-4o", { input: 0, output: 0 })).toBeUndefined();
    expect(calculateModelCostUsd("gpt-4o", undefined)).toBeUndefined();
    expect(calculateModelCostUsd(undefined, { input: 10, output: 10 })).toBeUndefined();
  });

  it("prices cache tokens through the same helper", () => {
    expect(
      calculateModelCostUsd("gpt-4o", {
        input: 0,
        output: 0,
        cacheRead: 1_000_000,
      }),
    ).toBeGreaterThan(0);
  });
});
