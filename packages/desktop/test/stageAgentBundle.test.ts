import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUNDLED_SKILL_PACK_REQUIRED_PATHS,
  stageAgentBundle,
} from "../scripts/stage-agent-bundle.mjs";

const SOURCE_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BUNDLED_PACK_RELATIVE_PATH = "apps/zcode-cli/packages/bundled-skills";
const REQUIRED_CLI_BUNDLE_PATH = "apps/zcode-cli/packages/cli/dist/zcode.cjs";
const STAGING_PLATFORM_KEY = "test-platform";
const CLI_BUNDLE_SENTINEL = "ZCODE_DESKTOP_AGENT_BUNDLE_SENTINEL";

describe("Desktop agent bundle stages native skill and rule resources", () => {
  it("copies every source skill and rule path with the original contents", async () => {
    const repoRoot = await createStagingRepository();

    try {
      const result = stageAgentBundle({
        repoRoot,
        platformKey: STAGING_PLATFORM_KEY,
        log: () => undefined,
      });
      const stagedPackRoot = join(
        repoRoot,
        "packages/desktop/bundled-agents",
        STAGING_PLATFORM_KEY,
        "glm/packages/bundled-skills",
      );
      const sourcePackRoot = join(repoRoot, BUNDLED_PACK_RELATIVE_PATH);
      const sourcePaths = await listPackResourcePaths(sourcePackRoot);
      const stagedPaths = await listPackResourcePaths(stagedPackRoot);

      expect(await readFile(result.stagedBundlePath, "utf8")).toBe(CLI_BUNDLE_SENTINEL);
      expect(stagedPaths.toSorted()).toEqual(sourcePaths.toSorted());
      for (const relativePath of sourcePaths) {
        expect(await readFile(join(stagedPackRoot, relativePath))).toEqual(
          await readFile(join(sourcePackRoot, relativePath)),
        );
      }
      for (const requiredPath of BUNDLED_SKILL_PACK_REQUIRED_PATHS) {
        expect(stagedPaths).toContain(requiredPath);
      }
    } finally {
      await rm(repoRoot, { force: true, recursive: true });
    }
  });

  it("rejects staging when a required skill or rule is missing", async () => {
    const repoRoot = await createStagingRepository();
    const missingPath = BUNDLED_SKILL_PACK_REQUIRED_PATHS[0]!;

    try {
      await rm(join(repoRoot, BUNDLED_PACK_RELATIVE_PATH, missingPath));

      expect(() =>
        stageAgentBundle({
          repoRoot,
          platformKey: STAGING_PLATFORM_KEY,
          log: () => undefined,
        }),
      ).toThrow(new RegExp(missingPath.replaceAll("/", "[/\\\\]"), "u"));
    } finally {
      await rm(repoRoot, { force: true, recursive: true });
    }
  });
});

async function createStagingRepository(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), "zcode-desktop-agent-stage-"));
  const sourcePackRoot = join(SOURCE_REPO_ROOT, BUNDLED_PACK_RELATIVE_PATH);
  const destinationPackRoot = join(repoRoot, BUNDLED_PACK_RELATIVE_PATH);
  const cliBundlePath = join(repoRoot, REQUIRED_CLI_BUNDLE_PATH);

  await mkdir(join(repoRoot, "apps/zcode-cli/packages/cli/dist"), { recursive: true });
  await writeFile(cliBundlePath, CLI_BUNDLE_SENTINEL, "utf8");
  await cp(sourcePackRoot, destinationPackRoot, { recursive: true });
  return repoRoot;
}

async function listPackResourcePaths(packRoot: string): Promise<string[]> {
  const output: string[] = [];

  for (const topLevel of ["skills", "rules"]) {
    await collectFiles(join(packRoot, topLevel), packRoot, output);
  }

  return output.toSorted();
}

async function collectFiles(directory: string, root: string, output: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(path, root, output);
    } else if (entry.isFile()) {
      output.push(relative(root, path));
    }
  }
}
