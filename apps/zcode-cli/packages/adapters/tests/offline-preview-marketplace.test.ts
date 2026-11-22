import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@zcode/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zcode/shared")>()),
  ZCODE_OFFLINE_PREVIEW: true,
}));

import {
  ensureMarketplaceManifestAvailable,
  updateMarketplace,
} from "../src/plugins/marketplace.js";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID } from "@zcode/shared";

describe("offline Preview marketplace behavior", () => {
  let storageRoot: string | undefined;

  afterEach(async () => {
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
    storageRoot = undefined;
    vi.restoreAllMocks();
  });

  it("does not fetch the missing official catalog and explains why it is unavailable", async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "zcode-offline-marketplace-"));
    await expect(
      ensureMarketplaceManifestAvailable({
        marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
        storageRoot,
      }),
    ).rejects.toThrow("not cached in this offline Preview build");
  });

  it("does not refresh the official catalog on an explicit offline refresh", async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "zcode-offline-marketplace-"));

    await expect(
      updateMarketplace({
        marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
        storageRoot,
      }),
    ).rejects.toThrow("Official ZCode plugin updates are unavailable in the offline Preview build");
  });
});
