// ============================================================
// Skill marketplace tools - search and install skills.sh skills
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const SKILL_SEARCH_TOOL_NAME = "SkillSearch";
export const SKILL_INSTALL_TOOL_NAME = "SkillInstall";

export const SkillSearchInputSchema = z.object({
  query: z
    .string()
    .min(2)
    .max(200)
    .describe("Search query, for example 'react performance' or 'pdf generation'."),
  owner: z
    .string()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u)
    .optional()
    .describe("Optional GitHub owner filter, for example 'vercel-labs'."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Maximum number of results (default 10, max 50)."),
});

export const SkillInstallInputSchema = z.object({
  source: z
    .string()
    .min(3)
    .max(200)
    .describe("skills.sh source in owner/repo form, exactly as returned by SkillSearch."),
  skillId: z
    .string()
    .min(1)
    .max(128)
    .describe("skills.sh skill id/slug, exactly as returned by SkillSearch."),
  scope: z
    .enum(["workspace", "user"])
    .optional()
    .describe("Install into the workspace .agents/skills (default) or the user home."),
  overwrite: z
    .boolean()
    .optional()
    .describe("Replace an existing marketplace-managed copy of the same skill."),
});

export type SkillSearchInput = z.infer<typeof SkillSearchInputSchema>;
export type SkillInstallInput = z.infer<typeof SkillInstallInputSchema>;

export const SkillSearchOutputSchema = z.string();
export const SkillInstallOutputSchema = z.string();

export const SkillSearchInputJsonSchema = toToolJsonSchema(SkillSearchInputSchema);
export const SkillInstallInputJsonSchema = toToolJsonSchema(SkillInstallInputSchema);
export const SkillSearchOutputJsonSchema = toToolJsonSchema(SkillSearchOutputSchema);
export const SkillInstallOutputJsonSchema = toToolJsonSchema(SkillInstallOutputSchema);
