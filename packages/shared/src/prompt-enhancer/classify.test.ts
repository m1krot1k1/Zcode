import { describe, expect, it } from "vitest";
import { classifyPromptEnhanceTask } from "./classify.js";
import { buildPromptEnhancerSystemPrompt } from "./meta-prompts.js";
import { promptEnhanceRequestSchema } from "./contract.js";

function request(
  draftText: string,
  target: "chat_user_prompt" | "custom_system_prompt" = "chat_user_prompt",
) {
  return promptEnhanceRequestSchema.parse({
    requestId: "req_classify_1",
    workspacePath: "/repo/zcode",
    target,
    style: "structured_engineering",
    draftText,
  });
}

describe("prompt enhance classification", () => {
  it("selects TAG for a short single action", () => {
    const result = classifyPromptEnhanceTask({
      draftText: "rename the button",
      target: "chat_user_prompt",
    });
    expect(result.framework).toBe("tag");
    expect(result.taskKind).toBe("general");
  });

  it("selects RISE for a multi-step coding task", () => {
    const result = classifyPromptEnhanceTask({
      draftText:
        "Implement a TypeScript API endpoint, add tests, then update the release notes and verify the build",
      target: "chat_user_prompt",
    });
    expect(result.domain).toBe("coding");
    expect(result.taskKind).toBe("feature");
    expect(result.framework).toBe("rise");
  });

  it("selects CARE when an example is explicitly requested", () => {
    const result = classifyPromptEnhanceTask({
      draftText:
        "Write a landing page headline in the style of this example, keeping the same tone",
      target: "chat_user_prompt",
    });
    expect(result.framework).toBe("care");
  });

  it("selects ORACLE for a long open-ended brief", () => {
    const result = classifyPromptEnhanceTask({
      draftText:
        "Prepare a comprehensive analysis of our positioning and recommend the strongest direction for the next quarter with supporting evidence and trade-offs",
      target: "custom_system_prompt",
    });
    expect(result.framework).toBe("oracle");
  });

  it("never asks questions and names the selected framework in the system prompt", () => {
    const classification = classifyPromptEnhanceTask({
      draftText: "Implement a feature, add tests, then verify",
      target: "chat_user_prompt",
    });
    const prompt = buildPromptEnhancerSystemPrompt(request("Implement a feature"), classification);
    expect(prompt).toContain("Never ask the author a question");
    expect(prompt).toContain("RISE");
    expect(prompt).toContain("capabilitySuggestions");
    expect(prompt).not.toContain("ask the author what they meant");
  });
});
