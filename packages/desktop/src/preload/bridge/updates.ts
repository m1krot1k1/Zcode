import { ipcRenderer } from "electron";
import type { PostUpdateReleaseNotesPayload, UpdateStatePayload } from "@zcode/shared";
import { PlatformChannels } from "@zcode/shared";

const updateReadyCallbacks = new Set<(version: string) => void>();
const updateStateCallbacks = new Set<(payload: UpdateStatePayload) => void>();
const postUpdateReleaseNotesCallbacks = new Set<(payload: PostUpdateReleaseNotesPayload) => void>();
let latestReadyUpdateVersion: string | null = null;
let latestUpdateState: UpdateStatePayload | null = null;
let latestPostUpdateReleaseNotes: PostUpdateReleaseNotesPayload | null = null;

function notifyUpdateReadyCallbacks(version: string): void {
  latestReadyUpdateVersion = version;
  for (const callback of updateReadyCallbacks) {
    callback(version);
  }
}

function notifyPostUpdateReleaseNotesCallbacks(payload: PostUpdateReleaseNotesPayload): void {
  latestPostUpdateReleaseNotes = payload;
  for (const callback of postUpdateReleaseNotesCallbacks) {
    callback(payload);
  }
}

function notifyUpdateStateCallbacks(payload: UpdateStatePayload): void {
  latestUpdateState = payload;
  // UpdateReady 是兼容旧交互的一次性缓存，但 update-downloaded
  // 之后 Squirrel.Mac 可能再上报 staging error。此时 main 会广播 idle/error，
  // preload 必须同步清掉旧 ready，否则 React 重新订阅时会把已失效版本回放出来。
  latestReadyUpdateVersion = payload.kind === "update-downloaded" ? payload.version : null;
  for (const callback of updateStateCallbacks) {
    callback(payload);
  }
}

export function registerUpdateStateCallback(
  callback: (payload: UpdateStatePayload) => void,
): () => void {
  updateStateCallbacks.add(callback);
  if (latestUpdateState) {
    callback(latestUpdateState);
  }
  return () => {
    updateStateCallbacks.delete(callback);
  };
}

export function registerUpdateReadyCallback(callback: (version: string) => void): () => void {
  // 主进程的 update-ready 是一次性事件，常常早于 React effect 注册。
  // 这里在 preload 层先缓存最新版本，并在订阅时立即回放，
  // 这样 UI 即使晚挂载，也能拿到“更新已下载完毕”的稳定状态。
  updateReadyCallbacks.add(callback);
  if (latestReadyUpdateVersion) {
    callback(latestReadyUpdateVersion);
  }
  return () => {
    updateReadyCallbacks.delete(callback);
  };
}

export function registerPostUpdateReleaseNotesCallback(
  callback: (payload: PostUpdateReleaseNotesPayload) => void,
): () => void {
  postUpdateReleaseNotesCallbacks.add(callback);
  if (latestPostUpdateReleaseNotes) {
    callback(latestPostUpdateReleaseNotes);
  }
  return () => {
    postUpdateReleaseNotesCallbacks.delete(callback);
  };
}

export function installUpdateBridge(): void {
  ipcRenderer.on(PlatformChannels.UpdateReady, (_event, version: string) => {
    notifyUpdateReadyCallbacks(version);
  });

  ipcRenderer.on(PlatformChannels.UpdateStateChanged, (_event, payload: UpdateStatePayload) => {
    notifyUpdateStateCallbacks(payload);
  });

  ipcRenderer.on(
    PlatformChannels.PostUpdateReleaseNotes,
    (_event, payload: PostUpdateReleaseNotesPayload) => {
      notifyPostUpdateReleaseNotesCallbacks(payload);
    },
  );
}
