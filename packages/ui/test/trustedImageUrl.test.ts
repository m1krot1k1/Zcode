import { describe, expect, it } from "vitest";
import { isTrustedImageUrl } from "../src/lib/trustedImageUrl.js";

describe("isTrustedImageUrl", () => {
  it("keeps HTTPS images from external providers in Offline Preview", () => {
    expect(isTrustedImageUrl("https://example.com/icon.png", true)).toBe(true);
  });

  it("blocks ZCode-owned plugin CDN images in Offline Preview", () => {
    expect(
      isTrustedImageUrl(
        "https://cdn-zcode.z.ai/zcode/official-plugin/assets/github/icon.png",
        true,
      ),
    ).toBe(false);
  });

  it("keeps ZCode plugin images enabled in normal builds", () => {
    expect(
      isTrustedImageUrl(
        "https://cdn-zcode.z.ai/zcode/official-plugin/assets/github/icon.png",
        false,
      ),
    ).toBe(true);
  });
});
