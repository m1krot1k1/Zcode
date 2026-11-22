// ============================================================
// Skill catalog metadata cache - focused regression tests
// ============================================================
// Покрывает docs/specs/skill-catalog-cache.md (CLI runtime часть):
// warm discover без чтений SKILL.md, инвалидация по mtime/size, prune,
// LRU, single-flight, ленивое чтение body в loadSkill, maxBytes,
// защиту кеша от мутации caller-ом и root-derived поля вне кеша.

import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SkillRoot } from "@zcode/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeSkillAdapter } from "../src/skills/index.js";

// Счётчики вызовов fs: каталог кеширует только метаданные, поэтому читать
// SKILL.md повторно можно утверждать только по фактическим вызовам readFile/open.
const fsCalls = vi.hoisted(() => ({
  readFile: [] as string[],
  open: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: ((...args: Parameters<typeof actual.readFile>) => {
      fsCalls.readFile.push(String(args[0]));
      return actual.readFile(...args);
    }) as typeof actual.readFile,
    open: ((...args: Parameters<typeof actual.open>) => {
      fsCalls.open.push(String(args[0]));
      return actual.open(...args);
    }) as typeof actual.open,
  };
});

const isSkillFilePath = (path: string): boolean => path.endsWith("SKILL.md");
const skillBodyReads = (path?: string): number =>
  fsCalls.readFile.filter(
    (candidate) => isSkillFilePath(candidate) && (path === undefined || candidate === path),
  ).length;
const skillOpenCalls = (path?: string): number =>
  fsCalls.open.filter(
    (candidate) => isSkillFilePath(candidate) && (path === undefined || candidate === path),
  ).length;

function resetFsCalls(): void {
  fsCalls.readFile.length = 0;
  fsCalls.open.length = 0;
}

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-skill-catalog-cache-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  resetFsCalls();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function skillRoot(path: string, overrides: Partial<SkillRoot> = {}): SkillRoot {
  return {
    path,
    scope: "project",
    source: "zcode",
    priority: 0,
    ...overrides,
  };
}

interface WrittenSkill {
  path: string;
  content: string;
}

async function writeSkill(
  rootPath: string,
  name: string,
  options: { description?: string; body?: string; extraFrontmatter?: string } = {},
): Promise<WrittenSkill> {
  const description = options.description ?? `${name} description`;
  const body = options.body ?? `${name}-body`;
  const skillDir = join(rootPath, name);
  await mkdir(skillDir, { recursive: true });
  const content = [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    ...(options.extraFrontmatter ? [options.extraFrontmatter] : []),
    "---",
    body,
  ].join("\n");
  const path = join(skillDir, "SKILL.md");
  await writeFile(path, content, "utf8");
  return { path, content };
}

