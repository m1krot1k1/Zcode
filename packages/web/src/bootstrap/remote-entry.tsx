import type { WebRemoteControlFailure } from "@zcode/shared";

import {
  WEB_ZAI_OAUTH_CONFIG,
  resolveWebAuthDevReturnTo,
} from "../auth/webZaiOAuthConfig.js";
import {
  WebRemoteControlEntry,
  createWebRemoteControlDeviceClient,
  createWebRemoteControlV2TokenClient,
} from "#src/web-remote-control/index.js";
import {
  WebRemoteControlDeviceListPage,
  WebRemoteControlFailureScreen,
  resolveWebRemoteControlScreenLocale,
} from "#src/web-remote-control/views.js";

import { bootstrapExternalRelayWebRemoteControl } from "./remote-control-relay.js";
import { isWebRemoteControlRoute } from "./routes.js";
import { root, webAuthService, webRemoteControlStorage } from "./runtime.js";
import { renderWebAuthCallbackPage, renderWebLoginPage } from "./screens.js";
import { isZhLocale } from "./theme.js";

export function renderWebRemoteControlFailure(
  failure: WebRemoteControlFailure,
): void {
  root.render(
    <WebRemoteControlFailureScreen
      failure={failure}
      locale={resolveWebRemoteControlScreenLocale(navigator.language)}
      primaryActionLabel={
        failure.reason === "device-not-owned"
          ? isZhLocale()
            ? "切换账号"
            : "Switch account"
          : undefined
      }
      secondaryAction={
        isWebRemoteControlRoute()
          ? {
              label: isZhLocale() ? "选择其他设备" : "Choose another device",
              onClick: () => {
                void remoteEntry.chooseOtherDevice();
              },
            }
          : undefined
      }
      onReload={() => {
        if (failure.reason === "device-not-owned")
          void remoteEntry.switchAccount();
        else window.location.reload();
      }}
    />,
  );
}

export const remoteEntry = new WebRemoteControlEntry({
  auth: webAuthService,
  getHref: () => window.location.href,
  replaceHref: (href) =>
    window.history.replaceState(window.history.state, "", href),
  storage: webRemoteControlStorage,
  locale: resolveWebRemoteControlScreenLocale(navigator.language),
  devices: createWebRemoteControlDeviceClient(window.location.origin),
  subscribeVisible: (listener) => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") listener();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  },
  loginOptions: {
    devReturnTo: resolveWebAuthDevReturnTo(WEB_ZAI_OAUTH_CONFIG),
  },
  token: createWebRemoteControlV2TokenClient(window.location.origin),
  connect: (connection) => {
    void bootstrapExternalRelayWebRemoteControl(connection, remoteEntry);
  },
  onView: (view) => {
    if (view.kind === "callback") renderWebAuthCallbackPage();
    else if (view.kind === "login")
      renderWebLoginPage((provider) => remoteEntry.startLogin(provider));
    else if (view.kind === "devices") {
      document.title = "ZCode - Web Remote Control";
      root.render(
        <WebRemoteControlDeviceListPage
          view={view}
          onSelect={(sid) => remoteEntry.selectDevice(sid)}
          onRefresh={() => {
            void remoteEntry.refreshDevices();
          }}
          onSwitchAccount={() => {
            void remoteEntry.switchAccount();
          }}
          locale={resolveWebRemoteControlScreenLocale(navigator.language)}
        />,
      );
    } else if (view.kind === "failure")
      renderWebRemoteControlFailure(view.failure);
  },
});
