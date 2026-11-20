// ============================================================
// Node Skill Adapter
// ============================================================

import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type {
  SkillContent,
  SkillDiagnostic,
  SkillLoadOutcome,
  SkillMarketplaceInstallRequest,
  SkillMarketplaceInstallResult,
  SkillMarketplaceSearchRequest,
  SkillMarketplaceSearchResult,
  SkillMetadata,
  SkillOperationOptions,
  SkillPort,
  SkillRoot,
  SkillScope,
} from "@zcode/contracts";
import {
  downloadSkillsShSnapshot,
  resolveMarketplaceInstallRoot,
  searchSkillsSh,
  writeSkillSnapshot,
} from "./marketplace.js";
import { resolveDefaultSkillRoots, type SkillRootResolutionOptions } from "./roots.js";
import { scanSkillFilesUnderRoot } from "./scan.js";

const MAX_DESCRIPTION_LENGTH = 1024;
const SAFE_FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  "when_to_use",
  "license",
  "metadata",
]);
const DEFAULT_MAX_SKILL_BYTES = 100_000;
const DEFAULT_SKILL_CATALOG_MAX_ENTRIES = 512;
const MAX_PLUGIN_MANIFEST_SEARCH_DEPTH = 5;
const PLUGIN_MANIFEST_RELATIVE_PATHS = [
  ".zcode-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
] as const;
// 同名技能被 loadSkill 命中时的 scope 优先级（数字越小越先）。项目局部技能必须压过
// 用户全局技能；user/admin 仍高于 system/bundled，保持内置包永远最后兜底。
const SKILL_SCOPE_PRECEDENCE: Record<SkillScope, number> = {
  project: 0,
  user: 1,
  admin: 2,
  system: 3,
};

export interface NodeSkillAdapterOptions extends SkillRootResolutionOptions {
  // 被禁用的 SKILL.md 绝对路径集合（来自 config.json 的 skill.<path>.enable=false）。
  // 命中的 skill 在发现阶段直接剔除，使 discover/load/inspect 全链路保持一致。
  disabledPaths?: Iterable<string>;
  /**
   * Динамические plugin roots: live plugin install не пересоздаёт adapter,
   * поэтому discover/load должны видеть текущий набор при каждом вызове.
   */
  getExtraResolvedRoots?: () => readonly SkillRoot[] | Promise<readonly SkillRoot[]>;
  /**
   * Общий лимит записей metadata-кеша каталога skill. Кеш хранит только разобранные
   * метаданные (без тела SKILL.md); при переполнении вытесняются самые старые записи.
   */
  catalogCacheMaxEntries?: number;
}

export class NodeSkillAdapter implements SkillPort {
  private readonly disabledPaths: ReadonlySet<string>;
  private readonly pluginNameBySkillRoot = new Map<string, Promise<string | undefined>>();
  private readonly catalogCache: SkillCatalogCache;

  constructor(private readonly options: NodeSkillAdapterOptions = {}) {
    this.catalogCache = new SkillCatalogCache(options.catalogCacheMaxEntries);
    this.disabledPaths = new Set(
      Array.from(options.disabledPaths ?? []).flatMap((path) => {
        const resolvedPath = resolve(path);
        const canonicalPath = safeRealpathSync(resolvedPath);
        return canonicalPath && canonicalPath !== resolvedPath
          ? [resolvedPath, canonicalPath]
          : [resolvedPath];
      }),
    );
  }

