import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import { desktopProductIdentities } from "../scripts/desktop-product-identity.mjs";
import { assertPackagedOpenCodeAssets, resolveAppAsarPath } from "../scripts/bundle.mjs";

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

  it("requires OpenCode ACP runtime, installer/resolver and settings UI in the reachable app.asar graphs", () => {
    const files = new Map([
      ["/out/host/index.js", Buffer.from('import {runtime} from "./open-code-runtime.js";')],
      [
        "/out/host/open-code-runtime.js",
        Buffer.from(
          'const missing="opencode.cli-missing"; const installer="https://github.com/anomalyco/opencode/releases/download"; const unsupported="opencode.install-platform-unsupported"; const invalidArchive="opencode.install-archive-invalid";',
        ),
      ],
      [
        "/out/renderer/index.html",
        Buffer.from('<html><script type="module" src="./assets/index.js"></script></html>'),
      ],
      ["/out/renderer/assets/index.js", Buffer.from('import "./open-code-settings.js";')],
      [
        "/out/renderer/assets/open-code-settings.js",
        Buffer.from(
          'const panel="opencode-agent-settings"; const install="settings.openCode.install";',
        ),
      ],
    ]);
    const entryPaths = [...files.keys()];
    const readFile = (entryPath: string) => {
      const content = files.get(entryPath);
      if (!content) throw new Error(`unexpected ASAR read: ${entryPath}`);
      return content;
    };

    expect(() => assertPackagedOpenCodeAssets(entryPaths, readFile)).not.toThrow();
    expect(() =>
      assertPackagedOpenCodeAssets(
        entryPaths.filter((entryPath) => !entryPath.endsWith("open-code-runtime.js")),
        readFile,
      ),
    ).toThrow(/missing OpenCode reachable asset|缺少 OpenCode reachable asset/u);

    const withoutSettingsUi = new Map(files);
    withoutSettingsUi.set("/out/renderer/assets/index.js", Buffer.from("export {};"));
    expect(() =>
      assertPackagedOpenCodeAssets(entryPaths, (entryPath) => {
        const content = withoutSettingsUi.get(entryPath);
        if (!content) throw new Error(`unexpected ASAR read: ${entryPath}`);
        return content;
      }),
    ).toThrow(/缺少 OpenCode ACP runtime\/UI assets: renderer:/u);
  });
});
