import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { capture, run } from "./commands.mjs";
import {
  assertAssetHashes,
  assertReleaseMetadata,
  assertReleaseTargetSha,
  resolveTagCommitSha,
} from "./github-release.mjs";
import { sha256File } from "./hash.mjs";

export async function verifyPublishedRelease(tag, assetNames, expectedCommitSha, expectedHashes) {
  const metadataText = await capture([
    "gh",
    "release",
    "view",
    tag,
    "--json",
    "tagName,isDraft,assets,url",
  ]);
  const metadata = JSON.parse(metadataText);
  assertReleaseMetadata(metadata, tag, assetNames);
  assertReleaseTargetSha(
    await resolveTagCommitSha(tag, async (route) => {
      const response = await capture(["gh", "api", route]);
      return JSON.parse(response);
    }),
    expectedCommitSha,
  );

  const verificationDir = await mkdtemp(path.join(tmpdir(), "zcode-release-verify-"));
  try {
    await run(["gh", "release", "download", tag, "--dir", verificationDir]);
    const downloadedNames = await readdir(verificationDir);
    const downloadedHashes = new Map();
    for (const name of downloadedNames) {
      downloadedHashes.set(name, await sha256File(path.join(verificationDir, name)));
    }
    assertAssetHashes(expectedHashes, downloadedHashes);
  } finally {
    await rm(verificationDir, { recursive: true, force: true });
  }
  return metadata.url;
}
