import { describe, expect, it } from "vitest";
import {
  resolveRootAutoEffort,
  scoreRootPrompt,
} from "../src/runtime/helpers/root-auto-effort.js";

const LEVELS = ["low", "high", "max"] as const;

describe("root auto reasoning effort", () => {
  it("uses the lowest enabled level for a short simple request", () => {
    expect(resolveRootAutoEffort({ prompt: "переключись на ветку dev", supportedLevels: LEVELS })).toEqual({
      level: "low",
      score: 0,
      tier: "simple",
    });
  });

  it("uses the middle level for a normal implementation request", () => {
    expect(
      resolveRootAutoEffort({
        prompt: "Реализуй кнопку сохранения в настройках и добавь регрессионный тест.",
        supportedLevels: LEVELS,
      }),
    ).toMatchObject({ level: "high", tier: "normal" });
  });

  it("uses the highest level for a complex multi-step request", () => {
    expect(
      resolveRootAutoEffort({
        prompt: [
          "Проведи end-to-end диагностику гонки в runtime, воспроизведи баг,",
          "исправь конкурентность и добавь performance benchmark.",
          "```ts",
          "const x = 1;",
          "```",
          "- шаг 1",
          "- шаг 2",
        ].join("\n"),
        supportedLevels: LEVELS,
      }),
    ).toMatchObject({ level: "max", tier: "complex" });
  });

  it("treats task_graph and plan as complexity signals", () => {
    const base = { prompt: "Сделай обзор", supportedLevels: LEVELS } as const;
    expect(scoreRootPrompt(base)).toBe(0);
    expect(scoreRootPrompt({ ...base, planEnabled: true })).toBe(1);
    expect(scoreRootPrompt({ ...base, hasTaskGraph: true })).toBe(2);
  });

  it("skips disabled pseudo-levels and does not disable reasoning", () => {
    expect(
      resolveRootAutoEffort({ prompt: "привет", supportedLevels: ["disabled", "low", "high"] }),
    ).toMatchObject({ level: "low" });
  });

  it("is a no-op when the model has no usable levels", () => {
    expect(resolveRootAutoEffort({ prompt: "сделай", supportedLevels: [] })).toBeUndefined();
    expect(
      resolveRootAutoEffort({ prompt: "сделай", supportedLevels: ["disabled"] }),
    ).toBeUndefined();
  });

  it("is a no-op for an empty prompt", () => {
    expect(resolveRootAutoEffort({ prompt: "   ", supportedLevels: LEVELS })).toBeUndefined();
  });

  it("keeps the highest level for a two-level model on normal and complex tasks", () => {
    expect(
      resolveRootAutoEffort({
        prompt: "Реализуй изменение в двух файлах и добавь тест.",
        supportedLevels: ["low", "max"],
      }),
    ).toMatchObject({ level: "max", tier: "normal" });
    expect(
      resolveRootAutoEffort({
        prompt: "Проведи end-to-end диагностику конкурентной гонки и исправь её.",
        supportedLevels: ["low", "max"],
      }),
    ).toMatchObject({ level: "max", tier: "complex" });
  });
});
