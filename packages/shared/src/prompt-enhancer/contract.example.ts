import {
  promptEnhanceRequestSchema,
  promptEnhanceResultSchema,
  type PromptEnhanceRequest,
  type PromptEnhanceResult,
} from "./contract.js";

/** Composer prompt with one protected @file mention, as the desktop composer sends it. */
export function buildChatPromptEnhanceRequest(draftText: string): PromptEnhanceRequest {
  return promptEnhanceRequestSchema.parse({
    requestId: "req_enhance_composer_1",
    workspacePath: "/repo/zcode",
    target: "chat_user_prompt",
    style: "structured_engineering",
    draftText,
    preservedMentions: [
      {
        kind: "file",
        value: "packages/ui/src/hooks/useCommands.ts",
        displayText: "@useCommands.ts",
      },
    ],
    activeFilePaths: ["packages/ui/src/hooks/useCommands.ts"],
  });
}

/** The same wire shape tightens an author's custom system prompt instead of a chat draft. */
export function buildCustomSystemPromptEnhanceRequest(promptBody: string): PromptEnhanceRequest {
  return promptEnhanceRequestSchema.parse({
    requestId: "req_enhance_system_1",
    workspacePath: "/repo/zcode",
    workspaceIdentity: "remote:zcode-prod",
    target: "custom_system_prompt",
    style: "deep_architectural",
    draftText: promptBody,
    collaborationMode: "plan",
  });
}

/** Consumers read only `enhancedText`; the rest explains provenance without leaking contents. */
export function applyEnhancedText(result: PromptEnhanceResult): string {
  const parsed = promptEnhanceResultSchema.parse(result);
  return parsed.enhancedText;
}
