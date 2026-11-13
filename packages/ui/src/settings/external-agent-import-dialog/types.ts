import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { ISettingsSyncService } from "./contract.ts";
import type {
  SettingsSyncCategory,
  SettingsSyncCommandImportResult,
  SettingsSyncDiscoveryResult,
  SettingsSyncImportMode,
  SettingsSyncMcpServerImportResult,
  SettingsSyncPluginImportResult,
  SettingsSyncSelection,
  SettingsSyncSkillImportResult,
  SettingsSyncSourceCommandSummary,
  SettingsSyncSourceMcpServerSummary,
  SettingsSyncSourcePluginSummary,
  SettingsSyncSourceScope,
  SettingsSyncSourceSkillSummary,
} from "@zcode/shared";

/** 弹窗内部的三个展示阶段。 */
export type ImportStep = "selection" | "importing" | "complete";

export type ImportResourceCategory = Extract<
  SettingsSyncCategory,
  "skills" | "commands" | "plugins" | "mcpServers"
>;

export type ImportItemSummary =
  | SettingsSyncSourceSkillSummary
  | SettingsSyncSourceCommandSummary
  | SettingsSyncSourcePluginSummary
  | SettingsSyncSourceMcpServerSummary;

export type ImportItemResult =
  | SettingsSyncSkillImportResult
  | SettingsSyncCommandImportResult
  | SettingsSyncPluginImportResult
  | SettingsSyncMcpServerImportResult;

export type ImportIntl = IntlInstance;

export interface ExternalAgentImportDialogProps {
  open: boolean;
  workspacePath: string | null | undefined;
  workspaceIdentity?: string;
  // detect/importSelected 携带调用方传入的 target 路径，但 service 曾取自
  // useServices()（当前激活 workspace）。跨 host 时会在 A 的主机上按 B 的路径解析并做
  // symlink/copy 落盘。改为必传，由调用方按 Scope target 解析后注入。
  settingsSyncService: ISettingsSyncService;
  onOpenChange: (open: boolean) => void;
  onImported: () => Promise<void> | void;
}

export interface CategorizedExternalAgentImportDialogProps extends ExternalAgentImportDialogProps {
  category: ImportResourceCategory;
}

export interface ResourceSelectionKeyPayload {
  agent: string;
  category: ImportResourceCategory;
  sourceScope?: SettingsSyncSourceScope;
  resourcePath: string;
}

export interface ExternalAgentImportCategoryState {
  activeScope: SettingsSyncSourceScope;
  discovery: SettingsSyncDiscoveryResult | null;
  error: string | null;
  expandedSourceKeys: string[];
  importMode: SettingsSyncImportMode;
  importTargetScope: SettingsSyncSourceScope;
  loading: boolean;
  selectedCount: number;
  selectedKeys: string[];
  selections: SettingsSyncSelection[];
  totalImportableCount: number;
  loadDiscovery: () => Promise<void>;
  setActiveSourceScope: (scope: SettingsSyncSourceScope) => void;
  setImportMode: (mode: SettingsSyncImportMode) => void;
  setImportTargetScope: (scope: SettingsSyncSourceScope) => void;
  setResourceSelection: (keys: string[], checked: boolean) => void;
  toggleExpanded: (key: string) => void;
  toggleSelection: (key: string) => void;
}
