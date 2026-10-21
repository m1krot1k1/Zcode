import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  copyNodePtyRuntimePackage,
  resolvePackagedNodePtyPrebuildPath,
  resolveSourceNodePtyPrebuildPath,
} from "../scripts/node-pty-package-assets.mjs";

describe("node-pty package assets", () => {
  it("resolves the unpacked node-pty prebuild path used by packaged Windows apps", () => {
    const resolvedPath = resolvePackagedNodePtyPrebuildPath({
      resourcesDir: "C:/Program Files/ZCode/resources",
      platformKey: "win32-x64",
    }).replaceAll("\\", "/");

    expect(resolvedPath).toContain("/resources/");
    expect(resolvedPath).toMatch(
      /app\.asar\.unpacked\/node_modules\/node-pty\/prebuilds\/win32-x64\/pty\.node$/,
    );
  });

  it("resolves linux source prebuilds through package exports compatible entrypoints", () => {
    for (const platformKey of ["linux-x64", "linux-arm64"]) {
      const resolvedPath = resolveSourceNodePtyPrebuildPath({
        sourcePackageName: `@lydell/node-pty-${platformKey}`,
        platformKey,
      }).replaceAll("\\", "/");

      expect(resolvedPath).toMatch(
        new RegExp(`@lydell/node-pty-${platformKey}/prebuilds/${platformKey}/pty\\.node$`),
      );
    }
  });

  it("copies the node-pty runtime with only the selected platform prebuild", () => {
    const rootDir = mkdtempSync(resolve(tmpdir(), "zcode-node-pty-package-assets-"));
    try {
      const sourcePackageRoot = resolve(rootDir, "source/node-pty");
      const targetPackageRoot = resolve(rootDir, "staging/node_modules/node-pty");
      const files = [
        ["lib/index.js", "runtime"],
        ["prebuilds/darwin-arm64/pty.node", "arm64 native"],
        ["prebuilds/darwin-x64/pty.node", "x64 native"],
        ["build/Release/pty.node", "local build"],
        ["bin/node-pty", "installer binary"],
      ] as const;

      for (const [relativePath, contents] of files) {
        const filePath = resolve(sourcePackageRoot, relativePath);
        mkdirSync(resolve(filePath, ".."), { recursive: true });
        writeFileSync(filePath, contents);
      }

      copyNodePtyRuntimePackage({
        sourcePackageRoot,
        targetPackageRoot,
        targetPlatformKey: "darwin-arm64",
      });

      expect(readFileSync(resolve(targetPackageRoot, "lib/index.js"), "utf8")).toBe("runtime");
      expect(
        readFileSync(resolve(targetPackageRoot, "prebuilds/darwin-arm64/pty.node"), "utf8"),
      ).toBe("arm64 native");
      expect(existsSync(resolve(targetPackageRoot, "prebuilds/darwin-x64/pty.node"))).toBe(false);
      expect(existsSync(resolve(targetPackageRoot, "build/Release/pty.node"))).toBe(false);
      expect(existsSync(resolve(targetPackageRoot, "bin/node-pty"))).toBe(false);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("resolves the unpacked node-pty prebuild path used by packaged Linux apps", () => {
    const resolvedPath = resolvePackagedNodePtyPrebuildPath({
      resourcesDir: "/opt/ZCode/resources",
      platformKey: "linux-x64",
    }).replaceAll("\\", "/");

    expect(resolvedPath).toContain("/opt/ZCode/resources/");
    expect(resolvedPath).toMatch(
      /app\.asar\.unpacked\/node_modules\/node-pty\/prebuilds\/linux-x64\/pty\.node$/,
    );
  });
});
