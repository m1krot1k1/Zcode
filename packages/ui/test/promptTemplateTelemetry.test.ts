import { describe, expect, it } from "vitest";
import {
  buildPromptTemplateClickTelemetryPayload,
  PROMPT_TEMPLATE_CLICK_EVENT_NAME,
} from "@/lib/promptTemplateTelemetry.js";

describe("prompt template click telemetry", () => {
  it("sends only a length and fingerprint instead of the full prompt", () => {
    const payload = buildPromptTemplateClickTelemetryPayload({
      templateId: "weekly-summary",
      templateName: "周报总结",
      templatePrompt: "请总结最近一周的工作进展。",
    });

    expect(payload).toEqual({
      elementName: PROMPT_TEMPLATE_CLICK_EVENT_NAME,
      eventRegion: "app.session",
      eventType: "ck",
      eventText: "周报总结",
      eventExtraDetail: {
        template_id: "weekly-summary",
        template_prompt_length: String("请总结最近一周的工作进展。".length),
        template_prompt_hash: expect.stringMatching(/^[0-9a-f]{8}$/),
      },
    });
    expect(JSON.stringify(payload)).not.toContain("请总结最近一周的工作进展。");
  });

  it("keeps the fingerprint stable for the same prompt and different for another", () => {
    const first = buildPromptTemplateClickTelemetryPayload({
      templateId: "t",
      templateName: "n",
      templatePrompt: "prompt-a",
    });
    const second = buildPromptTemplateClickTelemetryPayload({
      templateId: "t",
      templateName: "n",
      templatePrompt: "prompt-a",
    });
    const other = buildPromptTemplateClickTelemetryPayload({
      templateId: "t",
      templateName: "n",
      templatePrompt: "prompt-b",
    });

    expect(first.eventExtraDetail.template_prompt_hash).toBe(
      second.eventExtraDetail.template_prompt_hash,
    );
    expect(first.eventExtraDetail.template_prompt_hash).not.toBe(
      other.eventExtraDetail.template_prompt_hash,
    );
  });
});
