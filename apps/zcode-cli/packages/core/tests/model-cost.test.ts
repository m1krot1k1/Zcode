import { describe, expect, it } from "vitest";
import { calculateRuntimeModelCost } from "../src/runtime/helpers/model-cost.js";

const tokens = (input: number, output: number) => ({
  input,
  output,
  reasoning: 0,
  cache: { read: 0, write: 0 },
});

describe("runtime model cost", () => {
  it("uses the shared model price helper instead of a hard-coded zero", () => {
    const cost = calculateRuntimeModelCost("gpt-4o", tokens(1_000_000, 1_000_000));
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeCloseTo(12.5, 6);
  });

  it("returns undefined for models without a known price", () => {
    expect(calculateRuntimeModelCost("glm-unknown-priced", tokens(10, 10))).toBeUndefined();
  });

  it("does not invent a cost for empty synthetic usage", () => {
    expect(calculateRuntimeModelCost("gpt-4o", tokens(0, 0))).toBeUndefined();
  });
});
