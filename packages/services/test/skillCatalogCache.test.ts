// ============================================================
// Host skills metadata cache - focused regression tests
// ============================================================
// Покрывает docs/specs/skill-catalog-cache.md (Host services часть):
// `_meta.json` кешируется по mtime/size, тело SKILL.md/enabled/plugin state
// читаются на каждый вызов, single-flight и LRU в createSkillMetadataCache.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillMetadata } from "@zcode/shared";
import type { ISkillsService } from "../src/skills/skills.js";
import { createSkillMetadataCache } from "../src/skills/service/skillMetadataCache.js";

const fsCalls = vi.hoisted(() => ({ readFile: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: ((...args: Parameters<typeof actual.readFile>) => {
      fsCalls.readFile.push(String(args[0]));
      return actual.readFile(...args);
    }) as typeof actual.readFile,
  };
});

const skillMdReads = (): string[] => fsCalls.readFile.filter((path) => path.endsWith("SKILL.md"));
const metaJsonReads = (): string[] =>
  fsCalls.readFile.filter((path) => path.endsWith("_meta.json"));

function resetFsCalls(): void {
  fsCalls.readFile.length = 0;
}

const originalHome = process.env.HOME;
const tempHomes: string[] = [];

function makeTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "zcode-skill-catalog-host-"));
  tempHomes.push(home);
  return home;
}

function writeSkillAtRoot(rootPath: string, folder: string, body: string): string {
  const skillDir = join(rootPath, folder);
  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  writeFileSync(
    skillPath,
    ["---", `name: ${folder}`, `description: ${folder} description`, "---", body].join("\n"),
    "utf-8",
  );
  return skillPath;
}

function writeSkill(workspacePath: string, folder: string, body: string): string {
  return writeSkillAtRoot(join(workspacePath, ".zcode", "skills"), folder, body);
}

function writeSkillMeta(workspacePath: string, folder: string, metadata: unknown): string {
  const metaPath = join(workspacePath, ".zcode", "skills", folder, "_meta.json");
  mkdirSync(dirname(metaPath), { recursive: true });
  writeFileSync(metaPath, JSON.stringify(metadata, null, 2), "utf-8");
  return metaPath;
}

function writeCliConfig(home: string, config: Record<string, unknown>): void {
  const configDir = join(home, ".zcode", "cli");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify(config, null, 2), "utf-8");
}

async function createServiceInEnv(home: string): Promise<ISkillsService> {
  process.env.HOME = home;
  vi.resetModules();
  const mod = await import("../src/skills/service/skillsService.js");
  return mod.createSkillsService({ isDesktopRuntime: true });
}

afterEach(() => {
  process.env.HOME = originalHome;
  vi.resetModules();
  resetFsCalls();
  while (tempHomes.length > 0) {
    const home = tempHomes.pop();
    if (home) rmSync(home, { recursive: true, force: true });
  }
});

