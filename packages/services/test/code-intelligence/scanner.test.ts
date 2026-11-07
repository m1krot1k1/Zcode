import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanWorkspace } from "../../src/code-intelligence/scanner.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("code index scanner", () => {
  it("honors nested ignore rules and detects same-size edits with a preserved mtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-code-scanner-"));
    tempRoots.push(root);
    const appDir = join(root, "packages", "app");
    await mkdir(appDir, { recursive: true });
    const sourcePath = join(appDir, "index.ts");
    await writeFile(join(appDir, ".gitignore"), "private.ts\n", "utf8");
    await writeFile(sourcePath, "export const beforeName = 1;\n", "utf8");
    await writeFile(join(appDir, "private.ts"), "export const hiddenName = 1;\n", "utf8");

    const initial = await scanWorkspace(root, new Map(), true, () => undefined);
    expect(initial.files.map((file) => file.path)).toEqual(["packages/app/index.ts"]);
    const previous = new Map(
      initial.files.map((file) => [
        file.path,
        {
          mtimeMs: file.mtimeMs,
          ctimeMs: file.ctimeMs,
          size: file.size,
          fingerprint: file.fingerprint ?? "",
        },
      ]),
    );
    const sourceStat = await stat(sourcePath);
    await writeFile(sourcePath, "export const afterName = 1;\n", "utf8");
    await utimes(sourcePath, sourceStat.atime, sourceStat.mtime);

    const refreshed = await scanWorkspace(root, previous, false, () => undefined);
    expect(refreshed.files[0]?.changed).toBe(true);
    expect(Math.abs((refreshed.files[0]?.mtimeMs ?? 0) - sourceStat.mtimeMs)).toBeLessThan(1);
  });
});
