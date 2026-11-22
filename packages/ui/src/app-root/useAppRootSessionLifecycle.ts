import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { IServiceAccessor } from "./contract.ts";
import { useWorkspaceSessionReload } from "@/app-shell/useWorkspaceSessionReload.js";
import { useWorkspaceShellLifecycle } from "@/app-shell/useWorkspaceShellLifecycle.js";
import { useEnsureWorkspaceMcpLoaded } from "@/hooks/useEnsureWorkspaceMcpLoaded.js";
import type { BrowserNavigationRequest } from "@/hooks/useAppPanels.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { TaskChatMessage as TestChatMessage } from "@/lib/taskChatMessageTypes.js";

/**
 * Lifecycle workspace-сессии App: сброс browser-навигации и тестовых сообщений
 * при смене workspace, загрузка MCP, тестовый канал сообщений и перезапуск сессии.
 */
export function useAppRootSessionLifecycle({
  workspaceAbsPath,
  workspaceIdentity,
  workspaceRpcReady,
  reloadSessionDisabled,
  services,
  setBrowserNavigationRequest,
}: {
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  workspaceRpcReady: boolean;
  reloadSessionDisabled: boolean;
  services: IServiceAccessor;
  setBrowserNavigationRequest: Dispatch<SetStateAction<BrowserNavigationRequest | null>>;
}) {
  const { intl } = useZCodeIntl();
  const [testMessages, setTestMessages] = useState<TestChatMessage[] | null>(null);

  useWorkspaceShellLifecycle({
    workspaceAbsPath,
    workspaceIdentity,
    services,
    setBrowserNavigationRequest,
    setTestMessages,
  });

  useEnsureWorkspaceMcpLoaded(workspaceAbsPath, workspaceIdentity, workspaceRpcReady);

  const { reloadSessionPending, handleReloadSession } = useWorkspaceSessionReload({
    intl,
    services,
    workspaceAbsPath,
    reloadSessionDisabled,
  });

  return { testMessages, setTestMessages, reloadSessionPending, handleReloadSession };
}
