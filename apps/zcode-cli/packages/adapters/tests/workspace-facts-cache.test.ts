// ============================================================
// Workspace facts cache - focused regression tests
// ============================================================
// Покрывает: hit/miss без повторных чтений, инвалидацию, identity/remote,
// отсутствие секретов, конкурентную запись, битый JSON, fail-open,
// классификацию scripts и provenance-контракт.

import {
  mkdir,
  mkdtemp,
  readFile as readFileFromDisk,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { ProjectContext } from "@zcode/contracts";
import { describe, expect, it } from "vitest";
import { NodeContextSourceAdapter } from "../src/context/index.js";
import {
  buildWorkspaceProjectContext,
  classifyScripts,
  fingerprintWorkspaceInputs,
  nodeWorkspaceFactsIo,
  probeWorkspaceInputs,
  redactCommand,
  resolveGitMetadata,
  type WorkspaceFactsIo,
} from "../src/context/workspace-facts.js";
import {
  WORKSPACE_FACTS_CACHE_SCHEMA_VERSION,
  WorkspaceFactsCache,
  type WorkspaceFactsCacheInput,
} from "../src/context/workspace-facts-cache.js";

const PROJECT = "/ws/project";
const CACHE_ROOT = "/cache";
const IDENTITY = "local:/ws/project";
const HEAD_SHA = "a".repeat(40);
const NOW = 1_800_000_000_000;
const FACT_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "tsconfig.json",
  "vitest.config.ts",
  "mise.toml",
  "pnpm-workspace.yaml",
];

/**
 * Проверка containment по canonical path: лексический startsWith не ловит
 * чтение через symlink внутри projectRoot, чей realpath ведёт за пределы дерева.
 */
async function expectReadsInsideRealRoot(
  projectRoot: string,
  reads: readonly string[],
): Promise<void> {
  const rootReal = await realpath(projectRoot);
  for (const filePath of reads) {
    const fileReal = await realpath(filePath);
    const rel = relative(rootReal, fileReal);
    expect(
      rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)),
      `read outside project real root: ${filePath} -> ${fileReal}`,
    ).toBe(true);
  }
}

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error("ENOENT"), { code: "ENOENT" });
}

class MemoryIo implements WorkspaceFactsIo {
  readonly files = new Map<string, { data: Buffer; mtimeMs: number }>();
  readonly directories = new Set<string>();
  /** Пути, для которых lstat сообщает isSymbolicLink=true. */
  readonly symlinks = new Set<string>();
  readonly reads: string[] = [];
  readonly writes: string[] = [];
  readonly renames: Array<{ from: string; to: string }> = [];
  failOn: "readdir" | "stat" | undefined;
  private clock = 10;

