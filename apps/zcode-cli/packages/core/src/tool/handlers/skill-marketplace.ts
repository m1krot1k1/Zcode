// ============================================================
// Skill Marketplace Tool Handlers
// ============================================================

import {
  CoreErrorType,
  SKILL_INSTALL_TOOL_NAME,
  SKILL_SEARCH_TOOL_NAME,
  SkillInstallInputJsonSchema,
  SkillInstallInputSchema,
  SkillInstallOutputJsonSchema,
  SkillInstallOutputSchema,
  SkillSearchInputJsonSchema,
  SkillSearchInputSchema,
  SkillSearchOutputJsonSchema,
  SkillSearchOutputSchema,
  createCoreError,
  type SkillInstallInput,
  type SkillSearchInput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

const SEARCH_MAX_OUTPUT_BYTES = 16_000;
const INSTALL_MAX_OUTPUT_BYTES = 4_000;

function requireMarketplacePort(context: Parameters<ToolHandler>[1]) {
  const skillPort = context.skillPort;
  if (!skillPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "SkillPort is not configured for skill marketplace tools",
      {
        context: { toolCallId: context.toolCallId, toolName: context.toolName },
        recoverable: false,
      },
    );
  }
  return skillPort;
}

function sanitizeLine(value: string): string {
  return value.replace(/[\r\n\t]+/gu, " ").slice(0, 200);
}

export const skillSearchHandler: ToolHandler = async (input, context) => {
  const { query, owner, limit } = SkillSearchInputSchema.parse(input) as SkillSearchInput;
  const skillPort = requireMarketplacePort(context);
  if (!skillPort.searchMarketplace) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Skill marketplace search is not available in this runtime",
      {
        context: { toolCallId: context.toolCallId, toolName: context.toolName },
        recoverable: false,
      },
    );
  }
  const result = await skillPort.searchMarketplace(
    { query, owner, limit, workingDirectory: context.workingDirectory },
    { signal: context.abortSignal },
  );
  if (result.items.length === 0) {
    return `No skills found for "${sanitizeLine(query)}". Try a broader query.`;
  }
  const lines = [
    `Found ${result.items.length} skills for "${sanitizeLine(query)}":`,
    ...result.items.map((item) => {
      const installs = item.installs === undefined ? "" : ` — ${item.installs} installs`;
      const installed = item.installed ? " [installed]" : "";
      return `- ${sanitizeLine(item.id)} (${sanitizeLine(item.name)})${installs}${installed}`;
    }),
    'Install one with SkillInstall { source: "<source>", skillId: "<skillId>" }. Prefer official sources and high install counts.',
  ];
  return lines.join("\n");
};

export const skillInstallHandler: ToolHandler = async (input, context) => {
  const { source, skillId, scope, overwrite } = SkillInstallInputSchema.parse(
    input,
  ) as SkillInstallInput;
  const skillPort = requireMarketplacePort(context);
  if (!skillPort.installMarketplaceSkill) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Skill marketplace installation is not available in this runtime",
      {
        context: { toolCallId: context.toolCallId, toolName: context.toolName },
        recoverable: false,
      },
    );
  }
  const result = await skillPort.installMarketplaceSkill(
    {
      source,
      skillId,
      scope,
      overwrite,
      workingDirectory: context.workingDirectory,
    },
    { signal: context.abortSignal },
  );
  const action = result.alreadyInstalled ? "already installed" : "installed";
  return [
    `Skill "${sanitizeLine(result.name)}" is ${action} from ${sanitizeLine(result.source)} at ${result.path}.`,
    `Load it now with Skill { skill: "${sanitizeLine(result.name)}" }.`,
    `Files written: ${result.filesWritten}. Scope: ${result.scope}.`,
  ].join("\n");
};

export const skillSearchToolEntry: ToolEntry = {
  capability: "Search the public skills.sh marketplace for installable agent skills",
  metadata: {
    name: SKILL_SEARCH_TOOL_NAME,
    description: `Search the public skills.sh marketplace for installable agent skills.

Use this when the user asks for a capability that may already exist as a skill ("how do I do X", "find a skill for X", "is there a skill that can...").
- Returns canonical <source>/<skillId> values plus install counts.
- Prefer official sources (vercel-labs, anthropics) and skills with 1K+ installs; treat anything under 100 installs with caution.
- After choosing, call SkillInstall with the exact source and skillId, then call Skill with the installed name.
- Never install a skill merely because it appeared in search results; verify the source and install count first.`,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 30_000,
    maxOutputBytes: SEARCH_MAX_OUTPUT_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
    shouldDefer: true,
  },
  handler: skillSearchHandler,
  inputSchema: SkillSearchInputJsonSchema,
  outputSchema: SkillSearchOutputJsonSchema,
  runtimeInputSchema: SkillSearchInputSchema,
  runtimeOutputSchema: SkillSearchOutputSchema,
  permission: {
    permission: "skill.search",
    reason: "Search the public skills.sh marketplace",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["input"],
  },
  resultBudget: {
    maxInlineBytes: SEARCH_MAX_OUTPUT_BYTES,
    maxModelBytes: SEARCH_MAX_OUTPUT_BYTES,
    strategy: "truncate",
    preview: { maxBytes: SEARCH_MAX_OUTPUT_BYTES, direction: "head" },
  },
  timeout: { defaultMs: 30_000, maxMs: 30_000, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "Skill search was cancelled before results were returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

export const skillInstallToolEntry: ToolEntry = {
  capability: "Install a skill from the public skills.sh marketplace into the workspace",
  metadata: {
    name: SKILL_INSTALL_TOOL_NAME,
    description: `Install a skill from the public skills.sh marketplace into .agents/skills.

Use the exact source and skillId returned by SkillSearch. The skill is validated (relative paths only, SKILL.md required) and written to disk; nothing from the bundle is executed.
- Default scope is the workspace; use scope "user" only for a cross-workspace capability.
- Existing hand-written skills with the same slug are never overwritten; marketplace copies can be replaced with overwrite: true.
- After install, call Skill with the returned name to load the instructions immediately.`,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: 60_000,
    maxOutputBytes: INSTALL_MAX_OUTPUT_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: false,
    shouldDefer: true,
  },
  handler: skillInstallHandler,
  inputSchema: SkillInstallInputJsonSchema,
  outputSchema: SkillInstallOutputJsonSchema,
  runtimeInputSchema: SkillInstallInputSchema,
  runtimeOutputSchema: SkillInstallOutputSchema,
  permission: {
    permission: "skill.install",
    reason: "Install an external skill into the workspace .agents/skills directory",
    riskLevel: "medium",
    sideEffectScope: "workspace",
    needsApproval: false,
    patternSources: ["input"],
  },
  resultBudget: {
    maxInlineBytes: INSTALL_MAX_OUTPUT_BYTES,
    maxModelBytes: INSTALL_MAX_OUTPUT_BYTES,
    strategy: "truncate",
    preview: { maxBytes: INSTALL_MAX_OUTPUT_BYTES, direction: "head" },
  },
  timeout: { defaultMs: 60_000, maxMs: 60_000, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "Skill installation was cancelled; partial files may remain",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
