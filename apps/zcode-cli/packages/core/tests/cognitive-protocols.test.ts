import { describe, expect, it } from "vitest";
import {
  COGNITIVE_PROTOCOL_HEADINGS,
  COGNITIVE_PROTOCOL_IDS,
  PROMPT_DEPTH_PROFILES,
  PROMPT_DEPTH_RUNTIME_TUNING,
  buildCognitiveProtocolsBlock,
  listCognitiveProtocolIds,
  resolvePromptDepthProfile,
  resolvePromptDepthRuntimeTuning,
} from "../src/context/cognitive-protocols.js";
import { buildIdentitySection } from "../src/context/sections/identity.js";

describe("cognitive protocols block", () => {
  it("contains all five protocol headings for every depth profile", () => {
    for (const profile of PROMPT_DEPTH_PROFILES) {
      const block = buildCognitiveProtocolsBlock(profile);
      for (const id of COGNITIVE_PROTOCOL_IDS) {
        expect(block).toContain(COGNITIVE_PROTOCOL_HEADINGS[id]);
      }
      expect(listCognitiveProtocolIds(block)).toHaveLength(COGNITIVE_PROTOCOL_IDS.length);
    }
  });

  it("is byte-identical for the same profile (cacheable prefix requirement)", () => {
    for (const profile of PROMPT_DEPTH_PROFILES) {
      expect(buildCognitiveProtocolsBlock(profile)).toBe(buildCognitiveProtocolsBlock(profile));
    }
  });

  it("produces different text per profile, ordered from standard to max", () => {
    const standard = buildCognitiveProtocolsBlock("standard");
    const deep = buildCognitiveProtocolsBlock("deep");
    const max = buildCognitiveProtocolsBlock("max_reasoning");

    expect(standard).not.toBe(deep);
    expect(deep).not.toBe(max);
    expect(standard.length).toBeLessThan(deep.length);
    expect(deep.length).toBeLessThan(max.length);
  });

  it("keeps the runtime tuning aligned with the reasoning budget ladder of 4.1", () => {
    expect(PROMPT_DEPTH_RUNTIME_TUNING.standard.thinkingBudgetTokens).toBeLessThan(
      PROMPT_DEPTH_RUNTIME_TUNING.deep.thinkingBudgetTokens,
    );
    expect(PROMPT_DEPTH_RUNTIME_TUNING.deep.thinkingBudgetTokens).toBeLessThan(
      PROMPT_DEPTH_RUNTIME_TUNING.max_reasoning.thinkingBudgetTokens,
    );
    // Резерв под JSON-аргументы инструментов из 4.1 не должен срезать thinking целиком.
    for (const profile of PROMPT_DEPTH_PROFILES) {
      const tuning = PROMPT_DEPTH_RUNTIME_TUNING[profile];
      expect(tuning.minMaxOutputTokens).toBeGreaterThan(tuning.thinkingBudgetTokens);
    }
  });

  it("normalizes unknown profiles to standard", () => {
    expect(resolvePromptDepthProfile("unknown")).toBe("standard");
    expect(resolvePromptDepthProfile(undefined)).toBe("standard");
    expect(resolvePromptDepthProfile("max_reasoning")).toBe("max_reasoning");
    expect(resolvePromptDepthRuntimeTuning("deep").reasoningEffort).toBe("high");
  });
});

describe("identity section with depth profile", () => {
  it("embeds all five protocols into the stable identity section", () => {
    const section = buildIdentitySection(undefined, "compact", "deep");
    expect(section.cacheHint).toBe("stable");
    for (const id of COGNITIVE_PROTOCOL_IDS) {
      expect(section.content).toContain(COGNITIVE_PROTOCOL_HEADINGS[id]);
    }
  });

  it("keeps the identity section byte-stable across repeated builds with the same inputs", () => {
    const first = buildIdentitySection(undefined, "compact", "max_reasoning");
    const second = buildIdentitySection(undefined, "compact", "max_reasoning");
    expect(first.content).toBe(second.content);
  });

  it("changes the section when the depth profile changes", () => {
    const standard = buildIdentitySection(undefined, "compact", "standard");
    const deep = buildIdentitySection(undefined, "compact", "deep");
    expect(standard.content).not.toBe(deep.content);
  });

  it("does not duplicate instructions between the core prompt and the protocols", () => {
    const content = buildIdentitySection(undefined, "compact", "standard").content;
    // Формулировки, которые раньше дублировались в core и в протоколах.
    expect(content).not.toContain("# Done\nFinish the requested scope end-to-end");
    expect(content).not.toContain("Verify at the layer you changed");
    expect(content.match(/Do not perform irreversible, public, costly, or production actions/g)).toHaveLength(1);
  });
});
