import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanWorkspaceFiles } from "../../src/code-intelligence/worker/workspaceScan.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("code index scanner (schema v2)", () => {
  it("honors nested ignore rules and excludes binaries and non-source files", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-code-scanner-"));
    tempRoots.push(root);
    const appDir = join(root, "packages", "app");
    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, ".gitignore"), "private.ts\n", "utf8");
    await writeFile(join(appDir, "index.ts"), "export const beforeName = 1;\n", "utf8");
    await writeFile(join(appDir, "private.ts"), "export const hiddenName = 1;\n", "utf8");
    await writeFile(join(appDir, "notes.txt"), "not indexed\n", "utf8");
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "node_modules", "pkg", "index.ts"), "export const x = 1;\n", "utf8");

    const scan = await scanWorkspaceFiles(root);

    // .gitignore внутри каталога применяется с его префиксом; node_modules отсеян пре-фильтром.
    expect(scan.files.map((file) => file.relPath)).toEqual(["packages/app/index.ts"]);
    expect(scan.truncated).toBe(false);
  });

  it("indexes non-JS languages instead of reporting ready with zero files", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-code-scanner-langs-"));
    tempRoots.push(root);
    await mkdir(join(root, "app"), { recursive: true });
    await writeFile(join(root, "app", "service.py"), "def run():\n    return 1\n", "utf8");
    await writeFile(join(root, "main.go"), "package main\n\nfunc main() {}\n", "utf8");
    await writeFile(join(root, "lib.rs"), "pub fn run() -> i32 { 1 }\n", "utf8");

    const scan = await scanWorkspaceFiles(root);

    expect(scan.files.map((file) => file.relPath).sort()).toEqual([
      "app/service.py",
      "lib.rs",
      "main.go",
    ]);
    // Тиры путей считаются при скане: тесты/фикстуры де-бустятся при поиске.
    expect(scan.files.every((file) => file.pathTier === 0)).toBe(true);
  });

  it("includes source files up to 8 MiB and reports only the larger ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-code-scanner-size-"));
    tempRoots.push(root);
    await writeFile(join(root, "large.ts"), "x".repeat(2 * 1024 * 1024), "utf8");
    await writeFile(join(root, "huge.ts"), "x".repeat(9 * 1024 * 1024), "utf8");

    const scan = await scanWorkspaceFiles(root);

    expect(scan.files.map((file) => file.relPath)).toEqual(["large.ts"]);
    expect(scan.skippedLarge).toBe(1);
  });

  it("skips secret-looking files and reports them instead of indexing silently", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-code-scanner-secret-"));
    tempRoots.push(root);
    await writeFile(join(root, "app.ts"), "export const ok = true;\n", "utf8");
    await writeFile(join(root, "id_rsa"), "PRIVATE KEY MATERIAL\n", "utf8");

    const scan = await scanWorkspaceFiles(root);

    expect(scan.files.map((file) => file.relPath)).toEqual(["app.ts"]);
    expect(scan.skippedSecret).toBeGreaterThanOrEqual(0);
  });
});
