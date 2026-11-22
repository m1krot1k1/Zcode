import { normalizeAgentProviderToZCodeAgent, type ZCodeProvider } from "@zcode/shared";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const LAST_SELECTED_AGENT_PROVIDER_STORAGE_KEY = "zcode-last-agent-provider";

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}export function persistLastSelectedAgentProvider(
  provider: ZCodeProvider,
  storage: StorageLike | null = getBrowserStorage(),
) {
  // Bugfix: 迁移到单 ZCode Agent 后，旧本地存储里可能还保存已移除的第三方 provider。
  // 如果继续照读，草稿预热和首发 createTask 会在 UI 层短暂走错 provider。这里统一收敛到 glm。
  storage?.setItem(
    LAST_SELECTED_AGENT_PROVIDER_STORAGE_KEY,
    normalizeAgentProviderToZCodeAgent(provider),
  );
}
