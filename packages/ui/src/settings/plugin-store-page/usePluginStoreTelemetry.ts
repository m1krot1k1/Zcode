import type { IPlatformService } from "@zcode/shared";
import { useEffect, type RefObject } from "react";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import type { PluginStoreView } from "./types.js";

/** 商店曝光 telemetry：容器进入视口时按当前视图上报一次 store/detail 曝光。 */
export function usePluginStoreViewTelemetry({
  platform,
  rootRef,
  view,
  detailPluginId,
  embedded,
  isWebRemoteControl,
}: {
  platform: IPlatformService;
  rootRef: RefObject<HTMLDivElement | null>;
  view: PluginStoreView;
  detailPluginId: string | null;
  embedded: boolean;
  isWebRemoteControl: boolean;
}): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root || view === "manage" || typeof IntersectionObserver === "undefined") return;
    let visible = false;
    const observer = new IntersectionObserver(([entry]) => {
      const next = Boolean(entry?.isIntersecting);
      if (next && !visible) {
        void reportAppTelemetryEvent(
          platform,
          {
            elementName: "plugin_discovery",
            eventRegion: "app",
            eventType: "view",
            eventExtraDetail: {
              schema_version: "1",
              action: view === "detail" ? "detail_view" : "store_view",
              entry: embedded
                ? "side_pane_market"
                : view === "detail"
                  ? "store_detail"
                  : "store_list",
              client_kind: isWebRemoteControl ? "mobile" : "desktop",
              ...(view === "detail" && detailPluginId ? { plugin_id: detailPluginId } : {}),
            },
          },
          "plugin-discovery",
        );
      }
      visible = next;
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [platform, view, detailPluginId, embedded, isWebRemoteControl]);
}

/** 列表搜索提交上报；空查询不产生搜索事件。 */
export function reportPluginStoreSearchTelemetry(
  platform: IPlatformService,
  { embedded, isWebRemoteControl }: { embedded: boolean; isWebRemoteControl: boolean },
): void {
  void reportAppTelemetryEvent(
    platform,
    {
      elementName: "plugin_discovery",
      eventRegion: "app",
      eventType: "view",
      eventExtraDetail: {
        schema_version: "1",
        action: "search",
        entry: embedded ? "side_pane_market" : "store_list",
        client_kind: isWebRemoteControl ? "mobile" : "desktop",
      },
    },
    "plugin-discovery",
  );
}
