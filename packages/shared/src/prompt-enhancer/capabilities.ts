import type { PromptEnhanceCapabilitySuggestion, PromptEnhanceFramework } from "./contract.js";

/**
 * Capability Index/Resolver for prompt enhancement.
 *
 * The index is built from installed capabilities only. The resolver never installs,
 * enables or invokes anything: it annotates a suggestion with the observed installed
 * state, so the UI can offer a separate, explicit consent step. Matching is
 * deterministic and runs locally; no extra model call is made.
 */

export interface PromptEnhanceCapabilityIndexEntry {
  kind: "skill" | "mcp" | "plugin" | "agent";
  id: string;
  name: string;
  description: string;
  installed: boolean;
  enabled: boolean;
}

export interface PromptEnhanceClassificationHint {
  domain: string;
  taskKind: string;
  framework?: PromptEnhanceFramework;
}

export interface BuildCapabilityIndexInput {
  skills?: ReadonlyArray<{
    id?: string;
    name: string;
    description?: string;
    enabled?: boolean;
  }>;
  mcpServers?: ReadonlyArray<{
    name: string;
    description?: string;
    enabled?: boolean;
  }>;
  plugins?: ReadonlyArray<{
    id?: string;
    name: string;
    description?: string;
    enabled?: boolean;
  }>;
  agents?: ReadonlyArray<{
    id?: string;
    name: string;
    description?: string;
    enabled?: boolean;
  }>;
}

export interface ResolvePromptEnhanceCapabilitiesInput {
  draftText: string;
  classification?: PromptEnhanceClassificationHint;
  modelSuggestions?: readonly PromptEnhanceCapabilitySuggestion[];
  index?: readonly PromptEnhanceCapabilityIndexEntry[];
  limit?: number;
}

export const PROMPT_ENHANCE_MAX_CAPABILITY_MATCHES = 6;
const MIN_MATCH_SCORE = 12;

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "into",
  "your",
  "you",
  "use",
  "using",
  "task",
  "code",
  "file",
  "files",
  "add",
  "fix",
  "make",
  "need",
  "needs",
  "please",
  "when",
  "then",
  "skill",
  "agent",
  "mcp",
  "plugin",
  "tool",
  "tools",
]);

/** Deterministic tokenization shared by indexing and matching. */
export function tokenizeCapabilityText(text: string): string[] {
  const tokens = new Set<string>();
  for (const rawPart of text.split(/[^\p{L}\p{N}]+/u)) {
    if (rawPart.length === 0) continue;
    const camelSplit = rawPart
      .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2");
    for (const piece of camelSplit.split(/\s+/u)) {
      const token = piece.toLowerCase();
      if (token.length < 3 || STOP_WORDS.has(token)) continue;
      tokens.add(token);
    }
  }
  return [...tokens];
}

