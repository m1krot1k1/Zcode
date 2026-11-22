import type { BotConfig, BotProvider, SelectionPrompt } from "@zcode/shared";

export interface FeishuProviderDeps {
  loadCredential(key: string): Promise<string | null>;
  onDeliveryResult?(bot: BotConfig, error: string | undefined): void;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function getFeishuDomainProvider(bot: Pick<BotConfig, "provider">): "feishu" | "lark" {
  return bot.provider === "lark" ? "lark" : "feishu";
}

export function readFeishuPayloadProvider(payload: Record<string, unknown>): BotProvider {
  return readString(payload, "zcodeProvider") === "lark" ? "lark" : "feishu";
}

export function getFeishuBaseUrl(bot: Pick<BotConfig, "provider">): string {
  return getFeishuDomainProvider(bot) === "lark"
    ? "https://open.larksuite.com"
    : "https://open.feishu.cn";
}

export function readString(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

export function readFeishuCallbackEvent(payload: Record<string, unknown>): Record<string, unknown> {
  const event = isRecord(payload.event) ? payload.event : null;
  return event ?? payload;
}

export function readFeishuChatType(value: string): "private" | "group" {
  return value === "group" || value === "group_chat" ? "group" : "private";
}

export function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function formatSelectionCommand(selection: SelectionPrompt, optionId: string): string {
  if (selection.action === "permission.respond" || selection.action === "queue.cancel") {
    return optionId;
  }
  if (selection.action === "elicitation.respond") {
    return selection.token
      ? `/elicitation ${selection.token} ${optionId}`
      : `/elicitation ${optionId}`;
  }
  if (selection.action === "model.provider.set") {
    return `/model provider ${optionId}`;
  }
  if (selection.action === "model.set") {
    return `/model model ${optionId}`;
  }
  return `/${selection.action.replace(".set", "")} ${optionId}`;
}
