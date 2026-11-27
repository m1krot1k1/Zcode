import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyPackagedRemoteAssets } from "../scripts/verify-packaged-remote-assets.mjs";
import { BUNDLED_SOURCE_SERVER_TARGETS } from "../scripts/bundled-remote-assets-targets.mjs";

/**
 * Bug 原因：3.17.205 的安装包是从直接调用 electron-builder 得到的，跳过了
 * prepare-bundled-remote-assets.mjs，于是 resources/remote-assets 里还是上一版的
 * release 目录。产物一切正常，只有远端连接会死：sourceServerReleaseResolver 按
 * ZCODE_VERSION 找目录时命中 null 并抛 "is not bundled with this app"。
 *
 * 这些用例盯的就是那次事故：版本必须匹配、目录必须唯一、四个目标与源码版本都要对得上。
 */

const VERSION = "9.9.9";
const REVISION = "a".repeat(40);

function writeRelease(
  resourcesDir: string,
  version: string,
  options?: {
    revision?: string;
    targets?: readonly string[];
    descriptorVersion?: string;
    skipArchive?: string;
    wrongSize?: boolean;
  },
) {
  const releaseDir = join(resourcesDir, "remote-assets", "releases", version);
  mkdirSync(releaseDir, { recursive: true });
  const targets = options?.targets ?? BUNDLED_SOURCE_SERVER_TARGETS;
  const archives = targets.map((target) => {
    const fileName = `zcode-server-${target}.tar.gz`;
    const content = `archive-${target}`;
    if (target !== options?.skipArchive) {
      writeFileSync(join(releaseDir, fileName), content);
    }
    return {
      target,
      fileName,
      sha256: "b".repeat(64),
      sizeBytes: content.length + (options?.wrongSize ? 1 : 0),
      urls: [],
    };
  });
  writeFileSync(
    join(releaseDir, "source-server-release.json"),
    JSON.stringify({ version: options?.descriptorVersion ?? version, archives }, null, 2),
  );
  writeFileSync(join(releaseDir, "source-revision.txt"), `${options?.revision ?? REVISION}\n`);
  return releaseDir;
}

function withTempDir(run: (resourcesDir: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "zcode-remote-assets-"));
  const resourcesDir = join(root, "resources");
  try {
    run(resourcesDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("packaged Source Server release gate", () => {
  it("accepts a release that matches the app version and the source revision", () => {
    withTempDir((resourcesDir) => {
      writeRelease(resourcesDir, VERSION);
      const result = verifyPackagedRemoteAssets({
        resourcesDir,
        expectedVersion: VERSION,
        expectedRevision: REVISION,
      });
      expect(result.version).toBe(VERSION);
      expect(result.targets).toEqual([...BUNDLED_SOURCE_SERVER_TARGETS]);
    });
  });

  it("requires every target the app must be able to install", () => {
    withTempDir((resourcesDir) => {
      writeRelease(resourcesDir, VERSION);
      // 应用要能给任意远端目标装服务器；少一个目标就意味着那次连接装不上。
      expect(BUNDLED_SOURCE_SERVER_TARGETS).toContain("linux-x64");
      expect(BUNDLED_SOURCE_SERVER_TARGETS).toContain("darwin-arm64");
    });
  });

  it("rejects the shipped defect: a previous version left in resources/remote-assets", () => {
    withTempDir((resourcesDir) => {
      writeRelease(resourcesDir, "9.9.8", { revision: "c".repeat(40) });
      expect(() =>
        verifyPackagedRemoteAssets({
          resourcesDir,
          expectedVersion: VERSION,
          expectedRevision: REVISION,
        }),
      ).toThrow(/缺少随包 Source Server release 9\.9\.9，实际为: \[9\.9\.8\]/u);
    });
  });

  it("rejects a bundle carrying more than one release directory", () => {
    withTempDir((resourcesDir) => {
      writeRelease(resourcesDir, VERSION);
      writeRelease(resourcesDir, "9.9.8", { revision: "c".repeat(40) });
      expect(() =>
        verifyPackagedRemoteAssets({
          resourcesDir,
          expectedVersion: VERSION,
          expectedRevision: REVISION,
        }),
      ).toThrow(/目录杂糅/u);
    });
  });

  it("rejects a release built from different sources than the app", () => {
    withTempDir((resourcesDir) => {
      writeRelease(resourcesDir, VERSION, { revision: "d".repeat(40) });
      expect(() =>
        verifyPackagedRemoteAssets({
          resourcesDir,
          expectedVersion: VERSION,
          expectedRevision: REVISION,
        }),
      ).toThrow(/源码版本不符/u);
    });
  });

  it("rejects a descriptor whose version disagrees with the directory", () => {
    withTempDir((resourcesDir) => {
      writeRelease(resourcesDir, VERSION, { descriptorVersion: "9.9.8" });
      expect(() =>
        verifyPackagedRemoteAssets({
          resourcesDir,
          expectedVersion: VERSION,
          expectedRevision: REVISION,
        }),
      ).toThrow(/descriptor 版本不符/u);
    });
  });

  it("rejects a descriptor missing a target the app must be able to install", () => {
    withTempDir((resourcesDir) => {
      writeRelease(resourcesDir, VERSION, {
        targets: BUNDLED_SOURCE_SERVER_TARGETS.filter((target) => target !== "darwin-arm64"),
      });
      expect(() =>
        verifyPackagedRemoteAssets({
          resourcesDir,
          expectedVersion: VERSION,
          expectedRevision: REVISION,
        }),
      ).toThrow(/缺少目标: darwin-arm64/u);
    });
  });

  it("rejects a descriptor whose size disagrees with the archive on disk", () => {
    withTempDir((resourcesDir) => {
      writeRelease(resourcesDir, VERSION, { wrongSize: true });
      expect(() =>
        verifyPackagedRemoteAssets({
          resourcesDir,
          expectedVersion: VERSION,
          expectedRevision: REVISION,
        }),
      ).toThrow(/归档大小不符/u);
    });
  });

  it("rejects an archive the descriptor names but the bundle does not carry", () => {
    withTempDir((resourcesDir) => {
      writeRelease(resourcesDir, VERSION, { skipArchive: "linux-x64" });
      expect(() =>
        verifyPackagedRemoteAssets({
          resourcesDir,
          expectedVersion: VERSION,
          expectedRevision: REVISION,
        }),
      ).toThrow(/归档缺失/u);
    });
  });
});
