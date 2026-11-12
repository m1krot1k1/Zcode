import type { IPlatformService, TelemetryEventPayload } from "@zcode/shared";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";

export const PROMPT_TEMPLATE_CLICK_EVENT_NAME = "prompt_template_ck";
const PROMPT_TEMPLATE_EVENT_REGION = "app.session";
const PROMPT_TEMPLATE_EVENT_TYPE = "ck";

export interface PromptTemplateClickTelemetryParams {
  templateId: string;
  templateName: string;
  templatePrompt: string;
}

/** FNV-1a 32-bit：只用于识别同一模板 prompt 是否变化，不可逆且不携带正文。 */
function fingerprintPrompt(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function buildPromptTemplateClickTelemetryPayload(
  params: PromptTemplateClickTelemetryParams,
): TelemetryEventPayload {
  return {
    elementName: PROMPT_TEMPLATE_CLICK_EVENT_NAME,
    eventRegion: PROMPT_TEMPLATE_EVENT_REGION,
    eventType: PROMPT_TEMPLATE_EVENT_TYPE,
    eventText: params.templateName,
    eventExtraDetail: {
      template_id: params.templateId,
      // 修复原因：完整模板 prompt 属于用户内容，不能进入遥测；只保留长度与指纹，
      // 仍可用于判断模板是否更新，同时避免泄露实际文案。
      template_prompt_length: String(params.templatePrompt.length),
      template_prompt_hash: fingerprintPrompt(params.templatePrompt),
    },
  };
}

export function reportPromptTemplateClick(
  platform: Pick<IPlatformService, "reportTelemetryEvent">,
  params: PromptTemplateClickTelemetryParams,
): Promise<void> {
  return reportAppTelemetryEvent(
    platform,
    buildPromptTemplateClickTelemetryPayload(params),
    "prompt-template-telemetry",
  );
}
