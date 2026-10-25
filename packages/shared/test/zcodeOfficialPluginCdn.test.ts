import { describe, expect, it } from "vitest";
import { isZCodeOfficialPluginCdnUrl } from "../src/plugin-marketplaces.js";

describe("isZCodeOfficialPluginCdnUrl", () => {
  it.each([
    "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json",
    "https://cdn-zcode.z.ai/zcode/official-plugin/assets/github/icon.png",
    "https://cdn.codegeex.cn/zcode/electron/releases/3.0.0/app.zip",
  ])("recognizes a ZCode-owned CDN URL: %s", (url) => {
    expect(isZCodeOfficialPluginCdnUrl(url)).toBe(true);
  });

  it.each([
    undefined,
    "http://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json",
    "https://cdn-zcode.z.ai/other/image.png",
    "https://cdn.codegeex.cn/other/image.png",
    "https://cdn-zcode-z.ai/zcode/official-plugin/marketplace.json",
    "https://example.com/zcode/official-plugin/marketplace.json",
  ])("does not classify unrelated or invalid URLs as ZCode CDN: %s", (url) => {
    expect(isZCodeOfficialPluginCdnUrl(url)).toBe(false);
  });
});