describe("NodeSkillAdapter catalog cache", () => {
  it("warm discovery returns the same catalog without reading SKILL.md", async () => {
    const dir = await makeTempDir();
    const rootPath = join(dir, "skills");
    await writeSkill(rootPath, "alpha");
    await writeSkill(rootPath, "beta");
    const adapter = createNodeSkillAdapter({ homeDirectory: join(dir, "home") });
    const roots = [skillRoot(rootPath)];

    resetFsCalls();
    const cold = await adapter.discoverSkills({ workingDirectory: dir, roots });
    // Метрика cold: ровно одно чтение файла на skill.
    expect(skillBodyReads()).toBe(2);
    expect(skillOpenCalls()).toBe(0);
    expect(cold.skills.map((skill) => skill.name)).toEqual(["alpha", "beta"]);

    resetFsCalls();
    const warm = await adapter.discoverSkills({ workingDirectory: dir, roots });
    // Метрика warm: 0 чтений SKILL.md, ни через readFile, ни через open.
    expect(skillBodyReads()).toBe(0);
    expect(skillOpenCalls()).toBe(0);
    expect(warm.skills).toEqual(cold.skills);
    expect(warm.diagnostics).toEqual(cold.diagnostics);
  });

  it("re-reads only the file whose size or mtime changed", async () => {
    const dir = await makeTempDir();
    const rootPath = join(dir, "skills");
    const alpha = await writeSkill(rootPath, "alpha");
    const beta = await writeSkill(rootPath, "beta");
    const adapter = createNodeSkillAdapter({ homeDirectory: join(dir, "home") });
    const roots = [skillRoot(rootPath)];

    await adapter.discoverSkills({ workingDirectory: dir, roots });

    resetFsCalls();
    await writeFile(
      alpha.path,
      alpha.content.replace("alpha description", "alpha description changed"),
      "utf8",
    );
    const afterSizeChange = await adapter.discoverSkills({ workingDirectory: dir, roots });
    expect(skillBodyReads(alpha.path)).toBe(1);
    expect(skillBodyReads(beta.path)).toBe(0);
    expect(afterSizeChange.skills.find((skill) => skill.name === "alpha")?.description).toBe(
      "alpha description changed",
    );

    resetFsCalls();
    // Меняем только mtime: размер и содержимое остаются прежними.
    const bumped = new Date(Date.now() + 10_000);
    await utimes(beta.path, bumped, bumped);
    const afterMtimeChange = await adapter.discoverSkills({ workingDirectory: dir, roots });
    expect(skillBodyReads(beta.path)).toBe(1);
    expect(skillBodyReads(alpha.path)).toBe(0);
    expect(afterMtimeChange.skills.map((skill) => skill.name)).toEqual(["alpha", "beta"]);
  });

  it("reads only the new file and drops deleted skills without reads", async () => {
    const dir = await makeTempDir();
    const rootPath = join(dir, "skills");
    const alpha = await writeSkill(rootPath, "alpha");
    const adapter = createNodeSkillAdapter({ homeDirectory: join(dir, "home") });
    const roots = [skillRoot(rootPath)];

    await adapter.discoverSkills({ workingDirectory: dir, roots });

    resetFsCalls();
    const beta = await writeSkill(rootPath, "beta");
    const withBeta = await adapter.discoverSkills({ workingDirectory: dir, roots });
    expect(skillBodyReads(beta.path)).toBe(1);
    expect(skillBodyReads(alpha.path)).toBe(0);
    expect(withBeta.skills.map((skill) => skill.name)).toEqual(["alpha", "beta"]);

    resetFsCalls();
    await rm(dirname(beta.path), { recursive: true, force: true });
    const withoutBeta = await adapter.discoverSkills({ workingDirectory: dir, roots });
    expect(skillBodyReads()).toBe(0);
    expect(withoutBeta.skills.map((skill) => skill.name)).toEqual(["alpha"]);
  });

  it("re-reads a recreated skill with the restored stamp (prune removed the entry)", async () => {
    const dir = await makeTempDir();
    const rootPath = join(dir, "skills");
    const alpha = await writeSkill(rootPath, "alpha");
    const adapter = createNodeSkillAdapter({ homeDirectory: join(dir, "home") });
    const roots = [skillRoot(rootPath)];

    // Фиксируем stamp с точностью до секунды: и до удаления, и после восстановления
    // выставляем одну и ту же дату, чтобы utimes не оставлял дрейф в долях мс.
    const stampDate = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    await utimes(alpha.path, stampDate, stampDate);
    await adapter.discoverSkills({ workingDirectory: dir, roots });
    const original = await stat(alpha.path);

    await rm(dirname(alpha.path), { recursive: true, force: true });
    resetFsCalls();
    const pruned = await adapter.discoverSkills({ workingDirectory: dir, roots });
    expect(skillBodyReads()).toBe(0);
    expect(pruned.skills).toEqual([]);

    await writeSkill(rootPath, "alpha");
    await utimes(alpha.path, stampDate, stampDate);
    const restored = await stat(alpha.path);
    // Предпосылка сценария: stamp восстановлен, значит повторное чтение может
    // произойти только из-за реального удаления записи prune-ом, а не из-за mtime.
    expect(restored.size).toBe(original.size);
    expect(restored.mtimeMs).toBe(original.mtimeMs);

    resetFsCalls();
    const warm = await adapter.discoverSkills({ workingDirectory: dir, roots });
    expect(skillBodyReads(alpha.path)).toBe(1);
    expect(warm.skills.map((skill) => skill.name)).toEqual(["alpha"]);
  });

  it("evicts the least recently used entry when the catalog limit is reached", async () => {
    const dir = await makeTempDir();
    const rootA = join(dir, "skills-a");
    const rootB = join(dir, "skills-b");
    const alpha = await writeSkill(rootA, "alpha");
    const beta = await writeSkill(rootB, "beta");
    const adapter = createNodeSkillAdapter({
      homeDirectory: join(dir, "home"),
      catalogCacheMaxEntries: 1,
    });
    // Discovery по подмножеству корней, чтобы лимит 1 не переполнялся внутри одного
    // прохода: каждая запись вытесняется следующей discovery-операцией.
    const rootsA = [skillRoot(rootA, { priority: 0 })];
    const rootsB = [skillRoot(rootB, { priority: 0 })];

    await adapter.discoverSkills({ workingDirectory: dir, roots: rootsA });
    await adapter.discoverSkills({ workingDirectory: dir, roots: rootsB });

    resetFsCalls();
    await adapter.discoverSkills({ workingDirectory: dir, roots: rootsA });
    expect(skillBodyReads(alpha.path)).toBe(1);
    expect(skillBodyReads(beta.path)).toBe(0);

    resetFsCalls();
    await adapter.discoverSkills({ workingDirectory: dir, roots: rootsB });
    expect(skillBodyReads(beta.path)).toBe(1);
    expect(skillBodyReads(alpha.path)).toBe(0);
  });

  it("single-flights concurrent discoveries on one adapter", async () => {
    const dir = await makeTempDir();
    const rootPath = join(dir, "skills");
    const alpha = await writeSkill(rootPath, "alpha");
    const beta = await writeSkill(rootPath, "beta");
    const adapter = createNodeSkillAdapter({ homeDirectory: join(dir, "home") });
    const roots = [skillRoot(rootPath)];

    resetFsCalls();
    const [first, second] = await Promise.all([
      adapter.discoverSkills({ workingDirectory: dir, roots }),
      adapter.discoverSkills({ workingDirectory: dir, roots }),
    ]);

    expect(skillBodyReads(alpha.path)).toBe(1);
    expect(skillBodyReads(beta.path)).toBe(1);
    expect(first.skills).toEqual(second.skills);
  });

  it("loadSkill reads the body only when called and never serves it from cache", async () => {
    const dir = await makeTempDir();
    const rootPath = join(dir, "skills");
    const alpha = await writeSkill(rootPath, "alpha");
    const adapter = createNodeSkillAdapter({ homeDirectory: join(dir, "home") });
    const roots = [skillRoot(rootPath)];

    await adapter.discoverSkills({ workingDirectory: dir, roots });

    resetFsCalls();
    const firstLoad = await adapter.loadSkill({ name: "alpha", workingDirectory: dir, roots });
    // Внутренний discover — cache hit, ровно одно чтение тела.
    expect(skillBodyReads(alpha.path)).toBe(1);
    expect(firstLoad.content).toBe("alpha-body");
    expect(firstLoad.truncated).toBe(false);
    expect(firstLoad.bytesRead).toBe(Buffer.byteLength(alpha.content));

    resetFsCalls();
    const secondLoad = await adapter.loadSkill({ name: "alpha", workingDirectory: dir, roots });
    expect(skillBodyReads(alpha.path)).toBe(1);
    expect(secondLoad.content).toBe("alpha-body");
  });

  it("applies maxBytes via a ranged open without reading the whole file", async () => {
    const dir = await makeTempDir();
    const rootPath = join(dir, "skills");
    const skillDir = join(rootPath, "plain-skill");
    await mkdir(skillDir, { recursive: true });
    const path = join(skillDir, "SKILL.md");
    await writeFile(path, "0123456789abcdefghij", "utf8");
    const adapter = createNodeSkillAdapter({ homeDirectory: join(dir, "home") });
    const roots = [skillRoot(rootPath)];

    const outcome = await adapter.discoverSkills({ workingDirectory: dir, roots });
    expect(outcome.skills.map((skill) => skill.name)).toEqual(["plain-skill"]);

    resetFsCalls();
    const loaded = await adapter.loadSkill({
      name: "plain-skill",
      workingDirectory: dir,
      roots,
      maxBytes: 5,
    });
    expect(skillOpenCalls(path)).toBe(1);
    expect(skillBodyReads(path)).toBe(0);
    expect(loaded.content).toBe("01234");
    expect(loaded.bytesRead).toBe(5);
    expect(loaded.sizeBytes).toBe(20);
    expect(loaded.truncated).toBe(true);
  });

  it("does not let callers mutate cached frontmatterKeys", async () => {
    const dir = await makeTempDir();
    const rootPath = join(dir, "skills");
    await writeSkill(rootPath, "alpha", { extraFrontmatter: "license: MIT" });
    const adapter = createNodeSkillAdapter({ homeDirectory: join(dir, "home") });
    const roots = [skillRoot(rootPath)];

    const cold = await adapter.discoverSkills({ workingDirectory: dir, roots });
    const coldKeys = [...cold.skills[0]!.frontmatterKeys];
    expect(coldKeys).toEqual(["name", "description", "license"]);
    cold.skills[0]!.frontmatterKeys.push("evil");
    cold.skills[0]!.frontmatterKeys[0] = "tampered";

    resetFsCalls();
    const warm = await adapter.discoverSkills({ workingDirectory: dir, roots });
    expect(skillBodyReads()).toBe(0);
    expect(warm.skills[0]?.frontmatterKeys).toEqual(["name", "description", "license"]);
  });

  it("replays parse diagnostics on cache hit without reading the file", async () => {
    const dir = await makeTempDir();
    const rootPath = join(dir, "skills");
    const skillDir = join(rootPath, "broken-skill");
    await mkdir(skillDir, { recursive: true });
    // Нет description: файл валидный по имени, но не проходит metadata-валидацию.
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: broken-skill\n---\n", "utf8");
    const adapter = createNodeSkillAdapter({ homeDirectory: join(dir, "home") });
    const roots = [skillRoot(rootPath)];

    const cold = await adapter.discoverSkills({ workingDirectory: dir, roots });
    expect(cold.skills).toEqual([]);
    expect(cold.diagnostics).toHaveLength(1);
    expect(cold.diagnostics[0]).toMatchObject({
      code: "skill_missing_description",
      severity: "error",
      skillName: "broken-skill",
    });
    const originalMessage = cold.diagnostics[0]!.message;
    cold.diagnostics[0]!.message = "tampered";
    cold.diagnostics.push({
      code: "skill_read_failed",
      severity: "warning",
      message: "fake",
      path: "fake",
    });

    resetFsCalls();
    const warm = await adapter.discoverSkills({ workingDirectory: dir, roots });
    expect(skillBodyReads()).toBe(0);
    expect(warm.diagnostics).toHaveLength(1);
    expect(warm.diagnostics[0]).toMatchObject({
      code: "skill_missing_description",
      skillName: "broken-skill",
      message: originalMessage,
    });
  });

  it("keeps root-derived fields out of the cache", async () => {
    const dir = await makeTempDir();
    const rootPath = join(dir, "skills");
    const alpha = await writeSkill(rootPath, "alpha");
    const adapter = createNodeSkillAdapter({ homeDirectory: join(dir, "home") });

    const first = await adapter.discoverSkills({
      workingDirectory: dir,
      roots: [skillRoot(rootPath, { scope: "user", namespace: "alpha-ns", priority: 0 })],
    });
    expect(first.skills[0]).toMatchObject({
      scope: "user",
      rootPath,
      qualifiedName: "alpha-ns/alpha",
    });

    resetFsCalls();
    const second = await adapter.discoverSkills({
      workingDirectory: dir,
      roots: [skillRoot(rootPath, { scope: "project", namespace: "beta-ns", priority: 0 })],
    });
    // Файл тот же — чтения нет, но поля корня обязаны быть актуальными.
    expect(skillBodyReads(alpha.path)).toBe(0);
    expect(second.skills[0]).toMatchObject({
      scope: "project",
      rootPath,
      qualifiedName: "beta-ns/alpha",
    });
  });

  it("resolves plugin alias per call instead of caching plugin state", async () => {
    const dir = await makeTempDir();
    const pluginRoot = join(dir, "superpowers");
    const skillsRoot = join(pluginRoot, "skills");
    const alpha = await writeSkill(skillsRoot, "alpha");
    await mkdir(join(pluginRoot, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(pluginRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "superpowers", version: "1.0.0" }),
      "utf8",
    );
    const adapter = createNodeSkillAdapter({ homeDirectory: join(dir, "home") });

    const asPlugin = await adapter.discoverSkills({
      workingDirectory: dir,
      roots: [skillRoot(skillsRoot, { scope: "system", source: "plugin", priority: 0 })],
    });
    expect(asPlugin.skills[0]).toMatchObject({
      pluginName: "superpowers",
      qualifiedName: "superpowers:alpha",
    });

    resetFsCalls();
    const asProject = await adapter.discoverSkills({
      workingDirectory: dir,
      roots: [skillRoot(skillsRoot, { scope: "project", source: "zcode", priority: 0 })],
    });
    expect(skillBodyReads(alpha.path)).toBe(0);
    expect(asProject.skills[0]?.pluginName).toBeUndefined();
    expect(asProject.skills[0]?.qualifiedName).toBeUndefined();
  });

  it("keeps disabledPaths filtering active on cache hits", async () => {
    const dir = await makeTempDir();
    const rootPath = join(dir, "skills");
    const alpha = await writeSkill(rootPath, "alpha");
    await writeSkill(rootPath, "beta");
    const adapter = createNodeSkillAdapter({
      homeDirectory: join(dir, "home"),
      disabledPaths: [alpha.path],
    });
    const roots = [skillRoot(rootPath)];

    const cold = await adapter.discoverSkills({ workingDirectory: dir, roots });
    expect(cold.skills.map((skill) => skill.name)).toEqual(["beta"]);

    resetFsCalls();
    const warm = await adapter.discoverSkills({ workingDirectory: dir, roots });
    expect(skillBodyReads()).toBe(0);
    expect(warm.skills.map((skill) => skill.name)).toEqual(["beta"]);
  });
});
