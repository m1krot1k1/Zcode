export {
  DEFAULT_CONVERSATION_WORKSPACE,
  DEFAULT_WORKSPACE,
  getE2EAppDataPaths,
} from "./desktop-app/paths.js";
export {
  clickTestIdByDom,
  clickTestIdByWebDriver,
  dispatchMouseDownByExactTestId,
  getTabLabels,
  hoverTestIdByWebDriver,
  readExactTestIdAttribute,
  setInputValueByTestIdDom,
  waitForTestIdByDom,
  workspaceLabel,
} from "./desktop-app/dom.js";
export { clearAppData, quitElectronAppGracefully } from "./desktop-app/app-data.js";
export type {
  CliConfigSnapshot,
  E2EModelProviderSnapshot,
  E2EProviderKind,
  E2EProviderModality,
  E2EProviderModelSnapshot,
} from "./desktop-app/storage.js";
export {
  createE2EProviderModelSnapshot,
  readAgentsState,
  readModelProvider,
  readModelProviders,
  readSettings,
  removeSeededCredentials,
  resolveE2EProviderRuntimeBaseUrl,
  restoreCliConfig,
  seedCliConfig,
  seedCredentials,
  seedSettings,
  snapshotCliConfig,
} from "./desktop-app/storage.js";
export type { WorkspaceAppProbeParams } from "./desktop-app/workspace.js";
export {
  getActiveWorkspacePath,
  probeWorkspaceAppState,
  waitForDefaultWorkspaceReady,
  waitForWorkspaceApp,
} from "./desktop-app/workspace.js";
export type { ElectronRendererContentSizeSnapshot } from "./desktop-app/windows.js";
export {
  getAllWindowInfo,
  restoreElectronRendererContentSize,
  setCurrentElectronRendererContentSize,
  switchToNewestWindow,
  switchToWorkspaceRendererWindow,
} from "./desktop-app/windows.js";
export {
  clearRecentDocuments,
  clickAboutMenuItem,
  clickDockMenuItem,
  getDockMenuLabels,
  getRecentDocuments,
  isPrimaryWindowMinimized,
  minimizePrimaryWindow,
} from "./desktop-app/app-menu.js";
