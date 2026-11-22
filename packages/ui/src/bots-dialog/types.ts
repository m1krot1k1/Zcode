import type { Dispatch, SetStateAction } from "react";
import type {
  BotConfig,
  BotProvider,
  BotServiceStatus,
  BotState,
  BotWorkspaceRef,
  BotsConfigFile,
} from "@zcode/shared";
import type { useServices } from "@/hooks/useServices.js";

/**
 * UI 侧使用访问器返回的 botsService 形状，不直接 import @zcode/services。
 * 组件只依赖 botsService 的方法签名；服务实现的类型收口在 hooks/useServices。
 */
export type BotsService = ReturnType<typeof useServices>["botsService"];

/** 保存 Bot 的统一入口：写入凭据、更新配置、切换选中项并触发刷新。 */
export type SaveBot = (
  bot: BotConfig,
  secrets?: { credentialValue?: string },
) => Promise<BotConfig>;

/** useBotsConfig 暴露的数据装载结果，供绑定码/注册/凭据等 hook 共享。 */
export interface BotsDialogData {
  config: BotsConfigFile;
  setConfig: Dispatch<SetStateAction<BotsConfigFile>>;
  workspaceRefs: BotWorkspaceRef[];
  status: BotServiceStatus | null;
  botStates: BotState[];
  setBotStates: Dispatch<SetStateAction<BotState[]>>;
  selectedBotId: string | null;
  setSelectedBotId: Dispatch<SetStateAction<string | null>>;
  selectedBot: BotConfig | null;
  selectedBotState: BotState | null;
  creatingBot: boolean;
  setCreatingBot: Dispatch<SetStateAction<boolean>>;
  configLoaded: boolean;
  creatingProvider: BotProvider | null;
  setCreatingProvider: Dispatch<SetStateAction<BotProvider | null>>;
  /** 凭据草稿；保存成功后由 saveBot 统一清空，选中 Bot 变化时也重置。 */
  credentialValue: string;
  setCredentialValue: Dispatch<SetStateAction<string>>;
  fallbackBotName: string;
  refresh: () => Promise<void>;
  saveBot: SaveBot;
}
