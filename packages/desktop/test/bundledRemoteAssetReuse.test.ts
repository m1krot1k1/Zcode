import { describe, expect, it } from "vitest";

import { shouldReuseBundledRelease } from "../scripts/bundled-remote-assets-reuse.mjs";

const descriptor = {
  schemaVersion: 1,
  version: "3.17.127",
  archives: [
    {
      target: "linux-x64",
      version: "3.17.127",
      fileName: "zcode-server-linux-x64.tar.gz",
      sha256: "a".repeat(64),
      sizeBytes: 12,
      urls: ["zcode-server-linux-x64.tar.gz"],
    },
  ],
};

function check(overrides = {}) {
  return shouldReuseBundledRelease({
    descriptor,
    target: "linux-x64",
    expectedRevision: "fc02b246",
    recordedRevision: "fc02b246",
    archiveSizeBytes: 12,
    archiveSha256: "a".repeat(64),
    ...overrides,
  });
}

describe("bundled Source Server release reuse", () => {
  it("reuses an archive built from the current commit", () => {
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

  it("rebuilds when the archive content does not match the descriptor", () => {
    expect(check({ archiveSha256: "b".repeat(64) })).toBe(false);
    expect(check({ archiveSizeBytes: 13 })).toBe(false);
  });

  it("rebuilds when the target archive is absent", () => {
    expect(check({ target: "darwin-arm64" })).toBe(false);
  });
});
