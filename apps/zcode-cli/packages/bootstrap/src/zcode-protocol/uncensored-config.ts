import {
  zcodeProtocolMethods,
  zcodeUncensoredGetConfigResultSchema,
  type ZCodeUncensoredGetConfigResult,
} from "@zcode/shared";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

/** Trusted CLI → Host reverse RPC; the Host reads the secret only while building the answer. */
const UNCENSORED_CONFIG_TIMEOUT_MS = 30_000;

export interface CliUncensoredConfigPort {
  getConfig(input: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeUncensoredGetConfigResult>;
}

/**
 * CLI-side port for the Host-owned uncensored provider settings. One request per takeover
 * attempt; transport/schema failure surfaces as a takeover `error` without any model call.
 */
export function createUncensoredConfigPort(
  context: ZCodeProtocolAgentServerContext,
): CliUncensoredConfigPort {
  return {
    async getConfig(input) {
      const config = await context.requestClient(
        zcodeProtocolMethods.uncensoredGetConfig,
        {
          workspacePath: input.workspacePath,
          ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
        },
        zcodeUncensoredGetConfigResultSchema,
        { timeoutMs: UNCENSORED_CONFIG_TIMEOUT_MS },
      );
      // Host создаёт/обновляет mirror-провайдера во время этого же RPC. Без refresh
      // CLI Registry остаётся на снимке старта, и providerId из ответа не резолвится
      // («Provider Registry 中不存在 Provider»). Ошибка refresh не отменяет raw fallback.
      try {
        await context.deps.refreshProviderRegistry?.("uncensored-takeover");
      } catch (error) {
        context.logger?.warn("Provider registry refresh before uncensored takeover failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return config;
    },
  };
}
