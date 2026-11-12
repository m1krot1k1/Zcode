import { useMemo, useSyncExternalStore } from "react";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { getSourceServerStatusRegistry } from "@/store/sourceServerStatusRegistry.js";
const subscribeToNothing = () => () => undefined;const emptyInputs: ReadonlyMap<
  string,
  import("@/lib/remoteConnectionPresentation.js").RemoteConnectionPresentationInput
> = new Map();
const getEmptyInputs = () => emptyInputs;

export function useRemoteDevicePresentationInput(sourceServerId?: string) {
  const management = useBaseWorkspaceServices().sourceServerManagementService;
  const registry = useMemo(
    () => (management ? getSourceServerStatusRegistry(management) : null),
    [management],
  );
  const inputs = useSyncExternalStore(
    registry?.subscribe ?? subscribeToNothing,
    registry?.getInputs ?? getEmptyInputs,
    registry?.getInputs ?? getEmptyInputs,
  );
  return sourceServerId ? inputs.get(sourceServerId) : undefined;
}