  addDirectory(directory: string): void {
    let current = directory;
    for (;;) {
      this.directories.add(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  addFile(filePath: string, content: string, mtimeMs?: number): void {
    this.addDirectory(dirname(filePath));
    this.clock += 1;
    this.files.set(filePath, { data: Buffer.from(content), mtimeMs: mtimeMs ?? this.clock });
  }

  updateFile(filePath: string, content: string): void {
    this.addFile(filePath, content);
  }

  resetReads(): void {
    this.reads.length = 0;
  }

  markSymlink(filePath: string): void {
    this.symlinks.add(filePath);
  }

  async stat(filePath: string): Promise<{ isFile: boolean; mtimeMs: number; size: number } | null> {
    if (this.failOn === "stat") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    const file = this.files.get(filePath);
    if (file) return { isFile: true, mtimeMs: file.mtimeMs, size: file.data.length };
    if (this.directories.has(filePath)) return { isFile: false, mtimeMs: 1, size: 0 };
    return null;
  }

  async lstat(
    filePath: string,
  ): Promise<{ isFile: boolean; mtimeMs: number; size: number; isSymbolicLink: boolean } | null> {
    if (this.failOn === "stat") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    const isSymbolicLink = this.symlinks.has(filePath);
    const file = this.files.get(filePath);
    if (file) {
      return { isFile: true, mtimeMs: file.mtimeMs, size: file.data.length, isSymbolicLink };
    }
    if (this.directories.has(filePath))
      return { isFile: false, mtimeMs: 1, size: 0, isSymbolicLink };
    return null;
  }

  async readFile(filePath: string): Promise<Buffer> {
    this.reads.push(filePath);
    const file = this.files.get(filePath);
    if (!file) throw enoent();
    return file.data;
  }

  async readdir(directory: string): Promise<string[]> {
    if (this.failOn === "readdir") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    if (!this.directories.has(directory)) throw enoent();
    const names = new Set<string>();
    for (const path of [...this.files.keys(), ...this.directories]) {
      if (path === directory) continue;
      const rel = relative(directory, path);
      if (rel && !rel.startsWith("..") && !rel.includes("/")) names.add(rel);
    }
    return [...names];
  }

  async mkdir(directory: string): Promise<void> {
    this.addDirectory(directory);
  }

  async writeFile(
    filePath: string,
    data: string,
    options?: { mode?: number; flag?: "wx" },
  ): Promise<void> {
    if (options?.flag === "wx" && this.files.has(filePath)) {
      throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    }
    this.writes.push(filePath);
    this.addFile(filePath, data);
  }

  async rename(from: string, to: string): Promise<void> {
    const file = this.files.get(from);
    if (!file) throw enoent();
    this.renames.push({ from, to });
    this.files.delete(from);
    this.files.set(to, file);
  }

  async unlink(filePath: string): Promise<void> {
    this.files.delete(filePath);
  }
}

function addGitMetadata(io: MemoryIo, sha = HEAD_SHA): void {
  io.addFile(`${PROJECT}/.git/HEAD`, "ref: refs/heads/main\n");
  io.addFile(`${PROJECT}/.git/refs/heads/main`, `${sha}\n`);
  io.addFile(`${PROJECT}/.git/index`, "index");
}

function addNodeProject(
  io: MemoryIo,
  scripts: Record<string, string> = { test: "vitest run", build: "vite build" },
): void {
  io.addFile(
    `${PROJECT}/package.json`,
    JSON.stringify({
      name: "fixture",
      packageManager: "pnpm@9.15.0",
      engines: { node: ">=20" },
      scripts,
    }),
  );
  io.addFile(`${PROJECT}/pnpm-lock.yaml`, "lockfileVersion: 9\n");
  io.addFile(`${PROJECT}/tsconfig.json`, '{"compilerOptions":{"strict":true}}\n');
  io.addFile(`${PROJECT}/vitest.config.ts`, "export default {}\n");
}

function createCache(io: WorkspaceFactsIo, now: () => number = () => NOW): WorkspaceFactsCache {
  return new WorkspaceFactsCache({ cacheRoot: CACHE_ROOT, io, now });
}

function cacheInput(identityKey = IDENTITY): WorkspaceFactsCacheInput {
  return {
    projectRoot: PROJECT,
    identityKey,
    git: {},
    runtime: { node: "v22.23.5", platform: "linux", arch: "x64" },
  };
}

function createHooks(counter: { calls: number }) {
  return {
    compute: (snapshot: Parameters<typeof buildWorkspaceProjectContext>[0]["snapshot"]) => {
      counter.calls += 1;
      return buildWorkspaceProjectContext({ snapshot, now: NOW });
    },
    fallback: (): ProjectContext => ({ type: "unknown" }),
  };
}

function factReads(reads: readonly string[]): string[] {
  return reads.filter((path) => FACT_FILES.includes(basename(path)));
}

describe("WorkspaceFactsCache", () => {
  it("does not re-read fact files on cache hit", async () => {
    const io = new MemoryIo();
    addGitMetadata(io);
    addNodeProject(io);
    const cache = createCache(io);
    const counter = { calls: 0 };

    const first = await cache.resolve(cacheInput(), createHooks(counter));
    // Fixture содержит 4 файла-факта: package.json, pnpm-lock.yaml, tsconfig.json, vitest.config.ts.
    expect(factReads(io.reads).length).toBe(4);
    expect(counter.calls).toBe(1);
    expect(first.workspaceFacts?.classifiedScripts.test.map((item) => item.name)).toEqual(["test"]);

    io.resetReads();
    const second = await cache.resolve(cacheInput(), createHooks(counter));
    expect(factReads(io.reads)).toEqual([]);
    expect(counter.calls).toBe(1);
    expect(second.workspaceFacts?.provenance.computedAt).toBe(
      first.workspaceFacts?.provenance.computedAt,
    );
  });

  it("keys the cache by git HEAD even when the ref file stat is unchanged", async () => {
    const io = new MemoryIo();
    addGitMetadata(io);
    addNodeProject(io);
    const cache = createCache(io);
    const counter = { calls: 0 };
    const input = cacheInput();

    await cache.resolve(input, createHooks(counter));
    const entry = JSON.parse(
      io.files.get(cache.filePathForIdentity(IDENTITY))?.data.toString("utf8") ?? "{}",
    ) as { git?: { head?: string } };
    // Regression: mergeGitFacts терял head, поэтому запись не содержала HEAD
    // и смена HEAD не инвалидировала snapshot.
    expect(entry.git?.head).toBe(HEAD_SHA);

    const nextHead = "c".repeat(40);
    const headPath = `${PROJECT}/.git/refs/heads/main`;
    const previous = io.files.get(headPath);
    // Сохраняем mtime намеренно: инвалидация обязана произойти по содержимому HEAD.
    io.files.set(headPath, {
      data: Buffer.from(`${nextHead}\n`),
      mtimeMs: previous?.mtimeMs ?? 1,
    });

    const afterHead = await cache.resolve(input, createHooks(counter));
    expect(counter.calls).toBe(2);
    expect(afterHead.workspaceFacts?.provenance.gitHead).toBe(nextHead);
  });

  it("invalidates on git HEAD, dirty, package.json, lockfile, tsconfig, test config and mise", async () => {
    const io = new MemoryIo();
    addGitMetadata(io);
    addNodeProject(io);
    io.addFile(`${PROJECT}/mise.toml`, '[tools]\nnode = "22.11.0"\n');
    const cache = createCache(io);
    const counter = { calls: 0 };
    const input = cacheInput();

    await cache.resolve(input, createHooks(counter));
    expect(counter.calls).toBe(1);
    await cache.resolve(input, createHooks(counter));
    expect(counter.calls).toBe(1);

    const headSha = "b".repeat(40);
    io.updateFile(`${PROJECT}/.git/refs/heads/main`, `${headSha}\n`);
    const afterHead = await cache.resolve(input, createHooks(counter));
    expect(counter.calls).toBe(2);
    expect(afterHead.workspaceFacts?.provenance.gitHead).toBe(headSha);

    const dirtyInput: WorkspaceFactsCacheInput = {
      ...input,
      git: { dirty: true, dirtySignature: "dirty-a" },
    };
    await cache.resolve(dirtyInput, createHooks(counter));
    expect(counter.calls).toBe(3);

    io.updateFile(
      `${PROJECT}/package.json`,
      JSON.stringify({ scripts: { test: "jest", build: "tsc -b" } }),
    );
    const afterPackage = await cache.resolve(dirtyInput, createHooks(counter));
    expect(counter.calls).toBe(4);
    expect(afterPackage.scripts?.test).toBe("jest");

    io.files.delete(`${PROJECT}/pnpm-lock.yaml`);
    io.addFile(`${PROJECT}/yarn.lock`, "# yarn\n");
    const afterLockfile = await cache.resolve(dirtyInput, createHooks(counter));
    expect(counter.calls).toBe(5);
    expect(afterLockfile.packageManager).toBe("yarn");

    io.updateFile(`${PROJECT}/tsconfig.json`, '{"compilerOptions":{"strict":false}}\n');
    await cache.resolve(dirtyInput, createHooks(counter));
    expect(counter.calls).toBe(6);

    io.updateFile(`${PROJECT}/vitest.config.ts`, "export default { test: {} }\n");
    await cache.resolve(dirtyInput, createHooks(counter));
    expect(counter.calls).toBe(7);

    io.updateFile(`${PROJECT}/mise.toml`, '[tools]\nnode = "22.12.0"\n');
    const afterMise = await cache.resolve(dirtyInput, createHooks(counter));
    expect(counter.calls).toBe(8);
    expect(afterMise.workspaceFacts?.toolchain.mise?.node).toBe("22.12.0");
  });

  it("invalidates when dirtySignature changes A to B with identical HEAD and stats", async () => {
    const io = new MemoryIo();
    addGitMetadata(io);
    addNodeProject(io);
    const cache = createCache(io);
    const counter = { calls: 0 };
    const dirtyA: WorkspaceFactsCacheInput = {
      ...cacheInput(),
      git: { dirty: true, dirtySignature: "dirty-a" },
    };
    const dirtyB: WorkspaceFactsCacheInput = {
      ...cacheInput(),
      git: { dirty: true, dirtySignature: "dirty-b" },
    };

    await cache.resolve(dirtyA, createHooks(counter));
    await cache.resolve(dirtyA, createHooks(counter));
    expect(counter.calls).toBe(1);

    // HEAD и stat-отпечатки входов не менялись: инвалидация обязана произойти
    // только по dirty signature из envInfo, а не по содержимому файлов.
    const beforeStats = io.files.get(`${PROJECT}/package.json`)?.mtimeMs;
    await cache.resolve(dirtyB, createHooks(counter));
    expect(counter.calls).toBe(2);
    expect(io.files.get(`${PROJECT}/package.json`)?.mtimeMs).toBe(beforeStats);

    const entry = JSON.parse(
      io.files.get(cache.filePathForIdentity(IDENTITY))?.data.toString("utf8") ?? "{}",
    ) as { git?: { dirtySignature?: string } };
    expect(entry.git?.dirtySignature).toBe("dirty-b");
  });

  it("invalidates when pnpm-workspace.yaml changes without script changes", async () => {
    const io = new MemoryIo();
    addGitMetadata(io);
    addNodeProject(io);
    io.addFile(`${PROJECT}/pnpm-workspace.yaml`, "packages:\n  - 'packages/*'\n");
    const cache = createCache(io);
    const counter = { calls: 0 };

    const first = await cache.resolve(cacheInput(), createHooks(counter));
    expect(counter.calls).toBe(1);
    expect(first.workspaceFacts?.monorepo.workspaces).toEqual(["packages/*"]);
    await cache.resolve(cacheInput(), createHooks(counter));
    expect(counter.calls).toBe(1);

    io.updateFile(`${PROJECT}/pnpm-workspace.yaml`, "packages:\n  - apps/*\n");
    const afterWorkspace = await cache.resolve(cacheInput(), createHooks(counter));
    expect(counter.calls).toBe(2);
    expect(afterWorkspace.workspaceFacts?.monorepo.workspaces).toEqual(["apps/*"]);
  });

  it("invalidates on jest and playwright config changes like vitest", async () => {
    const io = new MemoryIo();
    addGitMetadata(io);
    addNodeProject(io);
    io.addFile(`${PROJECT}/jest.config.js`, "module.exports = {}\n");
    io.addFile(`${PROJECT}/playwright.config.ts`, "export default {}\n");
    const cache = createCache(io);
    const counter = { calls: 0 };

    await cache.resolve(cacheInput(), createHooks(counter));
    expect(counter.calls).toBe(1);
    await cache.resolve(cacheInput(), createHooks(counter));
    expect(counter.calls).toBe(1);

    io.updateFile(`${PROJECT}/jest.config.js`, "module.exports = { testMatch: [] }\n");
    await cache.resolve(cacheInput(), createHooks(counter));
    expect(counter.calls).toBe(2);

    io.updateFile(`${PROJECT}/playwright.config.ts`, "export default { testDir: 'e2e' }\n");
    await cache.resolve(cacheInput(), createHooks(counter));
    expect(counter.calls).toBe(3);
  });

  it("refuses symlinked fixed inputs and never reads their targets", async () => {
    const io = new MemoryIo();
    addGitMetadata(io);
    addNodeProject(io);
    io.addFile(`${PROJECT}/.nvmrc`, "99.99.99-secret-version\n");
    io.markSymlink(`${PROJECT}/.nvmrc`);
    io.addFile(`${PROJECT}/mise.toml`, '[tools]\nnode = "98.98.98"\n');
    io.markSymlink(`${PROJECT}/mise.toml`);
    const cache = createCache(io);

    const result = await cache.resolve(cacheInput(), createHooks({ calls: 0 }));
    expect(io.reads).not.toContain(`${PROJECT}/.nvmrc`);
    expect(io.reads).not.toContain(`${PROJECT}/mise.toml`);
    expect(result.workspaceFacts?.toolchain.mise).toBeUndefined();
    expect(result.workspaceFacts?.toolchain.node).not.toBe("99.99.99-secret-version");
    const serialized =
      io.files.get(cache.filePathForIdentity(IDENTITY))?.data.toString("utf8") ?? "";
    expect(serialized).not.toContain("99.99.99-secret-version");
    expect(serialized).not.toContain("98.98.98");
  });

  it("fails closed on gitdir and commondir outside the project root", async () => {
    const outside = "/outside/repo";

    // .git-файл с gitdir: за пределами projectRoot HEAD/refs не читаются.
    const gitdirIo = new MemoryIo();
    addNodeProject(gitdirIo);
    gitdirIo.addFile(`${PROJECT}/.git`, `gitdir: ${outside}/.git\n`);
    gitdirIo.addFile(`${outside}/.git/HEAD`, "ref: refs/heads/main\n");
    gitdirIo.addFile(`${outside}/.git/refs/heads/main`, `${HEAD_SHA}\n`);
    const gitdirResult = await createCache(gitdirIo).resolve(
      cacheInput(),
      createHooks({ calls: 0 }),
    );
    expect(gitdirResult.workspaceFacts?.provenance.gitHead).toBeUndefined();
    expect(gitdirIo.reads.filter((path) => path.startsWith(outside))).toEqual([]);

    // commondir: внешний каталог игнорируется, читается только gitDir внутри root.
    const commonIo = new MemoryIo();
    addNodeProject(commonIo);
    commonIo.addFile(`${PROJECT}/.git/HEAD`, "ref: refs/heads/main\n");
    commonIo.addFile(`${PROJECT}/.git/commondir`, `${outside}/common\n`);
    commonIo.addFile(`${outside}/common/refs/heads/main`, `${HEAD_SHA}\n`);
    const commonResult = await createCache(commonIo).resolve(
      cacheInput(),
      createHooks({ calls: 0 }),
    );
    expect(commonResult.workspaceFacts?.provenance.gitHead).toBe("ref:refs/heads/main");
    expect(commonIo.reads.filter((path) => path.startsWith(outside))).toEqual([]);
  });

  it("isolates local and remote identity keys for the same project path", async () => {
    const io = new MemoryIo();
    addGitMetadata(io);
    addNodeProject(io);
    const cache = createCache(io);
    const counter = { calls: 0 };

    await cache.resolve(cacheInput("local:/ws/project"), createHooks(counter));
    await cache.resolve(cacheInput("remote:server-1:/ws/project"), createHooks(counter));
    expect(counter.calls).toBe(2);
    expect(cache.filePathForIdentity("local:/ws/project")).not.toBe(
      cache.filePathForIdentity("remote:server-1:/ws/project"),
    );
    await cache.resolve(cacheInput("local:/ws/project"), createHooks(counter));
    expect(counter.calls).toBe(2);
  });

  it("never persists secret values and redacts script assignments", async () => {
    const secret = "s3cr3t-value-123";
    const bearerToken = "abcdefgh12345678";
    const io = new MemoryIo();
    addGitMetadata(io);
    addNodeProject(io, {
      deploy: `MY_SECRET_TOKEN=${secret} node deploy.js`,
      login: "curl https://user:pass@example.com",
      auth: `curl -H 'Authorization: Bearer ${bearerToken}' https://api.example.com`,
    });
    const cache = createCache(io);
    const result = await cache.resolve(cacheInput(), createHooks({ calls: 0 }));

    const serialized =
      io.files.get(cache.filePathForIdentity(IDENTITY))?.data.toString("utf8") ?? "";
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("user:pass");
    expect(serialized).not.toContain(bearerToken);
    expect(serialized).toContain("<redacted>");
    expect(result.scripts?.deploy).not.toContain(secret);
    expect(result.scripts?.auth).toContain("Authorization: Bearer <redacted>");
    expect(result.scripts?.auth).not.toContain(bearerToken);
  });

  it("deduplicates concurrent resolves into one compute and one write", async () => {
    const io = new MemoryIo();
    addGitMetadata(io);
    addNodeProject(io);
    const cache = createCache(io);
    const counter = { calls: 0 };
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const hooks = {
      compute: async (snapshot: Parameters<typeof buildWorkspaceProjectContext>[0]["snapshot"]) => {
        counter.calls += 1;
        await gate;
        return buildWorkspaceProjectContext({ snapshot, now: NOW });
      },
      fallback: (): ProjectContext => ({ type: "unknown" }),
    };

    const pending = [
      cache.resolve(cacheInput(), hooks),
      cache.resolve(cacheInput(), hooks),
      cache.resolve(cacheInput(), hooks),
      cache.resolve(cacheInput(), hooks),
    ];
    release?.();
    const results = await Promise.all(pending);

    expect(counter.calls).toBe(1);
    expect(results.every((result) => result === results[0])).toBe(true);
    expect(
      io.renames.filter((rename) => rename.to === cache.filePathForIdentity(IDENTITY)),
    ).toHaveLength(1);
  });

  it("recovers from corrupted JSON, rewrites a valid entry and then hits", async () => {
    const io = new MemoryIo();
    addGitMetadata(io);
    addNodeProject(io);
    const cache = createCache(io);
    const counter = { calls: 0 };
    const cachePath = cache.filePathForIdentity(IDENTITY);
    io.addFile(cachePath, "{not-json\n");

    await cache.resolve(cacheInput(), createHooks(counter));
    expect(counter.calls).toBe(1);
    const parsed = JSON.parse(io.files.get(cachePath)?.data.toString("utf8") ?? "{}") as {
      schemaVersion?: number;
    };
    expect(parsed.schemaVersion).toBe(WORKSPACE_FACTS_CACHE_SCHEMA_VERSION);

    io.resetReads();
    await cache.resolve(cacheInput(), createHooks(counter));
    expect(counter.calls).toBe(1);
  });

  it("fails open to the current detectProjectContext when cache IO fails", async () => {
    const io = new MemoryIo();
    addGitMetadata(io);
    addNodeProject(io);
    io.failOn = "readdir";
    const cache = createCache(io);
    const counter = { calls: 0 };

    const result = await cache.resolve(cacheInput(), {
      compute: () => {
        counter.calls += 1;
        throw new Error("compute must not run");
      },
      fallback: () => ({ type: "python" }),
    });
    expect(result.type).toBe("python");
    expect(counter.calls).toBe(0);
    expect(io.writes).toEqual([]);
  });

  it("expires entries after TTL and on runtime version change", async () => {
    const io = new MemoryIo();
    addGitMetadata(io);
    addNodeProject(io);
    let now = NOW;
    const cache = new WorkspaceFactsCache({
      cacheRoot: CACHE_ROOT,
      io,
      now: () => now,
      ttlMs: 1_000,
    });
    const counter = { calls: 0 };

    await cache.resolve(cacheInput(), createHooks(counter));
    now += 500;
    await cache.resolve(cacheInput(), createHooks(counter));
    expect(counter.calls).toBe(1);
    now += 1_000;
    await cache.resolve(cacheInput(), createHooks(counter));
    expect(counter.calls).toBe(2);
    await cache.resolve(
      { ...cacheInput(), runtime: { node: "v23.0.0", platform: "linux", arch: "x64" } },
      createHooks(counter),
    );
    expect(counter.calls).toBe(3);
  });

  it("exposes monorepo and toolchain facts without executing commands", async () => {
    const io = new MemoryIo();
    addGitMetadata(io);
    addNodeProject(io);
    io.addFile(`${PROJECT}/pnpm-workspace.yaml`, "packages:\n  - 'packages/*'\n  - apps/*\n");
    io.addFile(`${PROJECT}/mise.toml`, '[tools]\nnode = "22.11.0"\npnpm = "9.15.0"\n');
    io.addFile(`${PROJECT}/.nvmrc`, "20.11.0\n");
    const cache = createCache(io);

    const result = await cache.resolve(cacheInput(), createHooks({ calls: 0 }));
    expect(result.workspaceFacts?.monorepo).toEqual({
      isMonorepo: true,
      workspaces: ["packages/*", "apps/*"],
    });
    expect(result.workspaceFacts?.toolchain.node).toBe("20.11.0");
    expect(result.workspaceFacts?.toolchain.mise).toEqual({ node: "22.11.0", pnpm: "9.15.0" });
    expect(result.workspaceFacts?.verifiedCommands).toEqual([]);
    expect(result.workspaceFacts?.verifiedCommandsStatus).toBe("unavailable");
    expect(result.workspaceFacts?.provenance.gitHead).toBe(HEAD_SHA);
  });
});

describe("workspace facts classification", () => {
  it("classifies scripts by name and command without duplicates", () => {
    const classified = classifyScripts({
      test: "vitest run",
      "test:unit": "jest",
      e2e: "playwright test",
      lint: "eslint .",
      "lint:fix": "eslint . --fix",
      typecheck: "tsc --noEmit",
      "type-check": "vue-tsc --noEmit",
      build: "tsc -b",
      "build:web": "vite build",
      dev: "vite",
      "dev:desktop": "electron .",
      check: "eslint . && tsc --noEmit",
      deploy: "node deploy.js",
    });

    expect(classified.test.map((item) => item.name)).toEqual(["e2e", "test", "test:unit"]);
    expect(classified.lint.map((item) => item.name)).toEqual(["check", "lint", "lint:fix"]);
    expect(classified.typecheck.map((item) => item.name)).toEqual(["type-check", "typecheck"]);
    expect(classified.build.map((item) => item.name)).toEqual(["build", "build:web"]);
    expect(classified.dev.map((item) => item.name)).toEqual(["dev", "dev:desktop"]);
    const allNames = Object.values(classified).flatMap((items) => items.map((item) => item.name));
    expect(allNames).toContain("check");
    expect(allNames).not.toContain("deploy");
    // "check" классифицирован по команде, "lint" — по имени script.
    expect(classified.lint[0]?.name).toBe("check");
    expect(classified.lint[0]?.matchedBy).toBe("command");
    expect(classified.lint[1]?.name).toBe("lint");
    expect(classified.lint[1]?.matchedBy).toBe("name");
  });

  it("redacts secret query parameters before generic assignment matching", () => {
    expect(redactCommand("curl https://host/x?token=abcdef123456&x=1")).toBe(
      "curl https://host/x?token=<redacted>&x=1",
    );
    expect(redactCommand("curl 'https://host/path?api_key=abc123&access_key=zzz999'")).toBe(
      "curl 'https://host/path?api_key=<redacted>&access_key=<redacted>'",
    );
    expect(redactCommand("curl 'https://host/x?secret=s3cr3t&password=pw'")).toBe(
      "curl 'https://host/x?secret=<redacted>&password=<redacted>'",
    );
    // Не-секретный query-параметр не редактируется.
    expect(redactCommand("curl 'https://host/x?page=2'")).toBe("curl 'https://host/x?page=2'");
  });

  it("redacts any query or fragment parameter whose name has a secret segment", () => {
    expect(redactCommand("curl https://h/x?client_secret=abcdef123")).toBe(
      "curl https://h/x?client_secret=<redacted>",
    );
    expect(redactCommand("curl https://h/x?refresh_token=abcdef123")).toBe(
      "curl https://h/x?refresh_token=<redacted>",
    );
    expect(redactCommand("curl https://h/x?id_token=abcdef123")).toBe(
      "curl https://h/x?id_token=<redacted>",
    );
    expect(redactCommand("curl https://h/x?x-api-key=abcdef123")).toBe(
      "curl https://h/x?x-api-key=<redacted>",
    );
    // auth_token редактируется и первым параметром, и после `&`.
    expect(redactCommand("curl https://h/x?auth_token=abcdef123")).toBe(
      "curl https://h/x?auth_token=<redacted>",
    );
    expect(redactCommand("curl https://h/x?a=1&auth_token=abcdef123")).toBe(
      "curl https://h/x?a=1&auth_token=<redacted>",
    );
    // Fragment и uppercase: имя параметра проверяется без учёта регистра.
    expect(redactCommand("curl https://h/x#access_token=abcdef123")).toBe(
      "curl https://h/x#access_token=<redacted>",
    );
    expect(redactCommand("curl https://h/x?SECRET=abcdef123")).toBe(
      "curl https://h/x?SECRET=<redacted>",
    );
    // Percent-encoding не мешает определить границу значения.
    expect(redactCommand("curl 'https://h/x?token=abc%20def'")).toBe(
      "curl 'https://h/x?token=<redacted>'",
    );
    // Несекретные параметры (включая содержащие "key") не редактируются.
    expect(redactCommand("curl 'https://h/x?page=2&per_page=10&key=abc'")).toBe(
      "curl 'https://h/x?page=2&per_page=10&key=abc'",
    );
  });

  it("redacts quoted secret query values including the quotes", () => {
    expect(redactCommand('curl https://h/x?token="abc123"')).toBe(
      "curl https://h/x?token=<redacted>",
    );
    expect(redactCommand("curl https://h/x?token='abcdef'")).toBe(
      "curl https://h/x?token=<redacted>",
    );
    // Mixed-quote value не должен оставлять хвост после кавычки.
    expect(redactCommand("curl https://h/x?token=abc'def")).toBe(
      "curl https://h/x?token=<redacted>",
    );
    expect(redactCommand('curl "https://h/x?token=abc123&y=2"')).toBe(
      'curl "https://h/x?token=<redacted>&y=2"',
    );
  });

  it("redacts escaped quotes inside quoted secret query values", () => {
    // R-3: escaped quote внутри quoted value не должен обрывать значение.
    expect(redactCommand('curl https://h/x?token="abc\\"def"')).toBe(
      "curl https://h/x?token=<redacted>",
    );
    expect(redactCommand("curl https://h/x?token='abc\\'def'")).toBe(
      "curl https://h/x?token=<redacted>",
    );
    const redacted = redactCommand('curl https://h/x?token="abc\\"def"');
    expect(redacted).not.toContain("def");
  });

  it("redacts concatenated quoted and unquoted shell segments of secret values", () => {
    // Low (WORK 3a recheck): ordered quoted alternative матчил только `"abc"`,
    // а unquoted `def` оставался в команде. Значение параметра — конкатенация
    // shell-сегментов слова, поэтому редактируется целиком.
    expect(redactCommand('curl https://h/x?token="abc"def')).toBe(
      "curl https://h/x?token=<redacted>",
    );
    expect(redactCommand("curl https://h/x?token='abc'def")).toBe(
      "curl https://h/x?token=<redacted>",
    );
    expect(redactCommand('curl https://h/x?token=abc"def"')).toBe(
      "curl https://h/x?token=<redacted>",
    );
    // Quoted-сегмент с пробелом после unquoted-префикса тоже не оставляет хвост.
    expect(redactCommand('curl https://h/x?token=abc"def ghi"')).toBe(
      "curl https://h/x?token=<redacted>",
    );
    // Host и исходное имя параметра сохраняются.
    const mixed = redactCommand('curl https://h/x?token="abc"def');
    expect(mixed).toContain("curl https://h/x?token=");
    expect(mixed).not.toContain("def");
  });

  it("redacts secret query values continued with escaped newlines", () => {
    // Escaped newline (shell line continuation) не должен оставлять хвост.
    const quoted = 'curl https://h/x?token="abc\\\ndef"';
    expect(redactCommand(quoted)).toBe("curl https://h/x?token=<redacted>");
    expect(redactCommand(quoted)).not.toContain("def");
    const unquoted = "curl https://h/x?token=abc\\\ndef";
    expect(redactCommand(unquoted)).toBe("curl https://h/x?token=<redacted>");
    // CRLF-континуация (Windows-файлы) и незакрытая кавычка после неё.
    const quotedCrlf = 'curl https://h/x?token="abc\\\r\ndef';
    expect(redactCommand(quotedCrlf)).toBe("curl https://h/x?token=<redacted>");
    const unquotedCrlf = "curl https://h/x?token=abc\\\r\ndef";
    expect(redactCommand(unquotedCrlf)).toBe("curl https://h/x?token=<redacted>");
  });

  it("keeps quoted secret query values that start with a quote intact", () => {
    // Positive-контроль: значения, начинающиеся с кавычки, и завершающая
    // shell-кавычка URL не должны ломаться при сборке shell-сегментов.
    expect(redactCommand('curl https://h/x?token="abc 123"')).toBe(
      "curl https://h/x?token=<redacted>",
    );
    expect(redactCommand('curl "https://h/x?token=abc" "https://h/y?page=2"')).toBe(
      'curl "https://h/x?token=<redacted>" "https://h/y?page=2"',
    );
    expect(redactCommand("curl 'https://h/x?token=abc' 'https://h/y?page=2'")).toBe(
      "curl 'https://h/x?token=<redacted>' 'https://h/y?page=2'",
    );
  });

  it("redacts percent-encoded secret query parameter names", () => {
    // R-1: ключ декодируется перед проверкой сегмента, исходное имя не меняется.
    expect(redactCommand("curl https://h/x?auth%5Ftoken=abcdef123")).toBe(
      "curl https://h/x?auth%5Ftoken=<redacted>",
    );
    expect(redactCommand("curl https://h/x?client%5Fsecret=abcdef123")).toBe(
      "curl https://h/x?client%5Fsecret=<redacted>",
    );
    expect(redactCommand("curl https://h/x?%74oken=abcdef123")).toBe(
      "curl https://h/x?%74oken=<redacted>",
    );
    expect(redactCommand("curl https://h/x?x%2Dapi%2Dkey=abcdef123")).toBe(
      "curl https://h/x?x%2Dapi%2Dkey=<redacted>",
    );
    // Malformed percent-encoding не роняет редактирование.
    expect(redactCommand("curl https://h/x?tok%en=abcdef123")).toBe(
      "curl https://h/x?tok%en=abcdef123",
    );
  });

  it("redacts bounded double-encoded secret query parameter names", () => {
    // Low (WORK 3a recheck): имя декодировалось один раз, поэтому двойное
    // кодирование (`%2574oken`) скрывало секретный сегмент. Декодирование
    // ограничено тремя проходами, исходное имя в команде не меняется.
    expect(redactCommand("curl https://h/x?%2574oken=abcdef123")).toBe(
      "curl https://h/x?%2574oken=<redacted>",
    );
    expect(redactCommand("curl https://h/x?auth%255Ftoken=abcdef123")).toBe(
      "curl https://h/x?auth%255Ftoken=<redacted>",
    );
    expect(redactCommand("curl https://h/x?x%252Dapi%252Dkey=abcdef123")).toBe(
      "curl https://h/x?x%252Dapi%252Dkey=<redacted>",
    );
    // Граница bound: два дополнительных `%25`-слоя закрываются, три — нет.
    expect(redactCommand("curl https://h/x?%252574oken=abcdef123")).toBe(
      "curl https://h/x?%252574oken=<redacted>",
    );
    expect(redactCommand("curl https://h/x?%25252574oken=abcdef123")).toBe(
      "curl https://h/x?%25252574oken=abcdef123",
    );
    // Malformed percent на любом проходе не роняет и не даёт false-positive.
    expect(redactCommand("curl https://h/x?tok%25en=abcdef123")).toBe(
      "curl https://h/x?tok%25en=abcdef123",
    );
    expect(redactCommand("curl https://h/x?page%2520=2")).toBe("curl https://h/x?page%2520=2");
  });

  it("redacts secret parameters nested in query and assignment values", () => {
    // R-2: вложенный `?` и `=` не должны скрывать секретный параметр.
    expect(redactCommand("curl https://h/y?next=https://h/z?token=abcdef123")).toBe(
      "curl https://h/y?next=https://h/z?token=<redacted>",
    );
    expect(redactCommand("curl https://h/y?foo=token=abcdef123")).toBe(
      "curl https://h/y?foo=token=<redacted>",
    );
    expect(redactCommand("curl https://h/y?foo=client_secret=abcdef123")).toBe(
      "curl https://h/y?foo=client_secret=<redacted>",
    );
  });

  it("redacts bare Authorization values without an auth scheme", () => {
    expect(redactCommand("curl -H 'Authorization: abcdef123456'")).toBe(
      "curl -H 'Authorization: <redacted>'",
    );
    expect(redactCommand("curl -H 'Authorization: ghp_1234567890abcdef'")).toBe(
      "curl -H 'Authorization: <redacted>'",
    );
    // Схемы без токена по-прежнему не редактируются.
    expect(redactCommand("Authorization: Bearer")).toBe("Authorization: Bearer");
    expect(redactCommand("curl -H 'Authorization: Basic'")).toBe("curl -H 'Authorization: Basic'");
  });

  it("redacts prefixed provider tokens even without a secret key", () => {
    // Полные провайдерские токены собираются в рантайме: privacy-скан
    // (scripts/check-tracked-privacy.mjs) не должен видеть их литералами.
    const awsKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const slackToken = ["xoxb", "1234567890", "abcdef"].join("-");
    expect(redactCommand("OPENAI_KEY=sk-abcdef1234567890")).toBe("OPENAI_KEY=<redacted>");
    expect(redactCommand("node deploy.js sk-abcdef1234567890")).toBe("node deploy.js <redacted>");
    expect(redactCommand("echo ghp_1234567890abcdef")).toBe("echo <redacted>");
    expect(redactCommand("echo glpat-abcdef1234567890")).toBe("echo <redacted>");
    expect(redactCommand(`echo ${awsKey}`)).toBe("echo <redacted>");
    expect(redactCommand(`echo ${slackToken}`)).toBe("echo <redacted>");
  });

  it("does not redact provider prefixes embedded in ordinary identifiers", () => {
    // Negative lookbehind: `sk-` внутри имени пакета/задачи не является токеном.
    expect(redactCommand("npm run app-sk-production")).toBe("npm run app-sk-production");
    expect(redactCommand("echo task-sk-rebuild-2024")).toBe("echo task-sk-rebuild-2024");
    // Позитивные случаи сохраняются.
    expect(redactCommand("OPENAI_KEY=sk-abcdef1234567890")).toBe("OPENAI_KEY=<redacted>");
    expect(redactCommand("echo ghp_1234567890abcdef")).toBe("echo <redacted>");
  });

  it("redacts PEM private key blocks and headers", () => {
    // PEM-маркеры собираются в рантайме по той же причине, что и токены выше.
    const pemBegin = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ");
    const pemEnd = ["-----END", "RSA PRIVATE KEY-----"].join(" ");
    const pem = [pemBegin, "MIIEowIBAAKCAQEA1234567890", pemEnd].join("\n");
    const redactedBlock = redactCommand(`cat <<EOF\n${pem}\nEOF`);
    expect(redactedBlock).not.toContain("MIIEow");
    expect(redactedBlock).toContain("<redacted>");
    expect(redactCommand(`echo ${pemBegin} && rm -rf /tmp/x`)).not.toContain(
      "BEGIN RSA PRIVATE KEY",
    );
  });

  it("redacts secret-like assignments, bearer tokens and URL credentials", () => {
    expect(redactCommand("TOKEN=abc npm test")).toBe("TOKEN=<redacted> npm test");
    expect(redactCommand("curl -H 'Authorization: Bearer abcdefgh12345678'")).toContain(
      "Bearer <redacted>",
    );
    expect(redactCommand("curl https://user:pass@example.com")).toBe(
      "curl https://<redacted>@example.com",
    );
  });

  it("does not treat Authorization scheme headers as secret assignments", () => {
    // Regression: подстрочный AUTH в слове Authorization не должен редактироваться.
    expect(redactCommand("Authorization: Bearer")).toBe("Authorization: Bearer");
    expect(redactCommand("curl -H 'Authorization: Basic'")).toBe("curl -H 'Authorization: Basic'");
    expect(redactCommand("node authorize.js")).toBe("node authorize.js");
    expect(redactCommand("echo 'authorization header is optional'")).toBe(
      "echo 'authorization header is optional'",
    );
  });

  it("still redacts bearer/basic tokens and real token, password and key assignments", () => {
    const token = "abcdefgh12345678";
    const bearer = redactCommand(
      `curl -H 'Authorization: Bearer ${token}' https://api.example.com`,
    );
    expect(bearer).toContain("Authorization: Bearer <redacted>");
    expect(bearer).not.toContain(token);

    const basic = redactCommand("curl -H 'Authorization: Basic dXNlcjpwYXNz'");
    expect(basic).toContain("Authorization: Basic <redacted>");
    expect(basic).not.toContain("dXNlcjpwYXNz");

    expect(redactCommand("GITHUB_TOKEN=ghp_1234567890")).toBe("GITHUB_TOKEN=<redacted>");
    expect(redactCommand("DB_PASSWORD: hunter2")).toBe("DB_PASSWORD: <redacted>");
    expect(redactCommand("PRIVATE_KEY='abc def'")).toBe("PRIVATE_KEY=<redacted>");
    expect(redactCommand("API_KEY=sk-live")).toBe("API_KEY=<redacted>");
  });

  it("does not import process execution or read process.env", async () => {
    const source = await readFileFromDisk(
      new URL("../src/context/workspace-facts.ts", import.meta.url),
      "utf8",
    );
    const cacheSource = await readFileFromDisk(
      new URL("../src/context/workspace-facts-cache.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("node:child_process");
    expect(cacheSource).not.toContain("node:child_process");
    expect(source).not.toContain("process.env");
    expect(cacheSource).not.toContain("process.env");
  });
});

describe("workspace facts filesystem containment", () => {
  it.skipIf(process.platform === "win32")(
    "rejects real symlinks that escape the project root",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-workspace-facts-contain-"));
      const project = join(root, "project");
      const outside = join(root, "outside");
      try {
        await mkdir(project, { recursive: true });
        await mkdir(outside, { recursive: true });
        await writeFile(join(outside, "node-version"), "99.99.99\n");
        await symlink(join(outside, "node-version"), join(project, ".nvmrc"));

        const probe = await probeWorkspaceInputs(project, nodeWorkspaceFactsIo);
        const nvmrc = probe.files.find((file) => file.path === ".nvmrc");
        expect(nvmrc).toMatchObject({ exists: false, size: -1 });
        const snapshot = await fingerprintWorkspaceInputs(project, probe, nodeWorkspaceFactsIo);
        expect(snapshot.text.has(".nvmrc")).toBe(false);

        // .git — symlink на каталог вне projectRoot: git-факты не читаются.
        const outsideGit = join(outside, "git");
        await mkdir(outsideGit, { recursive: true });
        await writeFile(join(outsideGit, "HEAD"), `${HEAD_SHA}\n`);
        await symlink(outsideGit, join(project, ".git"));
        await expect(resolveGitMetadata(project, nodeWorkspaceFactsIo)).resolves.toEqual({});
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects real-FS gitdir and commondir escapes without reading outside paths",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-workspace-facts-gitdir-"));
      const outsideGit = join(root, "outside-git");
      const reads: string[] = [];
      const countingIo: WorkspaceFactsIo = {
        ...nodeWorkspaceFactsIo,
        readFile: async (filePath) => {
          reads.push(filePath);
          return nodeWorkspaceFactsIo.readFile(filePath);
        },
      };
      try {
        await mkdir(outsideGit, { recursive: true });
        await writeFile(join(outsideGit, "HEAD"), `${HEAD_SHA}\n`);
        await mkdir(join(outsideGit, "refs", "heads"), { recursive: true });
        await writeFile(join(outsideGit, "refs", "heads", "main"), `${HEAD_SHA}\n`);

        // .git-файл с абсолютным gitdir: за пределы projectRoot не читаем.
        const gitdirProject = join(root, "gitdir-project");
        await mkdir(gitdirProject, { recursive: true });
        await writeFile(join(gitdirProject, ".git"), `gitdir: ${outsideGit}\n`);
        reads.length = 0;
        await expect(resolveGitMetadata(gitdirProject, countingIo)).resolves.toEqual({});
        expect(reads.filter((filePath) => filePath.startsWith(outsideGit))).toEqual([]);
        await expectReadsInsideRealRoot(gitdirProject, reads);

        // commondir указывает на символьную ссылку внутри projectRoot, чей realpath
        // лежит вне дерева: canonical containment обязан отвергнуть её.
        const commonProject = join(root, "common-project");
        await mkdir(join(commonProject, ".git"), { recursive: true });
        await writeFile(join(commonProject, ".git", "HEAD"), "ref: refs/heads/main\n");
        await writeFile(join(commonProject, ".git", "commondir"), "../linked\n");
        await symlink(outsideGit, join(commonProject, "linked"));
        reads.length = 0;
        await expect(resolveGitMetadata(commonProject, countingIo)).resolves.toEqual({
          head: "ref:refs/heads/main",
        });
        expect(reads.filter((filePath) => filePath.startsWith(outsideGit))).toEqual([]);
        await expectReadsInsideRealRoot(commonProject, reads);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe("NodeContextSourceAdapter workspace facts integration", () => {
  it("creates cache on miss, serves a hit without fact re-reads and keys remote separately", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-workspace-facts-"));
    const project = join(root, "project");
    const home = join(root, "home");
    const cacheRoot = join(home, ".zcode", "v2", "cache", "workspace-facts");
    try {
      await mkdir(join(project, ".git", "refs", "heads"), { recursive: true });
      await writeFile(join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
      await writeFile(join(project, ".git", "refs", "heads", "main"), `${HEAD_SHA}\n`);
      await writeFile(join(project, ".git", "index"), "index");
      await writeFile(
        join(project, "package.json"),
        JSON.stringify({
          name: "integration-fixture",
          packageManager: "pnpm@9.15.0",
          scripts: { test: "vitest run", lint: "eslint .", build: "vite build" },
        }),
      );
      await writeFile(join(project, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
      await writeFile(join(project, "tsconfig.json"), '{"compilerOptions":{"strict":true}}\n');
      await writeFile(join(project, "vitest.config.ts"), "export default {}\n");

      const reads: string[] = [];
      const countingIo: WorkspaceFactsIo = {
        ...nodeWorkspaceFactsIo,
        readFile: async (filePath) => {
          reads.push(filePath);
          return nodeWorkspaceFactsIo.readFile(filePath);
        },
      };
      const adapter = new NodeContextSourceAdapter({
        env: { HOME: home },
        bundledHarnessRulesDirectory: join(root, "missing-rules"),
        workspaceFactsIo: countingIo,
        now: () => NOW,
      });
      const request = {
        workingDirectory: project,
        envInfo: {
          cwd: project,
          platform: "linux",
          shell: "bash",
          osVersion: "linux",
          nodeVersion: "v22.23.5",
          isGitRepository: true,
          gitBranch: "main",
          gitStatus: "clean" as const,
          gitStatusLines: [] as string[],
        },
      };

      const first = await adapter.resolveContextSources(request);
      // Метрика: miss читает только существующие файлы-факты (4), hit — 0.
      expect(factReads(reads).length).toBe(4);
      expect(first.projectContext?.workspaceFacts?.classifiedScripts.test[0]?.name).toBe("test");
      expect(first.projectContext?.workspaceFacts?.provenance.gitHead).toBe(HEAD_SHA);

      reads.length = 0;
      const second = await adapter.resolveContextSources(request);
      expect(factReads(reads)).toEqual([]);
      expect(second.projectContext?.workspaceFacts?.provenance.computedAt).toBe(
        first.projectContext?.workspaceFacts?.provenance.computedAt,
      );

      expect((await readdir(cacheRoot)).length).toBe(1);

      // identity key = workspaceIdentity?.trim() || workspacePath: пустая строка
      // с пробелами падает обратно на workspacePath и попадает в тот же entry.
      reads.length = 0;
      await adapter.resolveContextSources({
        ...request,
        workspaceIdentity: "   ",
        workspacePath: project,
      });
      expect(factReads(reads)).toEqual([]);
      expect((await readdir(cacheRoot)).length).toBe(1);

      reads.length = 0;
      await adapter.resolveContextSources({
        ...request,
        workspaceIdentity: "remote:server-1:/project",
      });
      expect((await readdir(cacheRoot)).length).toBe(2);
      // Remote identity — отдельный ключ, поэтому данные не переиспользуются:
      // новый entry считается заново и перечитывает файлы-факты.
      expect(factReads(reads).length).toBe(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
