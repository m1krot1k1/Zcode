// ============================================================
// Capability Install Tool Handler
// ============================================================

import {
  CAPABILITY_INSTALL_TOOL_NAME,
  CapabilityInstallInputJsonSchema,
  CapabilityInstallInputSchema,
  CapabilityInstallOutputJsonSchema,
  CapabilityInstallOutputSchema,
  CoreErrorType,
  createCoreError,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

const capabilityInstallHandler: ToolHandler = async (input, context) => {
  const parsed = CapabilityInstallInputSchema.parse(input);
  const port = context.capabilityInstallPort;
  if (!port) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Capability installer is unavailable in this runtime; configure MCP/plugin through the host environment.",
      {
        context: {
          code: "capability_install_unavailable",
          toolCallId: context.toolCallId,
          toolName: CAPABILITY_INSTALL_TOOL_NAME,
        },
        recoverable: true,
      },
    );
  }
  return port.install(parsed, { signal: context.abortSignal });
};

export const capabilityInstallToolEntry: ToolEntry = {
  capability: "Install an MCP server or plugin after explicit user approval",
  metadata: {
    name: CAPABILITY_INSTALL_TOOL_NAME,
    description:
      "Install an MCP server or plugin after user approval. Call only after Task returns capability_missing, then retry the same Task once. Installed MCP tools are visible to the next child/Task without an app reload; plugin components may require reload when the result says so.",
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    sideEffectScope: "system",
    riskLevel: "high",
    needsApproval: true,
    maxOutputBytes: 16_384,
  },
  handler: capabilityInstallHandler,
  inputSchema: CapabilityInstallInputJsonSchema,
  outputSchema: CapabilityInstallOutputJsonSchema,
  runtimeInputSchema: CapabilityInstallInputSchema,
  runtimeOutputSchema: CapabilityInstallOutputSchema,
  permission: {
    permission: "capability.install",
    reason:
      "InstallCapability connects an MCP server or installs a plugin into the user's environment",
    riskLevel: "high",
    sideEffectScope: "system",
    needsApproval: true,
    patternSources: ["input"],
    denyPriority: "beforeAsk",
    askOptions: { allowAlways: false },
  },
  resultBudget: {
    maxInlineBytes: 16_384,
    maxModelBytes: 16_384,
    strategy: "truncate",
  },
  timeout: { kind: "none" },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "InstallCapability was cancelled before the capability was installed",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
