/**
 * PluginsSection 的公共类型与纯标签样式工具。
 *
 * 外部 props、内部 tab/scope 模型与列表 props 都从这里取，避免子文件重复声明。
 */
import type { ZCodePluginScope } from "@zcode/shared";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import type { IServiceAccessor } from "@zcode/services";
import type { StorePluginItem } from "@/settings/pluginStoreListing.js";
import { getPluginWorkspaceKey } from "@/settings/PluginScopeMenu.js";
import type { ConfigWorkspaceTarget } from "@/workspace-config-catalog/index.js";

export type PluginTabTarget = "plugins" | "mcps" | "skills" | "commands";
export type PluginTab = Exclude<PluginTabTarget, "commands">;

export function normalizePluginTab(tab: PluginTabTarget): PluginTab {
  return tab === "commands" ? "plugins" : tab;
}

export function getPluginTabCountClass(tab: PluginTabTarget, selectedTab: PluginTabTarget): string {
  return tab === selectedTab
    ? "text-ui-sm text-foreground-subtle"
    : "text-ui-sm text-foreground-subtlest";
}

export type PluginScope =
  | { kind: "user"; key: "user" }
  | { kind: "workspace"; key: string; tab: ConfigWorkspaceTarget };

export interface PluginsSectionProps {
  onScopeChange?: (scopeKey: string) => void;
  onOpenUi?: (
    item: StorePluginItem,
    target: ConfigWorkspaceTarget | null,
    enable?: () => Promise<boolean>,
  ) => void;
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isWebRemoteControl?: boolean;
  initialTab?: PluginTabTarget;
  initialScopeKey?: string;
  mode?: "plugin" | "market" | "mcp" | "skill" | "command";
  workspacePath?: string | null;
  workspaceIdentity?: string;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onOpenPluginStore: (returnScopeKey?: string, intent?: "add-marketplace") => void;
  showMarketplaceBreadcrumb?: boolean;
  settingsSourceServerId?: string | null;
  settingsSourceUserWorkspacePath?: string;
}

export interface PluginListProps {
  inMarketplace?: boolean;
  onOpenUi?: PluginsSectionProps["onOpenUi"];
  target: ConfigWorkspaceTarget | null;
  configScope: ZCodePluginScope;
  searchQuery: string;
  isDesktop: boolean;
  isMacDesktop: boolean;
  isWindowsDesktop: boolean;
  isWebRemoteControl: boolean;
  onAdd?: () => void;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onDetailOpenChange?: (open: boolean) => void;
  onOpenPluginStore: (returnScopeKey?: string, intent?: "add-marketplace") => void;
  showMarketplaceBreadcrumb?: boolean;
  onVisibleCountChange?: (count: number) => void;
  unscopedServices?: IServiceAccessor;
  cacheAuthorityKey?: string;
}

export function workspaceKey(tab: ConfigWorkspaceTarget): string {
  return getPluginWorkspaceKey(tab);
}
