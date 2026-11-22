import { describe, expect, it } from "vitest";
import {
  buildPromptEnhanceCapabilityIndex,
  resolvePromptEnhanceCapabilities,
  tokenizeCapabilityText,
} from "./capabilities.js";

describe("prompt-enhance capability index", () => {
  it("tokenizes names and drafts deterministically", () => {
    expect(tokenizeCapabilityText("frontend-design, Yandex Direct")).toEqual([
      "frontend",
      "design",
      "yandex",
      "direct",
    ]);
  });

  it("builds a deduplicated index from installed facts", () => {
    const index = buildPromptEnhanceCapabilityIndex({
      skills: [
        { name: "yandex-direct", description: "Manage ad campaigns" },
        { name: "yandex-direct", description: "duplicate" },
      ],
      mcpServers: [{ name: "browser", enabled: false }],
      agents: [{ name: "reviewer" }],
      plugins: [{ name: "official", id: "official@market" }],
    });
    expect(index.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
      "skill:yandex-direct",
      "mcp:browser",
      "plugin:official",
      "agent:reviewer",
    ]);
    expect(index.find((entry) => entry.name === "browser")?.enabled).toBe(false);
  });

  it("marks a model suggestion installed when the index knows it", () => {
    const index = buildPromptEnhanceCapabilityIndex({
      skills: [{ name: "yandex-direct", description: "Manage ad campaigns" }],
    });
    const resolved = resolvePromptEnhanceCapabilities({
      draftText: "Set up Yandex Direct campaigns and report the budget",
      classification: { domain: "marketing", taskKind: "planning" },
      modelSuggestions: [
        {
          kind: "skill",
          name: "yandex-direct",
          reason: "Matches advertising",
          installed: false,
          source: "model",
          requiresConsent: true,
        },
        {
          kind: "mcp",
          name: "missing-server",
          reason: "Model guess",
          installed: false,
          source: "model",
          requiresConsent: true,
        },
      ],
      index,
    });
    expect(resolved[0]).toMatchObject({
      name: "yandex-direct",
      installed: true,
      source: "model",
      requiresConsent: true,
    });
    expect(resolved[1]).toMatchObject({ name: "missing-server", installed: false });
  });

  it("adds deterministic installed matches the model forgot, without duplicates", () => {
    const index = buildPromptEnhanceCapabilityIndex({
      skills: [
        { name: "frontend-design", description: "Distinctive UI direction and visual polish" },
        { name: "unrelated", description: "Database migrations" },
      ],
    });
    const resolved = resolvePromptEnhanceCapabilities({
      draftText: "Polish the frontend UI and visual direction",
      classification: { domain: "design", taskKind: "design" },
      modelSuggestions: [
        {
          kind: "skill",
          name: "frontend-design",
          reason: "Model proposal",
          installed: false,
          source: "model",
          requiresConsent: true,
        },
      ],
      index,
    });
    expect(resolved.map((suggestion) => suggestion.name)).toEqual(["frontend-design"]);
    expect(resolved[0]?.source).toBe("model");
  });

  it("drops disabled and unrelated capabilities from deterministic matches", () => {
    const index = buildPromptEnhanceCapabilityIndex({
      skills: [
        { name: "frontend-design", description: "UI polish", enabled: false },
        { name: "database", description: "Database migrations" },
      ],
    });
    const resolved = resolvePromptEnhanceCapabilities({
      draftText: "Polish the frontend UI and visual direction",
      classification: { domain: "design", taskKind: "design" },
      index,
    });
    expect(resolved).toEqual([]);
  });

  it("caps suggestions and always requires consent", () => {
    const index = buildPromptEnhanceCapabilityIndex({
      skills: Array.from({ length: 10 }, (_, index) => ({
        name: `design-skill-${index}`,
        description: "UI design polish",
      })),
    });
    const resolved = resolvePromptEnhanceCapabilities({
      draftText: "Design polish for the UI with design consistency",
      index,
    });
    expect(resolved.length).toBeLessThanOrEqual(6);
    expect(resolved.every((suggestion) => suggestion.requiresConsent)).toBe(true);
  });
});