  async discoverSkills(
    request: { workingDirectory: string; roots?: SkillRoot[] },
    options?: SkillOperationOptions,
  ): Promise<SkillLoadOutcome> {
    throwIfAborted(options);

    const workingDirectory = resolve(request.workingDirectory);
    const dynamicRoots = request.roots ? undefined : await this.options.getExtraResolvedRoots?.();
    const roots =
      request.roots ??
      (await resolveDefaultSkillRoots(workingDirectory, {
        ...this.options,
        extraResolvedRoots: [...(this.options.extraResolvedRoots ?? []), ...(dynamicRoots ?? [])],
      }));
    const diagnostics: SkillDiagnostic[] = [];
    const selected = new Map<string, SkillMetadata>();
    // 本次调用实际扫描到的路径/根：用于在结束后清掉从磁盘消失的缓存记录。
    const scannedPaths = new Set<string>();
    const scannedRootPaths: string[] = [];
    let totalDiscovered = 0;

    for (const root of roots.toSorted((a, b) => a.priority - b.priority)) {
      throwIfAborted(options);
      scannedRootPaths.push(root.path);
      const skillPaths = await this.skillFilesUnderRoot(root, diagnostics);
      for (const path of skillPaths) {
        throwIfAborted(options);
        scannedPaths.add(path);
        const parsed = await this.parseSkill(path, root, diagnostics);
        if (!parsed) continue;
        if (await this.isDisabledSkillPath(parsed.path)) continue;
        totalDiscovered++;
        // 同名技能可能来自不同技能生态或版本，不能只按 name 去重；路径才是安装项身份。
        if (selected.has(parsed.path)) {
          continue;
        }
        selected.set(parsed.path, parsed);
      }
    }
    // 只清理本次扫描覆盖的根：loadSkill 可能只传部分 roots，不能误删其它根的记录。
    this.catalogCache.pruneMissingEntries(scannedRootPaths, scannedPaths);

    // 同名时按 scope 优先级排序：项目技能必须排在用户/内建技能之前，loadSkill 的
    // 「第一个命中生效」才会让项目局部定制压过全局安装。roots 顺序已按此排列，
    // 这里再显式声明一次，自定义 roots/插件 roots 混入时也不会被插入顺序反噬。
    const skills = Array.from(selected.values()).toSorted((a, b) => {
      const byName = a.name.localeCompare(b.name);
      if (byName !== 0) return byName;
      return skillScopePrecedence(a.scope) - skillScopePrecedence(b.scope);
    });
    pushSkillShadowingDiagnostics(skills, diagnostics);

    return {
      skills,
      diagnostics,
      totalDiscovered,
    };
  }

  async searchMarketplace(
    request: SkillMarketplaceSearchRequest,
    options?: SkillOperationOptions,
  ): Promise<SkillMarketplaceSearchResult> {
    const workspaceRoot = resolveMarketplaceInstallRoot({
      workingDirectory: request.workingDirectory,
      scope: "workspace",
      homeDirectory: this.options.homeDirectory,
    });
    const userRoot = resolveMarketplaceInstallRoot({
      workingDirectory: request.workingDirectory,
      scope: "user",
      homeDirectory: this.options.homeDirectory,
    });
    const result = await searchSkillsSh(request, options);
    return {
      ...result,
      items: result.items.map((item) => ({
        ...item,
        installed:
          existsSync(join(workspaceRoot, item.skillId)) || existsSync(join(userRoot, item.skillId)),
      })),
    };
  }

  async installMarketplaceSkill(
    request: SkillMarketplaceInstallRequest,
    options?: SkillOperationOptions,
  ): Promise<SkillMarketplaceInstallResult> {
    const scope = request.scope ?? "workspace";
    const root = resolveMarketplaceInstallRoot({
      workingDirectory: request.workingDirectory,
      scope,
      homeDirectory: this.options.homeDirectory,
    });
    const snapshot = await downloadSkillsShSnapshot(
      { source: request.source, skillId: request.skillId },
      options,
    );
    const written = await writeSkillSnapshot({
      root,
      source: request.source,
      skillId: request.skillId,
      snapshot,
      overwrite: request.overwrite === true,
    });
    const outcome = await this.discoverSkills(
      { workingDirectory: request.workingDirectory },
      options,
    );
    const installed = outcome.skills.find(
      (skill) => skill.directory === written.path || skill.path.startsWith(`${written.path}${sep}`),
    );
    if (!installed) {
      throw new Error(
        `Installed skill ${request.skillId} was not discoverable under ${written.path}`,
      );
    }
    return {
      name: installed.name,
      source: request.source,
      skillId: request.skillId,
      path: written.path,
      scope,
      filesWritten: written.filesWritten,
      ...(snapshot.hash ? { hash: snapshot.hash } : {}),
      alreadyInstalled: written.alreadyInstalled,
    };
  }

  async loadSkill(
    request: { name: string; workingDirectory: string; roots?: SkillRoot[]; maxBytes?: number },
    options?: SkillOperationOptions,
  ): Promise<SkillContent> {
    throwIfAborted(options);

    const outcome = await this.discoverSkills(
      {
        workingDirectory: request.workingDirectory,
        roots: request.roots,
      },
      options,
    );
    const metadata = outcome.skills.find((skill) => matchesSkillRequest(skill, request.name));
    if (!metadata) {
      throw new Error(`Skill not found: ${request.name}`);
    }

    const maxBytes = request.maxBytes ?? DEFAULT_MAX_SKILL_BYTES;
    const info = await stat(metadata.path);
    const truncated = info.size > maxBytes;
    const buffer = truncated
      ? await readFirstBytes(metadata.path, maxBytes)
      : await readFile(metadata.path);
    const rawContent = buffer.toString("utf8");
    const content = stripFrontmatter(rawContent).trim();

    return {
      metadata,
      content,
      baseDirectory: metadata.directory,
      bytesRead: buffer.byteLength,
      sizeBytes: info.size,
      truncated,
    };
  }

