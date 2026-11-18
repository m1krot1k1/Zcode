import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCODE_VERSION } from "@zcode/shared";
import { resolveSourceServerReleaseAsset } from "../src/host/sourceServerReleaseResolver.js";

const target = { kind: "ssh", host: "example.com", username: "alice" } as const;
const probe = { platform: "linux", arch: "x64", installed: false } as const;
const fileName = "zcode-server-linux-x64.tar.gz";

function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function descriptor(contents: string) {
  return {
    schemaVersion: 1,
    version: ZCODE_VERSION,
    archives: [
      {
        target: "linux-x64",
        version: ZCODE_VERSION,
        fileName,
        sha256: sha256(contents),
        sizeBytes: Buffer.byteLength(contents),
        urls: [fileName],
      },
    ],
  };
}

async function writeRelease(root: string, contents: string): Promise<string> {
  const releaseDir = join(root, "releases", ZCODE_VERSION);
  await mkdir(releaseDir, { recursive: true });
  await writeFile(join(releaseDir, fileName), contents);
  await writeFile(
    join(releaseDir, "source-server-release.json"),
    JSON.stringify(descriptor(contents)),
  );
  return releaseDir;
}

describe("Source Server release resolver", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses and verifies a staged local archive for local-download-upload", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-source-release-local-"));
    const contents = "local-source-server";
    const releaseDir = await writeRelease(root, contents);

    const release = await resolveSourceServerReleaseAsset(probe, { mockCdnDir: root }, target);

    expect(release).toMatchObject({
      localArchivePath: join(releaseDir, fileName),
      target: "linux-x64",
      version: ZCODE_VERSION,
      sha256: sha256(contents),
      sizeBytes: Buffer.byteLength(contents),
    });
  });

  it("uses the staged local archive for development even when SSH prefers remote download", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-source-release-dev-local-"));
    const contents = "development-source-server";
    const releaseDir = await writeRelease(root, contents);
    const fetchMock = vi.fn(async () => {
      throw new Error("development resolution must not access CDN");
    });
    vi.stubGlobal("fetch", fetchMock);

    const release = await resolveSourceServerReleaseAsset(
      probe,
      {
        mockCdnDir: root,
        sourceServerArtifactPolicy: "development-content-addressed",
      },
      { ...target, assetInstallMode: "remote-download" },
    );

    expect(release.localArchivePath).toBe(join(releaseDir, fileName));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the bundled fork release for SSH remote-download instead of the CDN", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-source-release-bundled-"));
    const contents = "bundled-source-server";
    const releaseDir = await writeRelease(root, contents);
    const fetchMock = vi.fn(async () => {
      throw new Error("bundled release must win over the CDN");
    });
    vi.stubGlobal("fetch", fetchMock);

    const release = await resolveSourceServerReleaseAsset(
      probe,
      { bundledReleaseDir: root },
      { ...target, assetInstallMode: "remote-download" },
    );

    expect(release).toMatchObject({
      localArchivePath: join(releaseDir, fileName),
      version: ZCODE_VERSION,
      sha256: sha256(contents),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed without a staged local development descriptor", async () => {
    const fetchMock = vi.fn(async () => new Response("production-release", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveSourceServerReleaseAsset(
        probe,
        {
          sourceServerArtifactPolicy: "development-content-addressed",
          remoteCdnBaseUrls: ["https://cdn.example.test/releases"],
        },
        target,
      ),
    ).rejects.toThrow("run pnpm bootstrap:with-remote");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never falls back to a CDN when the bundled release is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-source-release-no-bundle-"));
    const fetchMock = vi.fn(async () => {
      throw new Error("CDN fallback must be disabled");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resolveSourceServerReleaseAsset(
        probe,
        {
          remoteCdnBaseUrls: ["https://cdn.example.test/releases"],
          remoteCacheDir: root,
        },
        target,
      ),
    ).rejects.toThrow("remote CDN fallback is disabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
