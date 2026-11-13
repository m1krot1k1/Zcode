import type { ComponentProps } from "react";

import type { WebRemoteControlTerminalTransportState as UiWebRemoteControlTerminalTransportState } from "@zcode/ui";

import { WebCallbackPage } from "../auth/WebCallbackPage.js";
import { WebLoginPage } from "../auth/WebLoginPage.js";
import {
  parseOAuthState,
  resolveSafeAppReturnTo,
} from "../auth/oauthStateCodec.js";
import {
  WebRemoteControlLoadingScreen,
  type WebRemoteControlConnectingDevice,
  resolveWebRemoteControlScreenLocale,
} from "#src/web-remote-control/views.js";

import { root, webAuthService } from "./runtime.js";

export function renderWebAuthCallbackPage(): void {
  document.title = "ZCode - Web Remote Control Sign In";
  const callbackState = parseOAuthState(
    new URLSearchParams(window.location.search).get("state") ?? "",
  );
  const safeRetryTarget = resolveSafeAppReturnTo(callbackState?.app_return_to);
  root.render(
    <WebCallbackPage
      authService={webAuthService}
      onSuccess={({ appReturnTo }) => {
        window.location.replace(appReturnTo ?? "/remote/v4");
      }}
      onRetry={() => {
        window.location.replace(safeRetryTarget ?? "/remote/v4");
      }}
    />,
  );
}

export function renderWebLoginPage(
  onLogin: ComponentProps<typeof WebLoginPage>["onLogin"],
): void {
  document.title = "ZCode - Web Remote Control Sign In";
  root.render(<WebLoginPage onLogin={onLogin} />);
}

export function renderWebRemoteControlLoading(
  state: UiWebRemoteControlTerminalTransportState,
  device: WebRemoteControlConnectingDevice,
): void {
  document.title = "ZCode - Web Remote Control";
  root.render(
    <WebRemoteControlLoadingScreen
      state={state}
      locale={resolveWebRemoteControlScreenLocale(navigator.language)}
      device={device}
    />,
  );
}
