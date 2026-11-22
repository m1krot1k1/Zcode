// ============================================================
// Capability installer tool - MCP servers and plugins
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const CAPABILITY_INSTALL_TOOL_NAME = "InstallCapability";

export const CapabilityInstallInputSchema = z.object({
  kind: z.enum(["mcp", "plugin"]),
  id: z.string().min(1).max(200),
  /** MCP: full server config (command/args/env or url/headers). */
  config: z.record(z.unknown()).optional(),
  marketplace: z.string().min(1).max(200).optional(),
  pluginName: z.string().min(1).max(200).optional(),
  scope: z.enum(["user", "workspace"]).optional(),
});
export type CapabilityInstallInput = z.infer<typeof CapabilityInstallInputSchema>;
export const CapabilityInstallInputJsonSchema = toToolJsonSchema(CapabilityInstallInputSchema);

export const CapabilityInstallOutputSchema = z.object({
  kind: z.enum(["mcp", "plugin"]),
  id: z.string().min(1),
  status: z.enum(["installed", "already_installed"]),
  requiresReload: z.boolean().optional(),
  evidence: z.string().optional(),
});
export type CapabilityInstallOutput = z.infer<typeof CapabilityInstallOutputSchema>;
export const CapabilityInstallOutputJsonSchema = toToolJsonSchema(CapabilityInstallOutputSchema);