  private async skillFilesUnderRoot(
    skillRoot: SkillRoot,
    diagnostics: SkillDiagnostic[],
  ): Promise<string[]> {
    try {
      // manifest 的 skills 项既可指向单个技能目录，也可指向包含多个技能的根目录。
      // 共享 scan helper 会检查根自身的 SKILL.md，再扫描一层子目录，排除策略与桌面端一致。
      // 信任边界：plugin-scope 内容不可信，不跟随符号链接（目录级与文件级逃逸
      // 一并拒绝）；用户级根保持跟随，symlink 技能导入能力不变。
      return await scanSkillFilesUnderRoot(skillRoot.path, {
        followSymbolicLinks: skillRoot.source !== "plugin",
      });
    } catch (error) {
      if (isNotFoundError(error)) {
        return [];
      }
      diagnostics.push({
        code: "skill_scan_failed",
        severity: "warning",
        message:
          error instanceof Error ? error.message : `Failed to scan skill root: ${skillRoot.path}`,
        path: skillRoot.path,
      });
      return [];
    }
  }

  private async parseSkill(
    path: string,
    root: SkillRoot,
    diagnostics: SkillDiagnostic[],
  ): Promise<SkillMetadata | null> {
    const entry = await this.loadSkillCatalogEntry(path, diagnostics);
    if (!entry?.metadata) return null;
    const { metadata } = entry;
    // root 派生字段（scope/source/namespace/pluginName）不进缓存：同一个文件经不同根
    // 命中时必须拿到当前根的语义，否则 cache hit 会混淆项目/用户/插件作用域。
    const pluginAlias = await this.resolvePluginSkillAlias(metadata.name, root);

    return {
      name: metadata.name,
      description: metadata.description,
      ...(metadata.whenToUse === undefined ? {} : { whenToUse: metadata.whenToUse }),
      ...pluginAlias,
      ...(root.namespace ? { qualifiedName: `${root.namespace}/${metadata.name}` } : {}),
      path,
      directory: dirname(path),
      rootPath: root.path,
      scope: root.scope,
      source: root.source,
      safeToAutoLoad: metadata.safeToAutoLoad,
      // 复制数组，避免调用方修改返回值时污染缓存条目。
      frontmatterKeys: [...metadata.frontmatterKeys],
      policy: {
        allowImplicitInvocation: true,
      },
    };
  }

  /**
   * Возвращает metadata-запись каталога. Чтение файла пропускается, если mtimeMs+sizeBytes
   * не изменились; тело SKILL.md в кеш не попадает и читается только loadSkill.
   */
  private async loadSkillCatalogEntry(
    path: string,
    diagnostics: SkillDiagnostic[],
  ): Promise<SkillCatalogEntry | null> {
    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(path);
    } catch (error) {
      if (isNotFoundError(error)) return null;
      pushSkillReadFailedDiagnostic(diagnostics, path, error);
      return null;
    }

    const stamp: SkillCatalogStamp = {
      mtimeMs: fileStat.mtimeMs,
      sizeBytes: fileStat.size,
    };
    const cached = this.catalogCache.get(path, stamp);
    if (cached) {
      replaySkillCatalogDiagnostics(cached, diagnostics);
      return cached;
    }

    let entry: SkillCatalogEntry;
    try {
      // single-flight: 并发 discover 共享同一文件的一次读取。
      entry = await this.catalogCache.load(path, async () => {
        const [buffer, canonicalPath] = await Promise.all([
          readFile(path),
          realpath(path).catch(() => path),
        ]);
        return buildSkillCatalogEntry(path, canonicalPath, stamp, buffer);
      });
    } catch (error) {
      if (isNotFoundError(error)) return null;
      pushSkillReadFailedDiagnostic(diagnostics, path, error);
      return null;
    }

