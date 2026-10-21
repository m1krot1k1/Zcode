import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import { desktopProductIdentities } from "../scripts/desktop-product-identity.mjs";
import { resolveAppAsarPath } from "../scripts/bundle.mjs";

describe("bundled app.asar path", () => {
  it("uses the executable-based macOS bundle filename for production and Preview", () => {
    const options = { root: "/workspace/desktop", distDir: "out" };

    expect(
      resolveAppAsarPath("mac", "arm64", {
        ...options,
        productIdentity: desktopProductIdentities.production,
      }),
    ).toBe(
      resolve(
        "/workspace/desktop",
        "out",
        "mac-arm64",
        "ZCode.app",
        "Contents",
        "Resources",
        "app.asar",
      ),
    );
    expect(
      resolveAppAsarPath("mac", "arm64", {
        ...options,
        productIdentity: desktopProductIdentities.preview,
      }),
    ).toBe(
      resolve(
        "/workspace/desktop",
        "out",
        "mac-arm64",
        "ZCodePreview.app",
        "Contents",
        "Resources",
        "app.asar",
      ),
    );
  });
});
