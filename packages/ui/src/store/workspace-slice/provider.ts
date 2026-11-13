import {
  normalizeAgentProviderToZCodeAgent,
  type ModelSelectionResolution,
  type ZCodeProvider,
} from "@zcode/shared";
import { updateWorkspaceState } from "@/store/zcodeSessionStoreSelectors.js";
import type { WorkspaceSliceSet } from "./types.js";

export function createProviderActions(set: WorkspaceSliceSet) {
  return {
    bindRuntimeProvider: (
      workspacePath: string,
      provider: ZCodeProvider,
      workspaceIdentity?: string,
    ) =>
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            selectedProvider: normalizeAgentProviderToZCodeAgent(provider),
          }),
          workspaceIdentity,
        ),
      ),

    setModelSelectionResolution: (
      workspacePath: string,
      resolution: Pick<
        ModelSelectionResolution,
        "selectedSupplierKey" | "isGhostSupplier" | "supplierMismatchReason"
      >,
      workspaceIdentity?: string,
    ) => {
      set((state) =>
        updateWorkspaceState(
          state,
          workspacePath,
          (current) => ({
            ...current,
            selectedSupplierKey: resolution.selectedSupplierKey,
            isGhostSupplier: resolution.isGhostSupplier,
            supplierMismatchReason: resolution.supplierMismatchReason,
          }),
          workspaceIdentity,
        ),
      );
    },
  };
}
