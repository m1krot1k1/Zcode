import { createContext, useContext, type ReactNode } from "react";
import type { RemoteWorkspaceController } from "@/remote/remoteWorkspaceController.js";

const RemoteWorkspaceControllerContext = createContext<RemoteWorkspaceController | null>(null);

export function RemoteWorkspaceControllerProvider({
  controller,
  children,
}: {
  controller: RemoteWorkspaceController;
  children: ReactNode;
}) {
  return (
    <RemoteWorkspaceControllerContext.Provider value={controller}>
      {children}
    </RemoteWorkspaceControllerContext.Provider>
  );
}export function useOptionalRemoteWorkspaceController(): RemoteWorkspaceController | null {
  return useContext(RemoteWorkspaceControllerContext);
}
