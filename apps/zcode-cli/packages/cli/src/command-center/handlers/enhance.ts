import type { TuiSubmitPromptResult } from "@zcode/tui";
import { formatEnhanceOutcome, type EnhanceCommandOutcome } from "../../enhance-command.js";
import type { CommandCenterDeps } from "../types.js";

/**
 * `/enhance` в command center.
 *
 * Handler не создаёт модель сам: он вызывает `deps.enhancePrompt`, которую владелец App
 * (TUI или headless) собирает поверх `AgentRuntime`. Так command center остаётся без
 * зависимости на конкретный runtime и работает по одному контракту в обоих режимах.
 */
export async function handleEnhanceCommand(
  args: string,
  deps: CommandCenterDeps,
  options: { abortSignal?: AbortSignal } = {},
): Promise<TuiSubmitPromptResult> {
  const draft = args.trim();
  if (draft.length === 0) {
    return { mode: deps.getMode?.(), response: "Usage: /enhance <draft prompt>" };
  }
  if (!deps.enhancePrompt) {
    return {
      mode: deps.getMode?.(),
      response: "Prompt enhancement is not available in this client.",
    };
  }
  let outcome: EnhanceCommandOutcome | null;
  try {
    outcome = await deps.enhancePrompt(draft, {
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    });
  } catch (error) {
    return {
      mode: deps.getMode?.(),
      response: `Enhance failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!outcome) {
    return { mode: deps.getMode?.(), response: "Prompt enhancement was cancelled." };
  }
  return { mode: deps.getMode?.(), response: formatEnhanceOutcome(outcome) };
}
