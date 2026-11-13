import { randomUUID } from "node:crypto";
import type { WebRemoteControlContext } from "@zcode/shared";
import { resolveWebRemoteControlWorkspaceKey } from "@zcode/shared";

import {
  WEB_REMOTE_CONTROL_START_AUTHORIZATION_TTL_MS,
  type WebRemoteControlManagerState,
  type WebRemoteControlStartAuthorization,
} from "./types.js";

export interface StartAuthorizationServices {
  clearStartAuthorizationsForWindow(windowId: number): void;
  authorizeStart(
    windowId: number,
    context: WebRemoteControlContext,
  ): WebRemoteControlStartAuthorization;
  consumeStartAuthorization(
    windowId: number,
    context: WebRemoteControlContext,
    authorization: WebRemoteControlStartAuthorization,
  ): void;
}

export function createStartAuthorizationServices(
  state: WebRemoteControlManagerState,
): StartAuthorizationServices {
  function clearStartAuthorizationsForWindow(windowId: number): void {
    for (const [token, authorization] of state.startAuthorizations) {
      if (authorization.windowId === windowId) {
        state.startAuthorizations.delete(token);
      }
    }
  }

  function authorizeStart(
    windowId: number,
    context: WebRemoteControlContext,
  ): WebRemoteControlStartAuthorization {
    const now = Date.now();
    // 同一窗口只保留最近一次 IPC dispatch 对应的内部票据，避免旧请求与新 workspace 上下文并存。
    clearStartAuthorizationsForWindow(windowId);
    for (const [token, authorization] of state.startAuthorizations) {
      if (authorization.expiresAt <= now) {
        state.startAuthorizations.delete(token);
      }
    }

    const authorization: WebRemoteControlStartAuthorization = {
      token: randomUUID(),
      expiresAt: now + WEB_REMOTE_CONTROL_START_AUTHORIZATION_TTL_MS,
      windowId,
      workspaceKey: resolveWebRemoteControlWorkspaceKey(context),
      ...(context.remoteSessionId ? { remoteSessionId: context.remoteSessionId } : {}),
    };
    state.startAuthorizations.set(authorization.token, authorization);
    return authorization;
  }

  function consumeStartAuthorization(
    windowId: number,
    context: WebRemoteControlContext,
    authorization: WebRemoteControlStartAuthorization,
  ): void {
    const stored = state.startAuthorizations.get(authorization.token);
    state.startAuthorizations.delete(authorization.token);
    if (!stored || stored !== authorization) {
      throw new Error("Web remote control authorization is invalid or already used");
    }
    if (stored.expiresAt <= Date.now()) {
      throw new Error("Web remote control authorization expired");
    }
    if (
      stored.windowId !== windowId ||
      stored.workspaceKey !== resolveWebRemoteControlWorkspaceKey(context) ||
      stored.remoteSessionId !== context.remoteSessionId
    ) {
      throw new Error("Web remote control authorization target mismatch");
    }
  }

  return {
    clearStartAuthorizationsForWindow,
    authorizeStart,
    consumeStartAuthorization,
  };
}