describe("createSkillMetadataCache", () => {
  it("serves warm reads from memory and returns fresh copies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-meta-cache-unit-"));
    tempHomes.push(dir);
    writeFileSync(join(dir, "_meta.json"), JSON.stringify({ version: "1.0.0" }), "utf-8");
    const skillPath = join(dir, "SKILL.md");

    const readMetadata = vi.fn(async () => ({ version: "1.0.0" }));
    const cache = createSkillMetadataCache({ readMetadata });

    const first = await cache.read(skillPath);
    const second = await cache.read(skillPath);

    expect(readMetadata).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);

    // Мутация результата потребителем не должна менять кеш.
    (second as SkillMetadata).version = "tampered";
    expect(await cache.read(skillPath)).toEqual({ version: "1.0.0" });
  });

  it("invalidates the entry when _meta.json size changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-meta-cache-size-"));
    tempHomes.push(dir);
    const metaPath = join(dir, "_meta.json");
    writeFileSync(metaPath, JSON.stringify({ version: "1.0.0" }), "utf-8");
    const skillPath = join(dir, "SKILL.md");
    const cache = createSkillMetadataCache();

    expect(await cache.read(skillPath)).toEqual({ version: "1.0.0" });
    writeFileSync(metaPath, JSON.stringify({ version: "2.0.0" }), "utf-8");
    expect(await cache.read(skillPath)).toEqual({ version: "2.0.0" });
  });

  it("invalidates the entry when only _meta.json mtime changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-meta-cache-mtime-"));
    tempHomes.push(dir);
    writeFileSync(join(dir, "_meta.json"), JSON.stringify({ version: "1.0.0" }), "utf-8");
    const skillPath = join(dir, "SKILL.md");

    const readMetadata = vi.fn(async () => ({ version: "1.0.0" }));
    const cache = createSkillMetadataCache({ readMetadata });

    await cache.read(skillPath);
    await cache.read(skillPath);
    expect(readMetadata).toHaveBeenCalledTimes(1);

    const bumped = new Date(Date.now() + 10_000);
    utimesSync(join(dir, "_meta.json"), bumped, bumped);
    await cache.read(skillPath);
    expect(readMetadata).toHaveBeenCalledTimes(2);
  });

  it("does not cache a missing _meta.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-meta-cache-absent-"));
    tempHomes.push(dir);
    const skillPath = join(dir, "SKILL.md");
    const readMetadata = vi.fn(async () => ({ version: "1.0.0" }) as SkillMetadata);
    const cache = createSkillMetadataCache({ readMetadata });

    expect(await cache.read(skillPath)).toBeUndefined();
    expect(readMetadata).not.toHaveBeenCalled();

    writeFileSync(join(dir, "_meta.json"), JSON.stringify({ version: "1.0.0" }), "utf-8");
    expect(await cache.read(skillPath)).toEqual({ version: "1.0.0" });
    expect(readMetadata).toHaveBeenCalledTimes(1);
  });

  it("evicts the least recently used entry at the configured limit", async () => {
    const dirA = mkdtempSync(join(tmpdir(), "zcode-meta-cache-lru-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "zcode-meta-cache-lru-b-"));
    tempHomes.push(dirA, dirB);
    writeFileSync(join(dirA, "_meta.json"), "{}", "utf-8");
    writeFileSync(join(dirB, "_meta.json"), "{}", "utf-8");
    const skillPathA = join(dirA, "SKILL.md");
    const skillPathB = join(dirB, "SKILL.md");

    const readMetadata = vi.fn(
      async (skillPath: string): Promise<SkillMetadata> => ({
        slug: basename(dirname(skillPath)),
      }),
    );
    const cache = createSkillMetadataCache({ maxEntries: 1, readMetadata });

    await cache.read(skillPathA);
    await cache.read(skillPathB);
    expect(readMetadata).toHaveBeenCalledTimes(2);

    // A вытеснен записью B, поэтому читается заново; повторный hit A не читает.
    expect(await cache.read(skillPathA)).toEqual({ slug: basename(dirA) });
    expect(await cache.read(skillPathA)).toEqual({ slug: basename(dirA) });
    expect(readMetadata).toHaveBeenCalledTimes(3);

    // B вытеснен записью A — читается заново.
    expect(await cache.read(skillPathB)).toEqual({ slug: basename(dirB) });
    expect(readMetadata).toHaveBeenCalledTimes(4);
  });

  it("single-flights concurrent reads of one _meta.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-meta-cache-flight-"));
    tempHomes.push(dir);
    writeFileSync(join(dir, "_meta.json"), "{}", "utf-8");
    const skillPath = join(dir, "SKILL.md");

    let release!: (metadata: SkillMetadata) => void;
    const gate = new Promise<SkillMetadata>((resolve) => {
      release = resolve;
    });
    const readMetadata = vi.fn(() => gate);
    const cache = createSkillMetadataCache({ readMetadata });

    const first = cache.read(skillPath);
    const second = cache.read(skillPath);
    await vi.waitFor(() => expect(readMetadata).toHaveBeenCalledTimes(1));

    release({ version: "1.0.0" });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual({ version: "1.0.0" });
    expect(secondResult).toEqual({ version: "1.0.0" });
  });

  it("does not cache metadata for a stamp that changed while the read was in flight", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-meta-cache-race-cache-"));
    tempHomes.push(dir);
    const metaPath = join(dir, "_meta.json");
    writeFileSync(metaPath, JSON.stringify({ version: "1.0.0" }), "utf-8");
    const skillPath = join(dir, "SKILL.md");

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readMetadata = vi.fn(async (): Promise<SkillMetadata> => {
      if (readMetadata.mock.calls.length === 1) {
        await gate;
        return { version: "1.0.0" };
      }
      return { version: "2.0.0" };
    });
    const cache = createSkillMetadataCache({ readMetadata });

    const first = cache.read(skillPath);
    await vi.waitFor(() => expect(readMetadata).toHaveBeenCalledTimes(1));

    // Меняем _meta.json, пока первое чтение ещё в полёте: stamp на старте устарел.
    writeFileSync(metaPath, JSON.stringify({ version: "2.0.0", changed: true }), "utf-8");
    // Гарантируем другой stamp даже на ФС с грубой гранулярностью mtime.
    const bumped = new Date(Date.now() + 10_000);
    utimesSync(metaPath, bumped, bumped);
    release();

    // Старый результат не должен попасть в кеш как актуальный.
    expect(await first).toEqual({ version: "1.0.0" });
    expect(await cache.read(skillPath)).toEqual({ version: "2.0.0" });
    expect(readMetadata).toHaveBeenCalledTimes(2);
  });

  it("does not hand a newer stamp the metadata of an older in-flight read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zcode-meta-cache-race-join-"));
    tempHomes.push(dir);
    const metaPath = join(dir, "_meta.json");
    writeFileSync(metaPath, JSON.stringify({ version: "1.0.0" }), "utf-8");
    const skillPath = join(dir, "SKILL.md");

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readMetadata = vi.fn(async (): Promise<SkillMetadata> => {
      if (readMetadata.mock.calls.length === 1) {
        await gate;
        return { version: "1.0.0" };
      }
      return { version: "2.0.0" };
    });
    const cache = createSkillMetadataCache({ readMetadata });

    const oldRead = cache.read(skillPath);
    await vi.waitFor(() => expect(readMetadata).toHaveBeenCalledTimes(1));

    writeFileSync(metaPath, JSON.stringify({ version: "2.0.0", changed: true }), "utf-8");
    const bumped = new Date(Date.now() + 10_000);
    utimesSync(metaPath, bumped, bumped);

    // Читатель с новым stamp не присоединяется к in-flight старого и читает сам.
    const newRead = cache.read(skillPath);
    await expect(newRead).resolves.toEqual({ version: "2.0.0" });
    expect(readMetadata).toHaveBeenCalledTimes(2);

    // Поздний результат старого чтения не перезаписывает уже закешированный новый.
    release();
    await expect(oldRead).resolves.toEqual({ version: "1.0.0" });
    expect(await cache.read(skillPath)).toEqual({ version: "2.0.0" });
    expect(readMetadata).toHaveBeenCalledTimes(2);
  });
});

