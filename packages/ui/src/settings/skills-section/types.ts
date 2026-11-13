/**
 * SkillsSection 的 props 与子组件契约。
 * ui 侧依赖的服务/协议类型统一从这里转出，子组件不各自猜测依赖出口。
 */
import type { ReactNode } from "react";
import type {
  Locale,
  RemoteTarget,
  SkillDiagnostic,
  SkillDiagnosticCode,
  SkillSummary,
  ZCodeAvailablePluginSummary,
  ZCodePluginStoreListing,
} from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { StorePluginItem } from "@/settings/pluginStoreListing.js";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import type { IServiceAccessor } from "@zcode/services";

export type { CreateTaskRequest, IServiceAccessor };

export interface SkillsSectionProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  isWebRemoteControl?: boolean;
  scopeFilter: "user" | "workspace";
  searchQuery: string;
  onVisibleCountChange?: (count: number) => void;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onDetailOpenChange?: (open: boolean) => void;
  onOpenPluginStore?: () => void;
  showMarketplaceBreadcrumb?: boolean;
  reportDetailBreadcrumb?: boolean;
  unscopedServices?: IServiceAccessor;
  cacheAuthorityKey?: string;
}

/** 技能作用域标签的解析上下文：workspace 名、插件目录与本地化信息。 */
export interface SkillScopeLabelContext {
  workspaceLabel: string;
  locale: Locale;
  availablePlugins: readonly Pick<
    ZCodeAvailablePluginSummary,
    "name" | "listing"
  >[];
  pluginListingById: ReadonlyMap<string, ZCodePluginStoreListing | undefined>;
}

export type SkillRowIconItem = Pick<StorePluginItem, "name" | "listing">;

export interface SkillRowProps {
  skill: SkillSummary;
  iconItem?: SkillRowIconItem;
  intl: IntlInstance;
  onSelect: (skill: SkillSummary) => void;
  onEnabledChange: (skillId: string, enabled: boolean) => void;
  onDelete: (skill: SkillSummary) => void;
}

export interface SkillListProps {
  skills: SkillSummary[];
  renderRow: (skill: SkillSummary) => ReactNode;
}

export interface SkillsDiagnosticsBannerProps {
  diagnostics: readonly SkillDiagnostic[];
  open: boolean;
  summary: string;
  formatCodeLabel: (code: SkillDiagnosticCode) => string;
  onToggle: () => void;
}

export interface SkillDetailDialogProps {
  skill: SkillSummary | null;
  scopeLabel: string;
  publishedAt: string | null;
  onClose: () => void;
  onOpenPath: (path: string) => void;
}

export interface SkillsInstalledGroupProps {
  skills: SkillSummary[];
  hidden: boolean;
  showEmptyState: boolean;
  count: number;
  headerActions: ReactNode;
  canImport: boolean;
  renderRow: (skill: SkillSummary) => ReactNode;
  onCreateSkill: () => void;
  onImport: () => void;
  onOpenPluginStore?: () => void;
}

/** groupScopedSkillsBySource 的结果按结构取用，避免把投影实现细节带进视图层。 */
export interface SkillsPluginGroup {
  id: string;
  label: string;
  pluginId?: string;
  skills: SkillSummary[];
}

export interface SkillsPluginGroupsProps {
  groups: readonly SkillsPluginGroup[];
  locale: Locale;
  pluginListingById: ReadonlyMap<string, ZCodePluginStoreListing | undefined>;
  availablePlugins: readonly Pick<
    ZCodeAvailablePluginSummary,
    "name" | "listing"
  >[];
  renderRow: (skill: SkillSummary) => ReactNode;
}
