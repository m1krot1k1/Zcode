import type { MessagePortMain } from "electron";
import type { MessagePortLike, MessagePortPayload } from "@zcode/rpc";
import type {
  RemoteUsageRemoteKind,
  WebRemoteControlExternalWorkspaceBridge,
  WebRemoteControlFailure,
  WebRemoteControlFailureReason,
  WebRemoteControlWorkspaceTarget,
} from "@zcode/shared";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";

import type {
  WebRemoteControlHostAttachmentHandle,
  WindowControlRuntime,
  WorkspaceBridgeRuntime,
} from "./types.js";

export function createFailure(
  reason: WebRemoteControlFailureReason,
  message?: string,
): WebRemoteControlFailure {
  return { reason, message };
}

export function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

export function mapWorkspaceBridgeFailureReason(error: unknown): WebRemoteControlFailureReason {
  switch (getErrorCode(error)) {
    case "DESKTOP_HOST_MISSING":
      return "desktop-disconnected";
    case "REMOTE_SESSION_MISSING":
    case "REMOTE_SESSION_WINDOW_MISMATCH":
      return "workspace-closed";
    case "REMOTE_WORKSPACE_IDENTITY_MISSING":
    case "REMOTE_WORKSPACE_IDENTITY_MISMATCH":
      return "unsupported-action";
    default:
      return "unexpected-error";
  }
}

export function wrapElectronPort(port: MessagePortMain): MessagePortLike {
  return {
    addEventListener(_type: "message", listener: (e: { data: MessagePortPayload }) => void) {
      port.on("message", listener);
    },
    removeEventListener(_type: "message", listener: (e: { data: MessagePortPayload }) => void) {
      port.off("message", listener);
    },
    postMessage(data: MessagePortPayload) {
      port.postMessage(data);
    },
    start() {
      port.start();
    },
    close() {
      port.close();
    },
  };
}

export function getPathLabel(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? workspacePath;
}

export function isBridgeableRemoteTarget(target: WebRemoteControlWorkspaceTarget): boolean {
  return target.kind !== "remote" || Boolean(target.workspaceIdentity && target.remoteSessionId);
}

export function toExternalBridge(
  runtime: WorkspaceBridgeRuntime,
): WebRemoteControlExternalWorkspaceBridge {
  const base = {
    bridgeSessionId: runtime.bridgeSessionId,
    ...(runtime.bridgeGeneration !== undefined
      ? { bridgeGeneration: runtime.bridgeGeneration }
      : {}),
    ...(runtime.recoveryId ? { recoveryId: runtime.recoveryId } : {}),
    workspaceKey: runtime.workspaceKey,
    workspacePath: runtime.workspacePath,
    initialTaskId: runtime.initialTaskId,
  };

  if (runtime.kind === "remote") {
    if (!runtime.workspaceIdentity || !runtime.remoteSessionId) {
      throw new Error("远程 workspace bridge 缺少 workspaceIdentity 或 remoteSessionId。");
    }
    return {
      ...base,
      kind: "remote",
      workspaceIdentity: runtime.workspaceIdentity,
      remoteSessionId: runtime.remoteSessionId,
      capabilities: { windowProjectDirectory: true },
    };
  }

  return {
    ...base,
    kind: "local",
  };
}

export function resolveRemoteKind(
  target: WebRemoteControlWorkspaceTarget,
  acquired?: WebRemoteControlHostAttachmentHandle,
): RemoteUsageRemoteKind | undefined {
  if (target.kind !== "remote") {
    return undefined;
  }
  return (
    acquired?.remoteKind ??
    (target.workspaceIdentity
      ? parseRemoteWorkspaceIdentity(target.workspaceIdentity)?.kind
      : undefined)
  );
}

export function resolveRuntimeWorkspaceDimensions(runtime: WindowControlRuntime): {
  workspaceKind: "local" | "remote";
  remoteKind?: RemoteUsageRemoteKind;
} {
  const remoteKind = runtime.workspaceIdentity
    ? parseRemoteWorkspaceIdentity(runtime.workspaceIdentity)?.kind
    : undefined;
  return {
    workspaceKind:
      runtime.workspaceIdentity?.trim() || runtime.remoteSessionId ? "remote" : "local",
    remoteKind,
  };
}
