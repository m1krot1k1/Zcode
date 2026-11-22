import { matchesWebRemoteControlRoutePath } from "@zcode/shared";

import {
  isWebRemoteControlOAuthCallback,
  resolveWebRemoteControlRoutePath,
} from "#src/web-remote-control/index.js";

export function isWebOAuthCallback(params: URLSearchParams): boolean {
  return (
    isWebRemoteControlOAuthCallback(new URL(window.location.href)) ||
    (["/cn/share/callback", "/share/callback"].includes(
      window.location.pathname,
    ) &&
      params.has("state") &&
      // BigModel 的 authCode 要先进入回调页，才能由 provider 归一化为 code。
      (params.has("code") || params.has("authCode") || params.has("error")))
  );
}

export function isWebRemoteControlRoute(): boolean {
  return (
    matchesWebRemoteControlRoutePath(window.location.pathname, "/remote/v4") ||
    matchesWebRemoteControlRoutePath(
      window.location.pathname,
      resolveWebRemoteControlRoutePath(import.meta.env),
    )
  );
}
