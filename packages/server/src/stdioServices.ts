import { createLocalServices, type ZCodeAgentCommandResolver } from "@zcode/services/node";
import type { IChannel } from "@zcode/rpc";
import {
  parseServiceAuthorityMode,
  ZCODE_HTTP_PROXY_FALLBACK_ONLY_ENV_KEY,
  ZCODE_REMOTE_HTTP_PROXY_ENV_KEY,
  ZCODE_REMOTE_NO_PROXY_ENV_KEY,
  ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
} from "@zcode/shared";

interface CreateStdioServicesOptions {
  topicResourceRelayChannel?: () => IChannel;
  env?: Record<string, string | undefined>;
  zcodeBuiltinProviderConfigFilePath: string;
  zcodeAgentCommandResolver?: ZCodeAgentCommandResolver;
}

interface RemoteAgentNetworkOptions {
  httpProxy?: string;
  noProxy?: string;
  /**
   * The proxy is fallback-only: the agent tries its own egress first. Carried as
   * a typed field because the runtime env scrub removes the env key.
   */
  fallbackOnly?: boolean;
}

export function resolveRemoteAgentNetworkFromEnv(
  env: Record<string, string | undefined>,
): RemoteAgentNetworkOptions | undefined {
  if (env[ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY]?.trim() !== "1") {
    return undefined;
  }
  return {
    httpProxy: env[ZCODE_REMOTE_HTTP_PROXY_ENV_KEY]?.trim() || undefined,
    noProxy: env[ZCODE_REMOTE_NO_PROXY_ENV_KEY]?.trim() || undefined,
    // Read the flag here rather than letting it ride along in env: the runtime
    // scrub removes it, so the value has to be carried by this typed field.
    fallbackOnly: env[ZCODE_HTTP_PROXY_FALLBACK_ONLY_ENV_KEY]?.trim() === "1",
  };
}

export function createStdioServices(options: CreateStdioServicesOptions) {
  const env = options.env ?? process.env;
  const authorityModeParseResult = parseServiceAuthorityMode(env);
  const remoteAgentNetwork = resolveRemoteAgentNetworkFromEnv(env);
  // 远程 Desktop 的呈现能力必须从 stdio 入口收到的 authority mode 进入 Services 推导链。
  // 测试注入 resolver 只用于在 spawn 前观察最终命令，不改变生产默认 resolver。
  const services = createLocalServices({
    zcodeBuiltinProviderConfigFilePath: options.zcodeBuiltinProviderConfigFilePath,
    topicResourceRelayChannel: options.topicResourceRelayChannel,
    serviceAuthorityMode: authorityModeParseResult.mode,
    zcodeAgentCommandResolver: options.zcodeAgentCommandResolver,
    remoteAgentNetwork,
  });

  return {
    authorityModeParseResult,
    services,
  };
}
