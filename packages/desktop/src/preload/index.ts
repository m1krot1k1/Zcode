import { contextBridge, ipcRenderer } from "electron";
import type { RendererHeapSample } from "@zcode/shared";
import { PlatformChannels } from "@zcode/shared";
import {
  installArmsRumBridgeIpcForward,
  scheduleArmsEventBridgePatch,
} from "../shared/armsRumBridgeForward.js";
import { installFinalArmsCustomEventE2EBridge } from "./bridge/e2eBridge.js";
import { installRendererProcessTitle } from "./bridge/rendererProcessTitle.js";
import { installServicePortBridge, installStartupControlBridge } from "./bridge/serviceBridge.js";
import { installUpdateBridge } from "./bridge/updates.js";
import { installWorkspaceEventsBridge } from "./bridge/workspaceEvents.js";
import { createZCodeApi } from "./bridge/zcodeApi.js";
import { installWindowControlsOverlayBridge } from "./bridge/zoomControls.js";
import { installPluginSandboxHostBridge } from "./pluginSandbox/hostBridge.js";

// ARMS frame preload 闭包内的 send 不会随后序 ipcRenderer.send 补丁生效，须同步包装 Bridge.send
installArmsRumBridgeIpcForward(ipcRenderer);
scheduleArmsEventBridgePatch();

/** 从 command-line 参数中解析 --device-id= */
function parseDeviceIdFromArgs(): string {
  for (const arg of process.argv) {
    if (arg.startsWith("--device-id=")) {
      return arg.slice("--device-id=".length);
    }
  }
  return "";
}

// 在 contextBridge 建立之前就暴露同步值，让 renderer 在 React 渲染前就能读到
contextBridge.exposeInMainWorld("__ZCODE_DEVICE_ID__", parseDeviceIdFromArgs());

installFinalArmsCustomEventE2EBridge();

installWindowControlsOverlayBridge();

installWorkspaceEventsBridge();

installRendererProcessTitle();

/**
 * 主窗口 renderer 的 60 秒 heap 读数。
 * 只提供单向 send：main 不回执，renderer 也不能靠它反查 main 的进程事实。
 */
const reportRendererHeapSample = (sample: RendererHeapSample): void =>
  ipcRenderer.send(PlatformChannels.ReportRendererHeapSample, sample);

/**
 * Preload bridge —— 仅暴露需要 main 进程参与的平台操作
 *
 * 凭据管理已迁移到 host process 的 ICredentialService，
 * 通过 MessagePort RPC 访问，不再经过此 bridge。
 */
const zcodeApi = createZCodeApi({ reportRendererHeapSample });

export type ZCodePreloadApi = typeof zcodeApi;

contextBridge.exposeInMainWorld("zcode", zcodeApi);

installPluginSandboxHostBridge();

installServicePortBridge();

installUpdateBridge();

// dom-ready autoInject 之后 Bridge 若被重置，再尝试一次包装
scheduleArmsEventBridgePatch();

installStartupControlBridge();