    replaySkillCatalogDiagnostics(entry, diagnostics);
    return entry;
  }

  private async isDisabledSkillPath(path: string): Promise<boolean> {
    const resolvedPath = resolve(path);
    if (this.disabledPaths.has(resolvedPath)) {
      return true;
    }
    const canonicalPath = await realpath(resolvedPath).catch(() => resolvedPath);
    // UI 可能把 symlink 目标真实路径写入 config，而 agent 从 ~/.zcode/skills 的链接路径扫描。
    // 同时比对扫描路径和真实路径，避免同一个 SKILL.md 因路径形态不同绕过禁用开关。
    return this.disabledPaths.has(canonicalPath);
  }

  private async resolvePluginSkillAlias(
    skillName: string,
    root: SkillRoot,
  ): Promise<Pick<SkillMetadata, "pluginId" | "pluginName" | "qualifiedName"> | undefined> {
    if (root.source !== "plugin") return undefined;
    const pluginName = await this.resolvePluginName(root.path);
    if (!pluginName) return undefined;

    return {
      ...(root.pluginId ? { pluginId: root.pluginId } : {}),
      pluginName,
      qualifiedName: `${pluginName}:${skillName}`,
    };
  }

  private async resolvePluginName(skillRootPath: string): Promise<string | undefined> {
    const resolvedRoot = resolve(skillRootPath);
    let cached = this.pluginNameBySkillRoot.get(resolvedRoot);
    if (!cached) {
      cached = readPluginNameForSkillRoot(resolvedRoot);
      this.pluginNameBySkillRoot.set(resolvedRoot, cached);
    }
    return cached;
  }
}

export function createNodeSkillAdapter(options: NodeSkillAdapterOptions = {}): NodeSkillAdapter {
  return new NodeSkillAdapter(options);
}

interface SkillCatalogStamp {
  mtimeMs: number;
  sizeBytes: number;
}

interface SkillCatalogFileMetadata {
  name: string;
  description: string;
  whenToUse?: string;
  safeToAutoLoad: boolean;
  frontmatterKeys: string[];
}

interface SkillCatalogEntry extends SkillCatalogStamp {
  path: string;
  canonicalPath: string;
  contentHash: string;
  metadata: SkillCatalogFileMetadata | null;
  diagnostics: readonly SkillDiagnostic[];
}

/**
 * In-memory metadata-кеш каталога skill. Один экземпляр на NodeSkillAdapter.
 * Хранит только разобранные метаданные (без тела SKILL.md), инвалидируется по mtimeMs+sizeBytes,
 * ограничен числом записей и дедуплицирует одновременные чтения одного файла.
 */
class SkillCatalogCache {
  private readonly entries = new Map<string, SkillCatalogEntry>();
  private readonly inFlight = new Map<string, Promise<SkillCatalogEntry>>();
  private readonly maxEntries: number;

  constructor(maxEntries: number | undefined) {
    this.maxEntries =
      typeof maxEntries === "number" && Number.isFinite(maxEntries)
        ? Math.max(1, Math.trunc(maxEntries))
        : DEFAULT_SKILL_CATALOG_MAX_ENTRIES;
  }

  get(path: string, stamp: SkillCatalogStamp): SkillCatalogEntry | undefined {
    const entry = this.entries.get(path);
    if (!entry || entry.mtimeMs !== stamp.mtimeMs || entry.sizeBytes !== stamp.sizeBytes) {
      return undefined;
    }
    // LRU: hit переносит запись в конец, поэтому вытесняются давно не использованные.
    this.entries.delete(path);
    this.entries.set(path, entry);
    return entry;
  }

  async load(path: string, loader: () => Promise<SkillCatalogEntry>): Promise<SkillCatalogEntry> {
    const pending = this.inFlight.get(path);
    if (pending) return pending;

    const promise = loader()
      .then((entry) => {
        this.store(path, entry);
        return entry;
      })
      .finally(() => {
        this.inFlight.delete(path);
      });
    this.inFlight.set(path, promise);
    return promise;
  }

