import { ipcRenderer } from "electron";
import { PlatformChannels } from "@zcode/shared";

const openWorkspacePathCallbacks = new Set<(path: string) => void>();
const pendingOpenWorkspacePaths: string[] = [];
const shareImportCallbacks = new Set<(payload: { shareCode: string }) => void>();
const pendingShareImports: { shareCode: string }[] = [];

export function registerOpenWorkspacePathCallback(
  callback: (path: string) => void,
): () => void {
  openWorkspacePathCallbacks.add(callback);
  while (pendingOpenWorkspacePaths.length > 0) {
    const path = pendingOpenWorkspacePaths.shift();
    if (path) {
      callback(path);
    }
  }
  return () => openWorkspacePathCallbacks.delete(callback);
}

export function registerShareImportCallback(
  callback: (payload: { shareCode: string }) => void,
): () => void {
  shareImportCallbacks.add(callback);
  while (pendingShareImports.length > 0) {
    const payload = pendingShareImports.shift();
    if (payload) callback(payload);
  }
  return () => shareImportCallbacks.delete(callback);
}

export function installWorkspaceEventsBridge(): void {
  ipcRenderer.on(PlatformChannels.OpenWorkspacePath, (_event: unknown, path: string) => {
    if (openWorkspacePathCallbacks.size === 0) {
      // 冷启动 open-workspace 会在 renderer ready 后立刻从 main 进程投递，
      // 但 React 的 platform effect 可能尚未注册 onOpenWorkspacePath。preload 先接住
      // 这条 IPC，等 UI 订阅建立后再回放，避免只打开 App 而不打开目录。
      pendingOpenWorkspacePaths.push(path);
      return;
    }

    for (const callback of openWorkspacePathCallbacks) {
      callback(path);
    }
  });

  ipcRenderer.on(PlatformChannels.ShareImport, (_event: unknown, payload: { shareCode: string }) => {
    if (shareImportCallbacks.size === 0) {
      pendingShareImports.push(payload);
      return;
    }
    for (const callback of shareImportCallbacks) callback(payload);
  });
}
