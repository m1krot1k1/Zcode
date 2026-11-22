import { describe, expect, it } from "vitest";
import { createContextBuilder } from "../src/context/index.js";
import type { ContextBuildResult } from "../src/context/types.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";

/**
 * Инкремент 4.4, пункт 4: кэшируемый префикс.
 *
 * Провайдерские cache-write/cache-read работают по побайтовому префиксу сообщений.
 * Поэтому стабильная часть системного промпта обязана оставаться идентичной при смене
 * динамического контекста (память, дата, guidance, todo, режим). Эти тесты фиксируют
 * инвариант без обращения к провайдеру; фактическую проверку `cacheReadTokens`
 * выполняет Этап 6 на реальном провайдере.
 */

const model = createTestRuntimeModel({
  providerId: "openai",
  modelId: "gpt-5",
  generateText: async () => {
    throw new Error("context rendering must not execute the model");
  },
});

function build(overrides: Record<string, unknown> = {}): ContextBuildResult {
  return createContextBuilder({
    workingDirectory: "/repo/zcode",
    envInfo: { cwd: "/repo/zcode", platform: "linux", isGitRepo: true } as never,
    model,
    currentDate: "2026-11-17",
    promptDepth: "deep",
    ...overrides,
  } as never).build();
}

/** Контент сообщения как строка: сборщик кладёт в system-сообщения строку. */
function asText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : ""))
      .join("");
  }
  return "";
}

/** Индекс сообщения со стабильным телом (после cli_prefix). */
function stableSystemMessage(result: ContextBuildResult): string {
  return asText(result.systemMessages[1]?.content);
}

describe("cacheable prompt prefix", () => {
  it("keeps the stable system prefix byte-identical when dynamic context changes", () => {
    const baseline = build();
    const withDate = build({ currentDate: "2027-01-01" });
    const withGuidance = build({ guidanceToolNames: ["Agent", "Skill", "Read"] });
    const withMemory = build({ memoryRoot: "/home/user/.zcode/memory" });

    for (const variant of [withDate, withGuidance, withMemory]) {
      expect(stableSystemMessage(variant)).toBe(stableSystemMessage(baseline));
    }
  });

  it("keeps the desktop stable prefix identical across dynamic changes on the same surface", () => {
    const surface = { presentationSurface: "zcode_desktop", genUiOutputDirectory: "/tmp/session" };
    const baseline = build(surface);
    const withDate = build({ ...surface, currentDate: "2027-01-01" });
    const withGuidance = build({ ...surface, guidanceToolNames: ["Agent"] });

    expect(stableSystemMessage(withDate)).toBe(stableSystemMessage(baseline));
    expect(stableSystemMessage(withGuidance)).toBe(stableSystemMessage(baseline));
  });

  it("marks the stable body with ephemeral cache control and isolates the dynamic block", () => {
    const result = build();
    const stable = result.systemMessages[1];
    expect(stable?.role).toBe("system");
    expect(stable?.cacheControl).toEqual({ type: "ephemeral" });

    const dynamic = result.systemMessages[2];
    if (dynamic) {
      expect(asText(dynamic.content).startsWith("\n\n")).toBe(true);
    }
  });

  it("puts every dynamic section strictly after the stable prefix", () => {
    const result = build({ guidanceToolNames: ["Agent"] });
    const stableIndexes = result.sections
      .map((section, index) => ({ section, index }))
      .filter(({ section }) => section.injectionTarget === "system" && section.cacheHint === "stable")
      .map(({ index }) => index);
    const dynamicIndexes = result.sections
      .map((section, index) => ({ section, index }))
      .filter(({ section }) => section.injectionTarget === "system" && section.cacheHint === "dynamic")
      .map(({ index }) => index);

    expect(stableIndexes.length).toBeGreaterThan(0);
    expect(Math.max(...stableIndexes)).toBeLessThan(Math.min(...dynamicIndexes));
  });

  it("is deterministic: two builds with identical inputs produce identical message bytes", () => {
    const first = build({ guidanceToolNames: ["Agent", "Skill"] });
    const second = build({ guidanceToolNames: ["Skill", "Agent"] });

    expect(second.systemMessages.map((message) => message.content)).toEqual(
      first.systemMessages.map((message) => message.content),
    );
    expect(second.sections.map((section) => section.source)).toEqual(
      first.sections.map((section) => section.source),
    );
  });

  it("invalidates the prefix only when the user changes the depth profile", () => {
    const standard = build({ promptDepth: "standard" });
    const deep = build({ promptDepth: "deep" });

    expect(stableSystemMessage(standard)).not.toBe(stableSystemMessage(deep));
  });

  it("includes the five cognitive protocols inside the cached stable prefix", () => {
    const content = stableSystemMessage(build());
    expect(content).toContain("# Cognitive protocols");
    expect(content.match(/^## Protocol [1-5] /gmu)).toHaveLength(5);
  });
});