  pruneMissingEntries(rootPaths: readonly string[], seenPaths: ReadonlySet<string>): void {
    if (this.entries.size === 0) return;
    const prefixes = rootPaths.map((rootPath) =>
      rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`,
    );
    // Снимок ключей: prune удаляет записи во время обхода, живой итератор Map
    // менял бы набор обходимых элементов. Array.from сохраняет прежнюю семантику.
    for (const path of Array.from(this.entries.keys())) {
      if (seenPaths.has(path)) continue;
      if (prefixes.some((prefix) => path.startsWith(prefix))) {
        this.entries.delete(path);
      }
    }
  }

  private store(path: string, entry: SkillCatalogEntry): void {
    this.entries.delete(path);
    this.entries.set(path, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

function buildSkillCatalogEntry(
  path: string,
  canonicalPath: string,
  stamp: SkillCatalogStamp,
  buffer: Buffer,
): SkillCatalogEntry {
  const parsedDiagnostics: SkillDiagnostic[] = [];
  const frontmatter = extractFrontmatter(buffer.toString("utf8"));
  // 无 frontmatter 的手写 skill 仍可按目录名加载，避免设置页/CLI 出现无修复价值的错误。
  const parsed = frontmatter
    ? parseFlatYaml(frontmatter, path, parsedDiagnostics)
    : { values: {}, keys: [] };
  const name =
    parseScalar(parsed.values.name) ?? (frontmatter ? undefined : basename(dirname(path)));
  const metadata = buildSkillCatalogFileMetadata(
    name,
    frontmatter,
    parsed,
    path,
    parsedDiagnostics,
  );

  return {
    path,
    canonicalPath,
    mtimeMs: stamp.mtimeMs,
    sizeBytes: stamp.sizeBytes,
    contentHash: createHash("sha256").update(buffer).digest("hex"),
    metadata,
    diagnostics: parsedDiagnostics.map((diagnostic) => ({ ...diagnostic })),
  };
}

function buildSkillCatalogFileMetadata(
  name: string | undefined,
  frontmatter: string | null,
  parsed: { values: Record<string, string>; keys: string[] },
  path: string,
  diagnostics: SkillDiagnostic[],
): SkillCatalogFileMetadata | null {
  if (!name) {
    diagnostics.push({
      code: "skill_missing_name",
      severity: "error",
      message: `Skill frontmatter must include a name: ${path}`,
      path,
    });
    return null;
  }
  const rawDescription = parseScalar(parsed.values.description);
  if (!rawDescription && frontmatter) {
    diagnostics.push({
      code: "skill_missing_description",
      severity: "error",
      message: `Skill frontmatter must include a description: ${path}`,
      path,
      skillName: name,
    });
    return null;
  }
  const description = rawDescription ?? "";
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    diagnostics.push({
      code: "skill_description_too_long",
      severity: "error",
      message: `Skill description is too long: ${name}`,
      path,
      skillName: name,
    });
    return null;
  }
  const whenToUse = parseScalar(parsed.values.when_to_use);

  // 第三方/旧版 skill 常带 version、homepage 等扩展字段。
  // 这些字段不影响加载，不再作为 warning 暴露，只保留 safeToAutoLoad 的保守判断。
  return {
    name,
    description,
    ...(whenToUse === undefined ? {} : { whenToUse }),
    safeToAutoLoad: parsed.keys.every((key) => SAFE_FRONTMATTER_KEYS.has(key)),
    frontmatterKeys: parsed.keys,
  };
}

function replaySkillCatalogDiagnostics(
  entry: SkillCatalogEntry,
  diagnostics: SkillDiagnostic[],
): void {
  for (const diagnostic of entry.diagnostics) {
    // 复制诊断对象：调用方可能修改数组/对象，缓存模板必须保持只读。
    diagnostics.push({ ...diagnostic });
  }
}

function pushSkillReadFailedDiagnostic(
  diagnostics: SkillDiagnostic[],
  path: string,
  error: unknown,
): void {
  diagnostics.push({
    code: "skill_read_failed",
    severity: "warning",
    message: error instanceof Error ? error.message : `Failed to read skill: ${path}`,
    path,
  });
}

function extractFrontmatter(content: string): string | null {
  const normalized = content.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return null;
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex <= 0) return null;
  return lines.slice(1, endIndex).join("\n");
}

function stripFrontmatter(content: string): string {
  const normalized = content.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return content;
  const lines = normalized.split(/\r?\n/);
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex <= 0) return content;
  return lines.slice(endIndex + 1).join("\n");
}

function parseFlatYaml(
  frontmatter: string,
  path: string,
  diagnostics: SkillDiagnostic[],
): { values: Record<string, string>; keys: string[] } {
  const values: Record<string, string> = {};
  const keys: string[] = [];
  const lines = frontmatter.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0 || line.trim().startsWith("#")) continue;
    if (/^\s/.test(line)) continue;

    const separator = line.indexOf(":");
    if (separator <= 0) {
      diagnostics.push({
        code: "skill_invalid_frontmatter",
        severity: "warning",
        message: `Invalid frontmatter line ${index + 1} in ${basename(path)}`,
        path,
      });
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    keys.push(key);
    const blockStyle = parseBlockScalarStyle(value);
    if (blockStyle) {
      // Agent 侧只读顶层 `description: >` 会把后续缩进行跳过，
      // 导致 `.agents/skills` 的合法多行触发说明注入给模型时只剩 `>`。
      const block = readBlockScalar(lines, index + 1, blockStyle);
      values[key] = block.value;
      index = block.nextIndex - 1;
    } else {
      values[key] = value;
    }
  }

  return { values, keys };
}

function parseBlockScalarStyle(value: string): "folded" | "literal" | null {
  if (/^>[+-]?$/.test(value)) return "folded";
  if (/^\|[+-]?$/.test(value)) return "literal";
  return null;
}

function readBlockScalar(
  lines: string[],
  startIndex: number,
  style: "folded" | "literal",
): { value: string; nextIndex: number } {
  const rawLines: string[] = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().length > 0 && !/^\s/.test(line)) {
      break;
    }
    rawLines.push(line);
    index += 1;
  }

  const indent = rawLines.reduce<number | null>((current, line) => {
    if (line.trim().length === 0) return current;
    const lineIndent = leadingWhitespaceLength(line);
    return current === null ? lineIndent : Math.min(current, lineIndent);
  }, null);
  const contentLines = rawLines.map((line) =>
    line.trim().length === 0 ? "" : line.slice(indent ?? 0),
  );
  return {
    value: style === "folded" ? foldBlockScalarLines(contentLines) : contentLines.join("\n").trim(),
    nextIndex: index,
  };
}

function leadingWhitespaceLength(value: string): number {
  const match = /^(\s*)/.exec(value);
  return match?.[1]?.length ?? 0;
}

function foldBlockScalarLines(lines: string[]): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (current.length > 0) {
        paragraphs.push(current.join(" "));
        current = [];
      }
      continue;
    }
    current.push(trimmed);
  }
  if (current.length > 0) {
    paragraphs.push(current.join(" "));
  }
  return paragraphs.join("\n").trim();
}

function parseScalar(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function matchesSkillRequest(skill: SkillMetadata, requestName: string): boolean {
  return skill.name === requestName || skill.qualifiedName === requestName;
}

function skillScopePrecedence(scope: SkillScope): number {
  return SKILL_SCOPE_PRECEDENCE[scope];
}

/**
 * 同名技能按路径全部保留，但 loadSkill 只能命中第一个。跨 scope 遮蔽（如用户技能被项目技能压过）
 * 会让被遮蔽的版本静默不可用，必须用诊断解释「哪个文件赢了、哪个被忽略」。
 * 同 scope 的多份同名技能（不同目录、不同插件）保持既有语义：都保留、不互相告警。
 */
function pushSkillShadowingDiagnostics(
  skills: readonly SkillMetadata[],
  diagnostics: SkillDiagnostic[],
): void {
  const groups = new Map<string, SkillMetadata[]>();
  for (const skill of skills) {
    const group = groups.get(skill.name) ?? [];
    group.push(skill);
    groups.set(skill.name, group);
  }
  for (const [name, group] of groups) {
    if (group.length < 2) continue;
    const winner = group[0];
    if (!winner) continue;
    for (const shadowed of group.slice(1)) {
      if (skillScopePrecedence(shadowed.scope) <= skillScopePrecedence(winner.scope)) continue;
      diagnostics.push({
        code: "skill_duplicate_name",
        severity: "warning",
        skillName: name,
        path: shadowed.path,
        message:
          `Skill "${name}" from ${shadowed.scope} scope is shadowed by ` +
          `${winner.scope} skill: ${winner.path}`,
      });
    }
  }
}

async function readPluginNameForSkillRoot(skillRootPath: string): Promise<string | undefined> {
  let current = resolve(skillRootPath);
  for (let depth = 0; depth <= MAX_PLUGIN_MANIFEST_SEARCH_DEPTH; depth++) {
    for (const relativePath of PLUGIN_MANIFEST_RELATIVE_PATHS) {
      const pluginName = await readPluginNameFromManifest(join(current, relativePath));
      if (pluginName) return pluginName;
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

async function readPluginNameFromManifest(manifestPath: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { name?: unknown };
    return typeof manifest.name === "string" && manifest.name.trim().length > 0
      ? manifest.name.trim()
      : undefined;
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    return undefined;
  }
}

function safeRealpathSync(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

async function readFirstBytes(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function throwIfAborted(options: SkillOperationOptions | undefined): void {
  if (options?.signal?.aborted) {
    throw new Error("Skill operation cancelled");
  }
}
