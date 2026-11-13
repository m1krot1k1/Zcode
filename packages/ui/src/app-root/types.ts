import type { useAppPanels } from "@/hooks/useAppPanels.js";

/** Полный результат контроллера панелей — единый источник типов для shell-действий. */
export type AppRootPanels = ReturnType<typeof useAppPanels>;

/** Состояние поиска по задаче/изменениям файлов (совпадает с taskFindNavigationState). */
export interface AppRootTaskFindNavigationState {
  activeIndex: number;
  navigationRequestId: number;
  query: string;
}

/** Резолв RPC-таргета и shell-состояния workspace для App. */
export interface AppRootWorkspaceScope {
  workspaceIdentity?: string;
  workspaceRpcTarget: {
    workspaceIdentity?: string;
    remoteSessionId?: string;
    remoteTarget?: unknown;
  };
  workspaceRpcReady: boolean;
  workspaceReadOnlyReason?: string;
  workspaceShellZCodeState: import("@/app-shell/types.js").WorkspaceShellZCodeState;
  reloadSessionDisabled: boolean;
  activeTaskId: string | null;
  sidePaneOwnerId: string | null;
}
