import type { ZCodePreloadApi } from "../../preload/index.js";
import type { PluginSandboxHostBridgeApi } from "../../preload/pluginSandbox/hostBridge.js";

declare global {
  interface Window {
    zcode: ZCodePreloadApi;
    zcodePluginSandbox?: PluginSandboxHostBridgeApi;
  }
}

export {};
