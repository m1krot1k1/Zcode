import type { IPlatformService, ZCodePluginDiagnostic } from "@zcode/shared";
import type { IServiceAccessor, IPluginManagementService } from "./contract.ts";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import type { usePluginStoreOrder } from "@/hooks/usePluginStoreOrder.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { PluginStoreOpenTarget } from "@/lib/pluginStoreNavigation.js";
import type { useMarketPluginUi } from "@/plugin-ui/index.js";
import type { PluginStoreActions } from "@/settings/PluginStoreCard.js";
import type { PluginStoreTab } from "@/settings/PluginStoreListView.js";
import type { StorePluginItem } from "@/settings/pluginStoreListing.js";
import type { usePluginUninstall } from "@/settings/usePluginUninstall.js";
import type {
  PluginManagementState,
  useScopedPluginManagementStore,
} from "@/store/pluginManagementStore.js";

export interface PluginStorePageProps {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isWebRemoteControl?: boolean;
  workspacePath?: string | null;
  workspaceIdentity?: string;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  sessionId?: string | null;
  remoteSessionId?: string | null;
  embedded?: boolean;
  onBack?: () => void;
}

export type PluginStoreView = "store" | "detail" | "manage";

export type PluginStoreIntl = ReturnType<typeof useZCodeIntl>["intl"];

/** UI 只通过 IServiceAccessor 拿服务类型，不手写服务实现专有契约。 */
export type PluginManagementService = IServiceAccessor["pluginManagementService"];

export type SkillsService = IServiceAccessor["skillsService"];

export type PluginManagementStore = ReturnType<typeof useScopedPluginManagementStore>;

export type PluginStoreOrderState = ReturnType<typeof usePluginStoreOrder>;

export type MarketPluginUiController = ReturnType<typeof useMarketPluginUi>;

export type PluginUninstallController = ReturnType<typeof usePluginUninstall>;

export interface PluginStorePageServices {
  platform: IPlatformService;
  intl: PluginStoreIntl;
  locale: string;
  storeOrder: PluginStoreOrderState["order"];
  refreshStoreOrder: PluginStoreOrderState["refresh"];
  pluginManagementService: PluginManagementService;
  skillsService: SkillsService;
  store: PluginManagementStore;
  pluginUi: MarketPluginUiController;
  managementScope: string;
  setManagementScope: Dispatch<SetStateAction<string>>;
}

export interface PluginStoreManagementState {
  plugins: PluginManagementState["plugins"];
  pluginDiagnostics: PluginManagementState["diagnostics"];
  marketplaces: PluginManagementState["marketplaces"];
  marketplaceAvailabilityKnown: PluginManagementState["marketplaceAvailabilityKnown"];
  availablePlugins: PluginManagementState["availablePlugins"];
  installedPlugins: PluginManagementState["installedPlugins"];
  restorableBuiltins: PluginManagementState["restorableBuiltins"];
  loading: PluginManagementState["loading"];
  loadedWorkspacePath: PluginManagementState["workspacePath"];
  loadedWorkspaceIdentity: PluginManagementState["workspaceIdentity"];
  error: PluginManagementState["error"];
  activeOperations: PluginManagementState["activeOperations"];
  cancelRequestOperationIds: PluginManagementState["cancelRequestOperationIds"];
  cancellingOperationIds: PluginManagementState["cancellingOperationIds"];
  describeCache: PluginManagementState["describeCache"];
  initialize: PluginManagementState["initialize"];
  updateMarketplace: PluginManagementState["updateMarketplace"];
  addMarketplace: PluginManagementState["addMarketplace"];
  removeMarketplace: PluginManagementState["removeMarketplace"];
  installPlugin: PluginManagementState["installPlugin"];
  describePlugin: PluginManagementState["describePlugin"];
  updatePlugin: PluginManagementState["updatePlugin"];
  restoreBuiltin: PluginManagementState["restoreBuiltin"];
  setEnabled: PluginManagementState["setEnabled"];
  togglingPluginId: PluginManagementState["togglingPluginId"];
}

export interface PluginStoreCatalogState {
  items: StorePluginItem[];
  itemById: Map<string, StorePluginItem>;
}

export interface PluginStoreViewController {
  view: PluginStoreView;
  setView: Dispatch<SetStateAction<PluginStoreView>>;
  operationService: IPluginManagementService;
  detailPluginId: string | null;
  setDetailPluginId: Dispatch<SetStateAction<string | null>>;
  segment: PluginStoreTab;
  setSegment: Dispatch<SetStateAction<PluginStoreTab>>;
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  refreshing: boolean;
  setRefreshing: Dispatch<SetStateAction<boolean>>;
  sourcesOpen: boolean;
  setSourcesOpen: Dispatch<SetStateAction<boolean>>;
  addSourceOpen: boolean;
  setAddSourceOpen: Dispatch<SetStateAction<boolean>>;
  addMarketplaceError: string | null;
  setAddMarketplaceError: Dispatch<SetStateAction<string | null>>;
  rootRef: RefObject<HTMLDivElement | null>;
  storeScrollTopRef: RefObject<number>;
  initialNavigationTargetRef: RefObject<PluginStoreOpenTarget | null>;
}

export interface PluginStoreNavigationController {
  openDetail: (pluginId: string) => void;
  backToStore: () => void;
}

export interface PluginStoreDetailSyncState {
  detailPluginWarnings: ZCodePluginDiagnostic[];
}

export interface PluginStoreActionsController {
  actions: PluginStoreActions;
  handleRefresh: () => Promise<void>;
  handleUsePrompt: (item: StorePluginItem, prompt: string) => void;
  handleAddMarketplace: (source: string) => Promise<boolean>;
  handleUpdatePlugin: (pluginId: string) => Promise<void>;
  uninstall: PluginUninstallController;
}