function normalizeCapabilityName(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function pushIndexEntry(
  entries: PromptEnhanceCapabilityIndexEntry[],
  seen: Set<string>,
  entry: PromptEnhanceCapabilityIndexEntry,
): void {
  const key = `${entry.kind}:${normalizeCapabilityName(entry.name)}`;
  if (seen.has(key)) return;
  seen.add(key);
  entries.push(entry);
}

/**
 * Converts service-level installed facts into the resolver index. Every source is
 * optional: a Host without MCP or plugin discovery still gets a useful skill/agent index.
 */
export function buildPromptEnhanceCapabilityIndex(
  input: BuildCapabilityIndexInput,
): PromptEnhanceCapabilityIndexEntry[] {
  const entries: PromptEnhanceCapabilityIndexEntry[] = [];
  const seen = new Set<string>();
  for (const skill of input.skills ?? []) {
    pushIndexEntry(entries, seen, {
      kind: "skill",
      id: skill.id?.trim() || skill.name,
      name: skill.name,
      description: skill.description?.trim() ?? "",
      installed: true,
      enabled: skill.enabled ?? true,
    });
  }
  for (const server of input.mcpServers ?? []) {
    pushIndexEntry(entries, seen, {
      kind: "mcp",
      id: server.name,
      name: server.name,
      description: server.description?.trim() ?? "",
      installed: true,
      enabled: server.enabled ?? true,
    });
  }
  for (const plugin of input.plugins ?? []) {
    pushIndexEntry(entries, seen, {
      kind: "plugin",
      id: plugin.id?.trim() || plugin.name,
      name: plugin.name,
      description: plugin.description?.trim() ?? "",
      installed: true,
      enabled: plugin.enabled ?? true,
    });
  }
  for (const agent of input.agents ?? []) {
    pushIndexEntry(entries, seen, {
      kind: "agent",
      id: agent.id?.trim() || agent.name,
      name: agent.name,
      description: agent.description?.trim() ?? "",
      installed: true,
      enabled: agent.enabled ?? true,
    });
  }
  return entries;
}

function scoreEntry(
  entry: PromptEnhanceCapabilityIndexEntry,
  draftNormalized: string,
  draftTokens: ReadonlySet<string>,
  classification: PromptEnhanceClassificationHint | undefined,
): number {
  const nameNormalized = normalizeCapabilityName(entry.name);
  let score = 0;
  if (nameNormalized.length >= 3 && draftNormalized.includes(nameNormalized)) {
    score += 60;
  }
  for (const token of tokenizeCapabilityText(entry.name)) {
    if (draftTokens.has(token)) score += 18;
  }
  let descriptionHits = 0;
  for (const token of tokenizeCapabilityText(entry.description)) {
    if (!draftTokens.has(token)) continue;
    descriptionHits += 1;
    if (descriptionHits > 4) break;
    score += 3;
  }
  const haystack = `${entry.name} ${entry.description}`.toLowerCase();
  if (classification?.domain && haystack.includes(classification.domain.toLowerCase())) {
    score += 8;
  }
  if (classification?.taskKind && haystack.includes(classification.taskKind.toLowerCase())) {
    score += 6;
  }
  // Skills are the least privileged and most reusable installed unit; prefer them on ties.
  if (entry.kind === "skill") score += 3;
  else if (entry.kind === "mcp") score += 2;
  else score += 1;
  return score;
}

function reasonForEntry(
  entry: PromptEnhanceCapabilityIndexEntry,
  classification: PromptEnhanceClassificationHint | undefined,
): string {
  const scope = classification
    ? `${classification.domain}/${classification.taskKind}`
    : "the draft";
  return `Installed ${entry.kind} "${entry.name}" matches ${scope}.`;
}

/**
 * Merges model proposals with deterministic installed matches.
 *
 * Model proposals keep their reason but gain the observed `installed` flag. Installed
 * entries that share draft terms are appended even when the model forgot them. All
 * results still require explicit consent.
 */
export function resolvePromptEnhanceCapabilities(
  input: ResolvePromptEnhanceCapabilitiesInput,
): PromptEnhanceCapabilitySuggestion[] {
  const limit = input.limit ?? PROMPT_ENHANCE_MAX_CAPABILITY_MATCHES;
  const index = input.index ?? [];
  const resolved: PromptEnhanceCapabilitySuggestion[] = [];
  const seen = new Set<string>();

  const push = (suggestion: PromptEnhanceCapabilitySuggestion): void => {
    if (resolved.length >= limit) return;
    const key = `${suggestion.kind}:${normalizeCapabilityName(suggestion.name)}`;
    if (seen.has(key)) return;
    seen.add(key);
    resolved.push({ ...suggestion, requiresConsent: true });
  };

  for (const suggestion of input.modelSuggestions ?? []) {
    const exactKindMatch = index.find(
      (entry) =>
        entry.kind === suggestion.kind &&
        normalizeCapabilityName(entry.name) === normalizeCapabilityName(suggestion.name),
    );
    const sameNameMatch =
      exactKindMatch ??
      index.find(
        (entry) => normalizeCapabilityName(entry.name) === normalizeCapabilityName(suggestion.name),
      );
    push({
      ...suggestion,
      installed: sameNameMatch?.installed ?? false,
      source: "model",
      requiresConsent: true,
    });
  }

  const draftTokens = new Set(tokenizeCapabilityText(input.draftText));
  const draftNormalized = normalizeCapabilityName(input.draftText);
  const ranked = index
    .filter((entry) => entry.enabled && entry.installed)
    .map((entry) => ({
      entry,
      score: scoreEntry(entry, draftNormalized, draftTokens, input.classification),
    }))
    .filter((candidate) => candidate.score >= MIN_MATCH_SCORE)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.entry.name.localeCompare(right.entry.name);
    });

  for (const { entry } of ranked) {
    push({
      kind: entry.kind,
      name: entry.name,
      reason: reasonForEntry(entry, input.classification),
      installed: true,
      source: "index",
      requiresConsent: true,
    });
  }

  return resolved;
}
