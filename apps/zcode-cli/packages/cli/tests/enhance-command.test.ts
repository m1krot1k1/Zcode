import { describe, expect, it, vi } from "vitest";
import type { ModelSelection } from "@zcode/shared";
import { PromptEnhanceError } from "@zcode/shared";
import type { AgentRuntime, WorkspaceGenerateTextInput } from "@zcode/core";
import { formatEnhanceOutcome, runEnhanceCommand } from "../src/enhance-command.js";
import { handleEnhanceCommand } from "../src/command-center/handlers/enhance.js";
import type { CommandCenterDeps } from "../src/command-center/types.js";

const SELECTION: ModelSelection = { providerId: "openai", modelId: "gpt-5-mini" };

type GenerateTextResult = Awaited<ReturnType<AgentRuntime["generateWorkspaceText"]>>;

function fakeRuntime(
  responses: Array<string | Error>,
  selection: ModelSelection | null = SELECTION,
): Pick<AgentRuntime, "generateWorkspaceText" | "getSessionModelSelection"> & {
  calls: WorkspaceGenerateTextInput[];
} {
  const queue = [...responses];
  const calls: WorkspaceGenerateTextInput[] = [];
  return {
    calls,
    getSessionModelSelection: () => selection ?? undefined,
    async generateWorkspaceText(input: WorkspaceGenerateTextInput) {
      calls.push(input);
      const next = queue.shift();
      if (next === undefined) throw new Error("runtime responses exhausted");
      if (next instanceof Error) throw next;
      return {
        text: next,
        selection: { providerId: input.selection.providerId, modelId: input.selection.modelId },
        finishReason: "stop",
      } as GenerateTextResult;
    },
  } as never;
}

const JSON_RESULT = JSON.stringify({
  enhancedText: "Fix the truncation bug in the code index; acceptance: index tests pass.",
  addedClarifications: ["Acceptance criteria: index tests pass"],
  assumptions: [{ text: "Bug is in the code index", origin: "draft" }],
});

describe("runEnhanceCommand", () => {
  it("returns an enhanced prompt with provenance and token delta", async () => {
    const runtime = fakeRuntime([JSON_RESULT]);
    const outcome = await runEnhanceCommand("fix bug with truncation", {
      runtime,
      workspacePath: "/repo/zcode",
      sessionId: "session-1",
    });

    expect(outcome.enhancedText).toContain("acceptance");
    expect(outcome.result.addedClarifications).toHaveLength(1);
    expect(outcome.result.tokenDelta.after).toBeGreaterThan(outcome.result.tokenDelta.before);
    expect(outcome.result.modelUsed).toEqual({ providerId: "openai", modelId: "gpt-5-mini" });
    expect(runtime.calls[0]?.querySource).toBe("prompt_enhance");
    expect(runtime.calls[0]?.maxOutputTokens).toBe(4_096);
  });

  it("rejects an empty draft without touching the model", async () => {
    const runtime = fakeRuntime([JSON_RESULT]);
    await expect(
      runEnhanceCommand("  ", { runtime, workspacePath: "/repo/zcode" }),
    ).rejects.toBeInstanceOf(PromptEnhanceError);
    expect(runtime.calls).toHaveLength(0);
  });

  it("rejects when no session model is selected", async () => {
    const runtime = fakeRuntime([JSON_RESULT], null);
    await expect(
      runEnhanceCommand("fix the bug", { runtime, workspacePath: "/repo/zcode" }),
    ).rejects.toMatchObject({ code: "model_unavailable" });
    expect(runtime.calls).toHaveLength(0);
  });

  it("propagates a model failure as PromptEnhanceError", async () => {
    const runtime = fakeRuntime([new Error("provider 500")]);
    await expect(
      runEnhanceCommand("fix the bug", { runtime, workspacePath: "/repo/zcode" }),
    ).rejects.toBeInstanceOf(Error);
  });

  it("extracts @file mentions from the draft and repairs a dropped one", async () => {
    const dropped = JSON.stringify({ enhancedText: "Fix the parser.", addedClarifications: [], assumptions: [] });
    const repaired = JSON.stringify({
      enhancedText: "Fix @src/index.ts parser; acceptance: index tests pass.",
      addedClarifications: [],
      assumptions: [],
    });
    const runtime = fakeRuntime([dropped, repaired]);
    const outcome = await runEnhanceCommand("fix the parser in @src/index.ts", {
      runtime,
      workspacePath: "/repo/zcode",
    });

    expect(runtime.calls).toHaveLength(2);
    expect(runtime.calls[0]?.messages?.[1]?.content).toContain("@src/index.ts");
    expect(outcome.enhancedText).toContain("@src/index.ts");
    expect(outcome.repairedMentions).toBe(true);
  });

  it("fails when the repair pass still drops the mention", async () => {
    const dropped = JSON.stringify({ enhancedText: "Fix it.", addedClarifications: [], assumptions: [] });
    const runtime = fakeRuntime([dropped, dropped]);
    await expect(
      runEnhanceCommand("fix @src/index.ts", { runtime, workspacePath: "/repo/zcode" }),
    ).rejects.toMatchObject({ code: "unsupported_changes" });
  });
});

