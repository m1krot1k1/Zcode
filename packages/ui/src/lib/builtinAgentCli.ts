import { type ZCodeProvider } from "@zcode/shared";
const INSTALLABLE_AGENT_CLI_PROVIDERS: ZCodeProvider[] = [];

type BuiltinAgentCliStatus = "enabled" | "enabling" | "disabling" | "disabled";function requiresBuiltinAgentCliInstall(provider: ZCodeProvider): boolean {
  return INSTALLABLE_AGENT_CLI_PROVIDERS.includes(provider);
}

export function resolveBuiltinAgentCliStatus(params: {
  provider: ZCodeProvider;
  enabledProviders: readonly ZCodeProvider[];
  enablingProvider: ZCodeProvider | null;
  disablingProvider: ZCodeProvider | null;
}): BuiltinAgentCliStatus {
  // Bugfix: 非安装型内置 agent provider 已经由当前运行时提供，不依赖 settings.enabledBuiltinAgentCliProviders。
  // 这里统一返回 enabled，避免设置缺省、热更新或旧配置把 glm 误判成 disabled 并锁住发送入口。
  if (!requiresBuiltinAgentCliInstall(params.provider)) {
    return "enabled";
  }

  if (params.enablingProvider === params.provider) {
    return "enabling";
  }

  if (params.disablingProvider === params.provider) {
    return "disabling";
  }

  return params.enabledProviders.includes(params.provider) ? "enabled" : "disabled";
}