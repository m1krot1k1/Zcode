import type { BotPermissionOptionDisplayKind } from "./botsServiceTypes.js";
import { normalizeText } from "./botsServiceSupport.js";
import { formatBotMessage } from "./messages.js";
import {
  type BotProvider,
  type BotReplyGranularity,
  type BotWorkspaceRef,
  type Locale,
  type ModelSelection,
  type SelectionPrompt,
  ZCODE_AGENT_PROVIDER,
  type ZCodePermissionOption,
  type ZCodePermissionRequest,
  decodeCustomModelValue,
  encodeCustomModelValue,
  getPermissionRequestPreview,
  getSupportedBotReplyGranularities,
} from "@zcode/shared";

export function formatBotModelSelectionValue(
  selection: ModelSelection | undefined,
): string | undefined {
  if (!selection) return undefined;
  return selection.providerId === ZCODE_AGENT_PROVIDER
    ? selection.modelId
    : encodeCustomModelValue(selection.providerId, selection.modelId);
}

export function parseBotModelOptionValue(value: string): ModelSelection | undefined {
  const decoded = decodeCustomModelValue(value);
  if (decoded?.providerId && decoded.modelName) {
    return { providerId: decoded.providerId, modelId: decoded.modelName };
  }
  const separatorIndex = value.indexOf("/");
  if (separatorIndex > 0 && separatorIndex < value.length - 1) {
    return {
      providerId: value.slice(0, separatorIndex),
      modelId: value.slice(separatorIndex + 1),
    };
  }
  return value.trim() ? { providerId: ZCODE_AGENT_PROVIDER, modelId: value.trim() } : undefined;
}

const BOT_REPLY_GRANULARITY_OPTIONS = [
  {
    id: "assistant_changes",
    label: { "zh-CN": "标准回复", "en-US": "Standard reply" },
    aliases: ["assistant", "assistant_changes", "normal", "default", "standard", "标准回复"],
  },
  {
    id: "assistant_toolcalls_changes",
    label: { "zh-CN": "完整回复", "en-US": "Full reply" },
    aliases: ["full", "tool", "toolcalls", "assistant_toolcalls_changes", "完整回复"],
  },
  {
    id: "summary_changes",
    label: { "zh-CN": "摘要回复", "en-US": "Summary reply" },
    aliases: ["summary", "summary_changes", "latest", "摘要回复"],
  },
  {
    id: "streaming_card",
    label: { "zh-CN": "流式卡片", "en-US": "Streaming card" },
    aliases: ["stream", "streaming", "streaming_card", "流式", "流式卡片"],
  },
] as const satisfies ReadonlyArray<{
  id: BotReplyGranularity;
  label: Record<"zh-CN" | "en-US", string>;
  aliases: readonly string[];
}>;

export function getReplyGranularityOptions(locale: Locale | undefined, provider?: BotProvider) {
  const messageLocale = locale === "en-US" ? "en-US" : "zh-CN";
  const supportedIds = provider ? new Set(getSupportedBotReplyGranularities(provider)) : null;
  return BOT_REPLY_GRANULARITY_OPTIONS.filter(
    (option) => !supportedIds || supportedIds.has(option.id),
  ).map((option) => ({
    id: option.id,
    label: option.label[messageLocale],
  }));
}

export function resolveReplyGranularityByValue(
  value: string,
  locale: Locale | undefined,
  provider?: BotProvider,
) {
  const trimmed = value.trim();
  const index = Number.parseInt(trimmed, 10);
  const options = getReplyGranularityOptions(locale, provider);
  if (Number.isFinite(index) && index > 0) {
    return options[index - 1] ?? null;
  }
  const normalized = normalizeText(trimmed);
  const option = BOT_REPLY_GRANULARITY_OPTIONS.find(
    (item) =>
      (item.aliases as readonly string[]).includes(normalized) ||
      normalizeText(item.label["zh-CN"]) === normalized ||
      normalizeText(item.label["en-US"]) === normalized,
  );
  return option ? (options.find((item) => item.id === option.id) ?? null) : null;
}

export function resolveOptionByValue<T extends { id: string; label: string }>(
  items: T[],
  value: string,
): T | null {
  const trimmed = value.trim();
  if (/^[1-9]\d*$/u.test(trimmed)) {
    const index = Number.parseInt(trimmed, 10);
    return items[index - 1] ?? null;
  }
  const normalized = normalizeText(trimmed);
  return (
    items.find(
      (item) => normalizeText(item.id) === normalized || normalizeText(item.label) === normalized,
    ) ?? null
  );
}

export function isSelectionIndexValue(value: string): boolean {
  return /^[1-9]\d*$/u.test(value.trim());
}

export function formatSelectionFallback(selection: SelectionPrompt, locale?: Locale): string {
  const lines = selection.options.map((option, index) => {
    const description = option.description ? ` ${option.description}` : "";
    return `${index + 1}. ${option.label}${description}`;
  });
  // Bugfix: 微信这类纯文本通道没有原生选项卡，之前把完整 slash command 和长路径展开，
  // workspace/remote identity 会把消息刷得很长。这里只展示编号，数字解析仍走 pending selection。
  if (selection.showCancel === false) {
    return `${selection.title}\n${lines.join("\n")}\n\n${formatBotMessage(locale, "selectionTextHintNoCancel")}`;
  }
  const cancelLabel = selection.cancelLabel ?? formatBotMessage(locale, "selectionCancelOption");
  return `${selection.title}\n0. ${cancelLabel}\n${lines.join("\n")}\n\n${formatBotMessage(locale, "selectionTextHint")}`;
}