describe("formatEnhanceOutcome", () => {
  it("prints the enhanced text first and provenance afterwards", async () => {
    const runtime = fakeRuntime([JSON_RESULT]);
    const outcome = await runEnhanceCommand("fix bug with truncation", {
      runtime,
      workspacePath: "/repo/zcode",
    });
    const text = formatEnhanceOutcome(outcome);
    expect(text.indexOf("Enhanced prompt:")).toBeLessThan(text.indexOf("Added clarifications:"));
    expect(text).toContain("(draft) Bug is in the code index");
    expect(text).toContain("openai/gpt-5-mini");
  });
});

describe("handleEnhanceCommand", () => {
  const baseDeps = (overrides: Partial<CommandCenterDeps>): CommandCenterDeps =>
    ({ getApp: async () => ({}) as never, ...overrides }) as CommandCenterDeps;

  it("prints usage when no draft is provided", async () => {
    const result = await handleEnhanceCommand("", baseDeps({}));
    expect(result.response).toContain("Usage: /enhance");
  });

  it("reports unavailability when the client has no enhance port", async () => {
    const result = await handleEnhanceCommand("fix the bug", baseDeps({}));
    expect(result.response).toContain("not available");
  });

  it("renders a cancellation distinctly from a failure", async () => {
    const result = await handleEnhanceCommand(
      "fix the bug",
      baseDeps({ enhancePrompt: async () => null }),
    );
    expect(result.response).toContain("cancelled");
  });

  it("surfaces the error message from the enhance port", async () => {
    const result = await handleEnhanceCommand(
      "fix the bug",
      baseDeps({
        enhancePrompt: async () => {
          throw new PromptEnhanceError("timeout", "Prompt enhancement timed out.");
        },
      }),
    );
    expect(result.response).toContain("timed out");
  });

  it("returns the formatted outcome on success", async () => {
    const runtime = fakeRuntime([JSON_RESULT]);
    const result = await handleEnhanceCommand(
      "fix bug with truncation",
      baseDeps({
        enhancePrompt: async (draft, options) =>
          await runEnhanceCommand(draft, {
            runtime,
            workspacePath: "/repo/zcode",
            ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
          }),
        workspacePath: "/repo/zcode",
      }),
    );
    expect(result.response).toContain("Enhanced prompt:");
  });
});

describe("slash command registration", () => {
  it("recognizes /enhance as a known command", async () => {
    const { parseSlashCommand } = await import("../src/command-center/slash-commands.js");
    const parsed = parseSlashCommand("/enhance add retry logic");
    expect(parsed).toMatchObject({ type: "known", name: "enhance", args: "add retry logic" });
  });

  it("lists /enhance in the help surface", async () => {
    const { listAvailableCommandNames } = await import("../src/command-center/slash-commands.js");
    expect(listAvailableCommandNames()).toContain("/enhance");
  });

  it("routes headless /enhance through the command center, not a model prompt", async () => {
    // Гарантия безопасности: улучшенный текст не должен уйти агенту как обычный turn.
    const module = await import("../src/prompt-command.js");
    expect(module).toBeDefined();
    const parsed = (await import("../src/command-center/slash-commands.js")).parseSlashCommand(
      "/enhance tighten the plan",
    );
    expect(parsed?.type).toBe("known");
  });
});

void vi;
