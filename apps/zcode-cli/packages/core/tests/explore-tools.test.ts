import { describe, expect, it } from "vitest";
import {
  buildExploreAllowedTools,
  formatExploreAllowedToolsForAgentDescription,
} from "../src/subagent/explore-tools.js";

describe("Explore tool policy", () => {
  it("keeps direct and embedded-search Explore tool lists in sync with provider-visible text", () => {
    // CodeIndex входит в обе ветки: индекс — основной вход для навигации по символам,
    // Glob/Grep/Bash остаются fallback при недоступном или неполном индексе.
    expect(buildExploreAllowedTools()).toEqual([
      "ToolSearch",
      "DeferredToolCall",
      "CodeIndex",
      "Bash",
      "Glob",
      "Grep",
      "Read",
      "WebFetch",
      "WebSearch",
      "TodoWrite",
    ]);
    expect(formatExploreAllowedToolsForAgentDescription()).toBe(
      "CodeIndex, Glob, Grep, Read, Bash, WebFetch, WebSearch, TodoWrite",
    );

    expect(buildExploreAllowedTools({ embeddedSearchEnabled: true })).toEqual([
      "ToolSearch",
      "DeferredToolCall",
      "CodeIndex",
      "Bash",
      "Read",
      "WebFetch",
      "WebSearch",
      "TodoWrite",
    ]);
    expect(formatExploreAllowedToolsForAgentDescription({ embeddedSearchEnabled: true })).toBe(
      "CodeIndex, Read, Bash, WebFetch, WebSearch, TodoWrite",
    );
  });
});