describe("skillsService _meta.json cache", () => {
  it("second list skips _meta.json but still re-reads the SKILL.md body", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    const skillPath = writeSkill(workspacePath, "alpha", "alpha-body");
    writeSkillMeta(workspacePath, "alpha", { slug: "alpha", version: "1.0.0" });
    const service = await createServiceInEnv(home);

    resetFsCalls();
    const first = await service.list({ workspacePath, provider: "glm" });
    // Метрика cold: одно чтение тела SKILL.md и одно чтение _meta.json.
    expect(skillMdReads()).toEqual([skillPath]);
    expect(metaJsonReads()).toHaveLength(1);
    expect(first.skills[0]?.body).toBe("alpha-body");
    expect(first.skills[0]?.metadata).toEqual({ slug: "alpha", version: "1.0.0" });

    resetFsCalls();
    const second = await service.list({ workspacePath, provider: "glm" });
    // Метрика warm: тело читается снова (публичный SkillSummary.body), _meta.json — из кеша.
    expect(skillMdReads()).toEqual([skillPath]);
    expect(metaJsonReads()).toEqual([]);
    expect(second.skills[0]?.body).toBe("alpha-body");
    expect(second.skills[0]?.metadata).toEqual({ slug: "alpha", version: "1.0.0" });
  });

  it("reflects _meta.json and SKILL.md changes on the next list", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    writeSkill(workspacePath, "alpha", "body-v1");
    writeSkillMeta(workspacePath, "alpha", { slug: "alpha", version: "1.0.0" });
    const service = await createServiceInEnv(home);

    const first = await service.list({ workspacePath, provider: "glm" });
    expect(first.skills[0]?.metadata?.version).toBe("1.0.0");

    writeSkill(workspacePath, "alpha", "body-v2");
    writeSkillMeta(workspacePath, "alpha", { slug: "alpha", version: "2.0.0" });

    resetFsCalls();
    const second = await service.list({ workspacePath, provider: "glm" });
    expect(skillMdReads()).toHaveLength(1);
    expect(metaJsonReads()).toHaveLength(1);
    expect(second.skills[0]?.body).toBe("body-v2");
    expect(second.skills[0]?.metadata?.version).toBe("2.0.0");
  });

  it("reads enabled state on every list instead of caching it", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    const skillPath = writeSkill(workspacePath, "alpha", "alpha-body");
    writeSkillMeta(workspacePath, "alpha", { slug: "alpha", version: "1.0.0" });
    const service = await createServiceInEnv(home);

    const first = await service.list({ workspacePath, provider: "glm" });
    expect(first.skills[0]?.enabled).toBe(true);

    // normalizeSkillConfigPath: config ключ — SKILL.md путь с прямыми слешами.
    writeCliConfig(home, { skills: { [skillPath.replaceAll("\\", "/")]: { enable: false } } });

    resetFsCalls();
    const disabled = await service.list({ workspacePath, provider: "glm" });
    expect(disabled.skills[0]?.enabled).toBe(false);
    // Enabled-map не проходит через metadata-кеш и перечитывается каждый list.
    expect(metaJsonReads()).toEqual([]);

    writeCliConfig(home, {});
    const enabledAgain = await service.list({ workspacePath, provider: "glm" });
    expect(enabledAgain.skills[0]?.enabled).toBe(true);
  });

  it("reuses _meta.json cache when setEnabled runs its own discovery", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    writeSkill(workspacePath, "alpha", "alpha-body");
    writeSkillMeta(workspacePath, "alpha", { slug: "alpha", version: "1.0.0" });
    const service = await createServiceInEnv(home);

    const listed = await service.list({ workspacePath, provider: "glm" });
    const skillId = listed.skills[0]!.id;

    resetFsCalls();
    await service.setEnabled({ workspacePath, provider: "glm", skillId, enabled: false });
    // setEnabled делает свой discovery; _meta.json берётся из того же кеша сервиса.
    expect(metaJsonReads()).toEqual([]);

    const after = await service.list({ workspacePath, provider: "glm" });
    expect(after.skills[0]?.enabled).toBe(false);
  });

  it("reads plugin state on every list instead of caching suppressed builtins", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    const pluginRoot = join(
      home,
      ".zcode",
      "cli",
      "plugins",
      "cache",
      "zcode-plugins-official",
      "skill-creator",
      "0.1.0",
    );
    mkdirSync(join(pluginRoot, ".zcode-plugin"), { recursive: true });
    writeFileSync(
      join(pluginRoot, ".zcode-plugin", "plugin.json"),
      JSON.stringify({ name: "skill-creator", skills: "skills", version: "0.1.0" }),
      "utf-8",
    );
    writeSkillAtRoot(join(pluginRoot, "skills"), "skill-creator", "creator-body");
    writeCliConfig(home, {
      plugins: { suppressedBuiltins: ["skill-creator@zcode-plugins-official"] },
    });

    const service = await createServiceInEnv(home);
    const suppressed = await service.list({ workspacePath, provider: "glm" });
    expect(suppressed.skills).toEqual([]);

    // Plugin state читается из config на каждый list: сервис не пересоздаётся.
    writeCliConfig(home, {});
    const visible = await service.list({ workspacePath, provider: "glm" });
    expect(visible.skills.map((skill) => skill.name)).toEqual(["skill-creator"]);
  });

  it("single-flights concurrent lists reading the same _meta.json", async () => {
    const home = makeTempHome();
    const workspacePath = join(home, "workspace");
    writeSkill(workspacePath, "alpha", "alpha-body");
    writeSkillMeta(workspacePath, "alpha", { slug: "alpha", version: "1.0.0" });
    const service = await createServiceInEnv(home);

    resetFsCalls();
    const [first, second] = await Promise.all([
      service.list({ workspacePath, provider: "glm" }),
      service.list({ workspacePath, provider: "glm" }),
    ]);

    expect(metaJsonReads()).toHaveLength(1);
    expect(skillMdReads()).toHaveLength(2);
    expect(first.skills[0]?.metadata).toEqual({ slug: "alpha", version: "1.0.0" });
    expect(second.skills[0]?.metadata).toEqual({ slug: "alpha", version: "1.0.0" });
  });
});
