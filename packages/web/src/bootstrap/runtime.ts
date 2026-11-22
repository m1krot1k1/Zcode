import {
  generateMobileDeviceFingerprint,
  installDocumentHiddenMotionPause,
  setStreamClientId,
} from "@zcode/ui";
import { createRoot } from "react-dom/client";

import { createWebAuthService } from "../auth/webAuthService.js";
import { applyInitialWebThemePreference } from "./theme.js";

applyInitialWebThemePreference();

// 浏览器标签页 / 手机切后台时禁用 CSS 动画，避免 DocumentTimeline 持有已卸载的 DOM 子树。
installDocumentHiddenMotionPause();
export const root = createRoot(document.getElementById("root")!);
export const webAuthService = createWebAuthService();

let pageUnloading = false;

// 初始化 Web 端流式 clientId，确保所有 hook 在首次渲染前就使用稳定 ID
setStreamClientId(generateMobileDeviceFingerprint());

window.addEventListener("beforeunload", () => {
  pageUnloading = true;
});

export function isPageUnloading(): boolean {
  return pageUnloading;
}

// 访问 window.localStorage 本身在部分浏览器会抛错，统一包在方法里交给调用方兜底。
export const webRemoteControlStorage: Pick<Storage, "getItem" | "setItem"> = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
};
