// browser-client 公共门面：实现按职责拆到 ./facade/*，此处仅保留稳定导出面。
export { Browser } from "./facade/browser.js";
export { BrowsersFacade } from "./facade/browsers-facade.js";
export { BrowserRecordingAPI } from "./facade/recording.js";
export { RawTab } from "./facade/raw-tab.js";
export { Tab } from "./facade/tab.js";
export { BrowserTabs } from "./facade/tabs.js";
export type {
  BrowserAvailabilityGuard,
  BrowserBackendType,
  BrowserCapabilityInfo,
  BrowserClientTransport,
  BrowserDescriptor,
  BrowserExecuteFn,
  BrowserInfo,
  BrowserTabInfo,
  BrowserTransportExecuteFn,
} from "./facade/types.js";
