import { describe, expect, it } from "vitest";

import { shouldReuseBundledRelease } from "../scripts/bundled-remote-assets-reuse.mjs";

const targets = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"] as const;

function archive(target: string, sha256 = "a".repeat(64), sizeBytes = 12) {
  return {
    target,
    version: "3.17.127",
    fileName: `zcode-server-${target}.tar.gz`,
    sha256,
    sizeBytes,
    urls: [`zcode-server-${target}.tar.gz`],
  };
}

const descriptor = {
  schemaVersion: 1,
  version: "3.17.127",
  archives: targets.map((target) => archive(target)),
};

const archives = Object.fromEntries(
  targets.map((target) => [target, { sizeBytes: 12, sha256: "a".repeat(64) }]),
);

function check(overrides = {}) {
  return shouldReuseBundledRelease({
    descriptor,
    targets,
    expectedRevision: "fc02b246",
    recordedRevision: "fc02b246",
    archives,
    ...overrides,
  });
}

describe("bundled Source Server release reuse", () => {
  it("reuses a bundle built from the current commit with every target", () => {
    expect(check()).toBe(true);
  });

  it("rebuilds when the recorded commit differs from HEAD", () => {
    // Bug 根因：同 version 重新构建时只比较 size/hash，旧 commit 的 Source Server
    // 归档会继续被复用. Bundled-release должен быть привязан к исходникам.
    expect(check({ recordedRevision: "30819720" })).toBe(false);
  });

  it("rebuilds when the release has no commit marker", () => {
    expect(check({ recordedRevision: "" })).toBe(false);
  });

  it("rebuilds when git HEAD cannot be resolved", () => {
    expect(check({ expectedRevision: null })).toBe(false);
  });

  it("rebuilds when one archive does not match the descriptor", () => {
    expect(
      check({ archives: { ...archives, "linux-x64": { sizeBytes: 12, sha256: "b".repeat(64) } } }),
    ).toBe(false);
    expect(
      check({ archives: { ...archives, "linux-x64": { sizeBytes: 13, sha256: "a".repeat(64) } } }),
    ).toBe(false);
  });

  it("rebuilds a host-only bundle that is missing a remote target", () => {
    // Bug 根因: macOS-сборка содержала только darwin-arm64. Такой bundle нельзя
    // переиспользовать, иначе descriptor снова не содержит linux-x64.
    expect(check({ descriptor: { ...descriptor, archives: [archive("darwin-arm64")] } })).toBe(
      false,
    );
  });

  it("rebuilds when a target fingerprint is missing", () => {
    expect(check({ archives: { ...archives, "linux-arm64": undefined } })).toBe(false);
  });

  it("rebuilds when the target set is empty", () => {
    expect(check({ targets: [] })).toBe(false);
  });
});