const BOT_PERMISSION_OPTION_PRIORITY = {
  allowOnce: 0,
  allowAlways: 1,
  rejectOnce: 2,
  rejectAlways: 3,
  custom: 4,
} as const satisfies Record<BotPermissionOptionDisplayKind, number>;

function getBotPermissionOptionDisplayKind(
  option: ZCodePermissionOption,
): BotPermissionOptionDisplayKind {
  const text = `${option.optionId} ${option.kind} ${option.name}`.toLowerCase();
  const isAlways =
    /\b(always|persistent|permanent|remember)\b/u.test(text) ||
    /始终|永久|记住|不再询问/u.test(text);
  const isAllow = /\b(allow|approve|accept|yes)\b/u.test(text) || /允许|同意|批准/u.test(text);
  const isReject = /\b(deny|reject|decline|no)\b/u.test(text) || /拒绝|不允许|否/u.test(text);
  if (isAllow) {
    return isAlways ? "allowAlways" : "allowOnce";
  }
  if (isReject) {
    return isAlways ? "rejectAlways" : "rejectOnce";
  }
  return "custom";
}

export function sortBotPermissionOptions(
  options: readonly ZCodePermissionOption[],
): ZCodePermissionOption[] {
  return [...options].sort((left, right) => {
    const leftPriority = BOT_PERMISSION_OPTION_PRIORITY[getBotPermissionOptionDisplayKind(left)];
    const rightPriority = BOT_PERMISSION_OPTION_PRIORITY[getBotPermissionOptionDisplayKind(right)];
    return leftPriority - rightPriority;
  });
}

export function formatBotPermissionOptionLabel(
  option: ZCodePermissionOption,
  locale?: Locale,
): string {
  const displayKind = getBotPermissionOptionDisplayKind(option);
  if (locale === "en-US") {
    switch (displayKind) {
      case "allowOnce":
        return "Allow";
      case "allowAlways":
        return "Always Allow";
      case "rejectOnce":
        return "Deny";
      case "rejectAlways":
        return "Always Deny";
      case "custom":
        return option.name;
    }
  }
  switch (displayKind) {
    case "allowOnce":
      return "允许";
    case "allowAlways":
      return "始终允许";
    case "rejectOnce":
      return "拒绝";
    case "rejectAlways":
      return "始终拒绝";
    case "custom":
      return option.name;
  }
}

export function formatBotPermissionOptionDescription(
  option: ZCodePermissionOption,
  request: Pick<ZCodePermissionRequest, "title" | "description" | "kind" | "raw">,
  locale?: Locale,
): string | undefined {
  const displayKind = getBotPermissionOptionDisplayKind(option);
  if (displayKind === "custom") {
    return option.kind;
  }
  const scope = getPermissionRequestPreview(request).scope;
  if (locale === "en-US") {
    if (displayKind === "allowOnce") {
      return "Allow this time only";
    }
    if (displayKind === "rejectOnce") {
      return "Reject this time";
    }
    if (displayKind === "allowAlways") {
      return scope === "command"
        ? "Do not ask again for the same command"
        : scope === "file"
          ? "Do not ask again for the same file operation"
          : "Do not ask again for the same permission request";
    }
    return scope === "command"
      ? "Always reject the same command"
      : scope === "file"
        ? "Always reject the same file operation"
        : "Always reject the same permission request";
  }
  if (displayKind === "allowOnce") {
    return "仅允许这一次";
  }
  if (displayKind === "rejectOnce") {
    return "这次先拒绝";
  }
  if (displayKind === "allowAlways") {
    return scope === "command"
      ? "后续相同命令不再询问"
      : scope === "file"
        ? "后续相同文件操作不再询问"
        : "后续相同权限请求不再询问";
  }
  return scope === "command"
    ? "后续相同命令也会直接拒绝"
    : scope === "file"
      ? "后续相同文件操作也会直接拒绝"
      : "后续相同权限请求也会直接拒绝";
}

export function isBotPermissionRejectOption(option: ZCodePermissionOption): boolean {
  const displayKind = getBotPermissionOptionDisplayKind(option);
  return displayKind === "rejectOnce" || displayKind === "rejectAlways";
}

export function stripModelProviderDescriptionsForTextSelection(
  selection: SelectionPrompt,
): SelectionPrompt {
  if (selection.action !== "model.provider.set") {
    return selection;
  }
  return {
    ...selection,
    options: selection.options.map((option) => ({
      ...option,
      description: undefined,
    })),
  };
}

export function formatWorkspaceOptionLabel(workspace: BotWorkspaceRef, locale?: Locale): string {
  if (!workspace.workspaceIdentity) {
    return workspace.label;
  }
  const remoteLabel = locale === "en-US" ? "[Remote]" : "[远端]";
  return `${workspace.label} ${remoteLabel}`;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
