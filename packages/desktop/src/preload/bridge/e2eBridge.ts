import { contextBridge, ipcRenderer } from "electron";
import type {
  ConfigureFinalArmsCustomEventE2ERequest,
  FinalArmsCustomEventE2EEntry,
} from "@zcode/shared";
import { PlatformChannels, shouldEnableE2ETestBridge } from "@zcode/shared";

export function installFinalArmsCustomEventE2EBridge(): void {
  if (!shouldEnableE2ETestBridge(process.env)) return;

  contextBridge.exposeInMainWorld("__zcodeFinalArmsCustomEventsE2E", {
    read: (): Promise<FinalArmsCustomEventE2EEntry[]> =>
      ipcRenderer.invoke(PlatformChannels.ReadFinalArmsCustomEventsE2E),
    clear: (): Promise<void> => ipcRenderer.invoke(PlatformChannels.ClearFinalArmsCustomEventsE2E),
    configure: (request: ConfigureFinalArmsCustomEventE2ERequest): Promise<void> =>
      ipcRenderer.invoke(PlatformChannels.ConfigureFinalArmsCustomEventsE2E, request),
  });
}
