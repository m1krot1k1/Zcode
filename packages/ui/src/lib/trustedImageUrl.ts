import {
  isZCodeOfficialPluginCdnUrl,
  ZCODE_OFFLINE_PREVIEW,
} from "@zcode/shared";

/** UI 远端图片只允许 HTTPS；Offline Preview 对 ZCode 官方 CDN 回退到本地图标。 */
export function isTrustedImageUrl(
  url: string | undefined,
  offlinePreview = ZCODE_OFFLINE_PREVIEW,
): url is string {
  return (
    typeof url === "string" &&
    url.startsWith("https://") &&
    !(offlinePreview && isZCodeOfficialPluginCdnUrl(url))
  );
}
