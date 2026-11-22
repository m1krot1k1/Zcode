import { isWebRemoteControlOAuthCallback } from "#src/web-remote-control/index.js";
import { resolveWebRemoteControlScreenLocale } from "#src/web-remote-control/views.js";

import { isConversationSharePath } from "../share/conversationShareRoute.js";

import { remoteEntry } from "./remote-entry.js";
import { isWebOAuthCallback, isWebRemoteControlRoute } from "./routes.js";
import { renderWebAuthCallbackPage } from "./screens.js";
import { renderConversationSharePage } from "./share-page.js";
import { bootstrapServerWebApp } from "./web-app.js";

export async function bootstrapWebApp(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  if (
    isWebRemoteControlRoute() ||
    isWebRemoteControlOAuthCallback(new URL(window.location.href))
  ) {
    document.documentElement.lang = resolveWebRemoteControlScreenLocale(
      navigator.language,
    );
  }
  if (isWebOAuthCallback(params)) {
    renderWebAuthCallbackPage();
    return;
  }

  if (isConversationSharePath(window.location.pathname)) {
    await renderConversationSharePage();
    return;
  }

  if (isWebRemoteControlRoute()) {
    await remoteEntry.start();
    return;
  }

  await bootstrapServerWebApp();
}
