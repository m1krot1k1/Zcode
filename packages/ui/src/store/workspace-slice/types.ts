import type { ZCodeSessionStoreState } from "@/store/zcodeSessionStoreTypes.js";

/** Zustand `set`, суженный до состояния session store. */
export type WorkspaceSliceSet = (
  partial:
    | ZCodeSessionStoreState
    | Partial<ZCodeSessionStoreState>
    | ((state: ZCodeSessionStoreState) => ZCodeSessionStoreState | Partial<ZCodeSessionStoreState>),
) => void;
