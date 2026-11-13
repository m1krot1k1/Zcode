import type { BotConfig, BotProvider, BotsConfigFile } from "@zcode/shared";
import {
  ALL_BOT_WORKSPACES,
  createUuid,
  DEFAULT_BOT_REPLY_GRANULARITY,
  normalizeBotReplyGranularity,
} from "@zcode/shared";
import { createDefaultCommands } from "@/BotsDialog/shared.js";

export function createEmptyConfig(): BotsConfigFile {
  return { version: 3, bots: [] };
}

export function createDraftBot(params: { provider: BotProvider }): BotConfig {
  // Bugfix: Bot id 只是配置实体身份，不应该带 provider 前缀；
  // 新建时如果看到 telegram-* 这类 id，容易误以为渠道被固定到了 Telegram。
  const id = `bot-${createUuid()}`;
  return {
    id,
    name: "",
    provider: params.provider,
    enabled: true,
    allowedWorkspaces: [ALL_BOT_WORKSPACES],
    allowedCommands: createDefaultCommands(),
    currentOptions: {},
    replyMode: normalizeBotReplyGranularity(params.provider, DEFAULT_BOT_REPLY_GRANULARITY),
  };
}
