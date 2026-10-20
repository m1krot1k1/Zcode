import { describe, expect, it } from "vitest";
import {
  ABSOLUTE_MAX_SUBAGENT_DEPTH,
  decideChildNesting,
  resolveMaxSubagentDepth,
  runtimeMaySpawnSubagents,
} from "../src/subagent/tool-policy.js";

describe("subagent nesting", () => {
  it("по умолчанию даёт глубокий рой и режет всё, что выше предохранителя", () => {
    expect(resolveMaxSubagentDepth(undefined)).toBe(64);
    expect(resolveMaxSubagentDepth("")).toBe(64);
    expect(resolveMaxSubagentDepth("999")).toBe(ABSOLUTE_MAX_SUBAGENT_DEPTH);
    expect(resolveMaxSubagentDepth("nope")).toBe(64);
    expect(resolveMaxSubagentDepth("-1")).toBe(64);
  });

  it("0 запрещает порождение корню, 1 оставляет только первый уровень", () => {
    expect(runtimeMaySpawnSubagents(0, resolveMaxSubagentDepth("0"))).toBe(false);
    expect(runtimeMaySpawnSubagents(0, 1)).toBe(true);
    expect(decideChildNesting(0, 1)).toEqual({ depth: 1, maySpawn: false });
  });

  it("child внутри потолка может порождать, child на потолке — нет", () => {
    expect(decideChildNesting(0, 64)).toEqual({ depth: 1, maySpawn: true });
    expect(decideChildNesting(63, 64)).toEqual({ depth: 64, maySpawn: false });
  });
});
