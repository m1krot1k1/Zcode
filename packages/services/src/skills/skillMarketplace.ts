/**
 * skills.sh marketplace client for the shared service layer.
 *
 * Verified public endpoints (no credentials):
 *   GET https://skills.sh/api/search?q=<query>
 *     -> { query, skills: [{ id, source, skillId, name, installs }] }
 *   GET https://skills.sh/api/download/<owner>/<repo>/<skillId>
 *     -> { files: [{ path, contents }], hash }
 *
 * Downloaded snapshots are untrusted input. This module only validates and writes
 * files; it never executes or interprets downloaded content.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type { MarketplaceSkillInfo } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

const logger = createServiceLogger("skills.marketplace");

const SKILLS_SH_ORIGIN = "https://skills.sh";
const SEARCH_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const MAX_QUERY_LENGTH = 200;
const MAX_SNAPSHOT_FILES = 500;
const MAX_SNAPSHOT_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_SNAPSHOT_FILE_BYTES = 5 * 1024 * 1024;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_DIRECTORY_NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

type SkillMarketplaceErrorCode =
  | "invalid_input"
  | "not_found"
  | "network"
  | "http_error"
  | "invalid_response"
  | "unsafe_snapshot"
  | "limit_exceeded"
  | "write_conflict";

export class SkillMarketplaceError extends Error {
  readonly code: SkillMarketplaceErrorCode;

  constructor(code: SkillMarketplaceErrorCode, message: string) {
    super(message);
    this.name = "SkillMarketplaceError";
    this.code = code;
  }
}

interface SkillsShSearchEntry {
  id: string;
  source: string;
  skillId: string;
  name: string;
  installs: number;
}

interface SkillsShSnapshotFile {
  path: string;
  contents: string;
}

interface SkillsShSnapshot {
  files: SkillsShSnapshotFile[];
  hash?: string;
}

interface MarketplaceSkillReference {
  source: string;
  skillId: string;
}

interface MarketplaceSkillMetadata {
  source: string;
  skillId: string;
  name: string;
  scope?: "workspace" | "user";
  hash: string;
  remoteHash?: string;
  version?: string;
  installedAt: string;
  manager: "skills.sh";
}

/** 空搜索不访问网络；调用方负责返回空结果。 */
export async function searchSkillsSh(query: string): Promise<SkillsShSearchEntry[]> {
  const normalized = query.trim();
  if (normalized.length > MAX_QUERY_LENGTH) {
    throw new SkillMarketplaceError(
      "invalid_input",
      `skills.sh search query must be at most ${MAX_QUERY_LENGTH} characters`,
    );
  }
  const url = `${SKILLS_SH_ORIGIN}/api/search?${new URLSearchParams({ q: normalized }).toString()}`;
  const response = await fetchWithTimeout(url, SEARCH_TIMEOUT_MS);
  if (!response.ok) {
    throw new SkillMarketplaceError("http_error", `skills.sh search failed with HTTP ${response.status}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    throw new SkillMarketplaceError("invalid_response", "skills.sh search returned invalid JSON");
  }
  if (!isRecord(payload) || !Array.isArray(payload.skills)) {
    throw new SkillMarketplaceError(
      "invalid_response",
      "skills.sh search response is missing the skills array",
    );
  }
  return payload.skills.flatMap((raw): SkillsShSearchEntry[] => {
    if (!isRecord(raw)) return [];
    const source = readString(raw.source);
    const skillId = readString(raw.skillId);
    const name = readString(raw.name);
    if (!source || !skillId || !name) return [];
    if (!isSafeSource(source) || !SAFE_SEGMENT.test(skillId)) return [];
    const installs =
      typeof raw.installs === "number" && Number.isFinite(raw.installs) && raw.installs >= 0
        ? raw.installs
        : 0;
    return [{ id: `${source}/${skillId}`, source, skillId, name, installs }];
  });
}

/**
 * `name` 接受三种形式：
 * - `owner/repo/skillId`（搜索结果里的 item.id）
 * - 裸 `skillId`（通过搜索接口解析唯一来源）
 */
export async function resolveMarketplaceSkillReference(
  name: string,
): Promise<MarketplaceSkillReference> {
  const normalized = name.trim();
  if (normalized.length === 0) {
    throw new SkillMarketplaceError("invalid_input", "skill name is required");
  }
  if (normalized.includes("/")) {
    const parts = normalized.split("/");
    if (parts.length !== 3) {
      throw new SkillMarketplaceError(
        "invalid_input",
        "marketplace skill name must be <owner>/<repo>/<skillId> or a bare skill id",
      );
    }
    const [owner, repo, skillId] = parts as [string, string, string];
    if (!SAFE_SEGMENT.test(owner) || !SAFE_SEGMENT.test(repo) || !SAFE_SEGMENT.test(skillId)) {
      throw new SkillMarketplaceError("invalid_input", "marketplace skill reference contains invalid characters");
    }
    return { source: `${owner}/${repo}`, skillId };
  }
  if (!SAFE_SEGMENT.test(normalized)) {
    throw new SkillMarketplaceError("invalid_input", "marketplace skill id contains invalid characters");
  }
  const entries = await searchSkillsSh(normalized);
  const exact = entries
    .filter(
      (entry) =>
        entry.skillId.toLowerCase() === normalized.toLowerCase() ||
        entry.name.toLowerCase() === normalized.toLowerCase(),
    )
    .sort((left, right) => right.installs - left.installs);
  const match = exact[0];
  if (!match) {
    throw new SkillMarketplaceError("not_found", `skill not found on skills.sh: ${normalized}`);
  }
  return { source: match.source, skillId: match.skillId };
}

export async function downloadSkillsShSnapshot(
  reference: MarketplaceSkillReference,
): Promise<SkillsShSnapshot> {
  const [owner, repo] = reference.source.split("/") as [string, string];
  const url = `${SKILLS_SH_ORIGIN}/api/download/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(reference.skillId)}`;
  const response = await fetchWithTimeout(url, DOWNLOAD_TIMEOUT_MS);
  if (!response.ok) {
    throw new SkillMarketplaceError(
      "http_error",
      `skills.sh download failed with HTTP ${response.status}`,
    );
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_SNAPSHOT_TOTAL_BYTES) {
    throw new SkillMarketplaceError("limit_exceeded", "skills.sh snapshot exceeds the 10 MiB limit");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new SkillMarketplaceError("invalid_response", "skills.sh snapshot is not valid JSON");
  }
  return validateSnapshot(payload);
}

/** 目录名做白名单清洗：小写、[a-z0-9._-]、去掉首尾的点/连字符，拒绝 '..'。 */
export function sanitizeMarketplaceDirectoryName(raw: string): string {
  const name = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[-.]+/u, "")
    .replace(/[-.]+$/u, "");
  if (!name || name === "." || name === ".." || name.includes("..") || !SAFE_DIRECTORY_NAME.test(name)) {
    throw new SkillMarketplaceError(
      "invalid_input",
      `skill name cannot be used as a directory name: ${raw}`,
    );
  }
  return name;
}

/**
 * 读取已安装技能目录名与 SKILL.md 名称（小写）。用于搜索结果的 installed 标记。
 * 只读，不跟随目录软链。
 */
export async function collectInstalledSkillKeys(roots: string[]): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      logger.warn(undefined, "failed to read installed skill root", root, String(error));
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        keys.add(entry.name.toLowerCase());
        const frontmatterName = await readSkillFrontmatterName(join(root, entry.name, "SKILL.md"));
        if (frontmatterName) keys.add(frontmatterName.toLowerCase());
      }
    }
  }
  return keys;
}

export function toMarketplaceItems(
  entries: SkillsShSearchEntry[],
  installedKeys: ReadonlySet<string>,
): MarketplaceSkillInfo[] {
  return entries.map((entry) => ({
    name: entry.name,
    skillId: entry.skillId,
    source: entry.source,
    installs: entry.installs,
    installed:
      installedKeys.has(entry.skillId.toLowerCase()) ||
      installedKeys.has(entry.name.toLowerCase()),
  }));
}

interface WriteSnapshotParams {
  root: string;
  directoryName: string;
  reference: MarketplaceSkillReference;
  scope?: "workspace" | "user";
  snapshot: SkillsShSnapshot;
}

/**
 * 先写临时目录再 rename，失败时不留下部分写入的目标目录。
 * 已存在同名目录时：只有带 `_meta.json` 且 source/skillId 匹配的 marketplace 目录可以被替换；
 * hand-written 技能一律拒绝覆盖。
 */
export async function writeSkillSnapshotAtomically(
  params: WriteSnapshotParams,
): Promise<{ path: string; installedName: string; version?: string }> {
  const target = join(params.root, params.directoryName);
  assertInsideRoot(params.root, target);
  await mkdir(params.root, { recursive: true });

  if (existsSync(target)) {
    await assertReplaceableMarketplaceDirectory(target, params.reference);
  }

  const skillMarkdown = params.snapshot.files.find((file) => file.path === "SKILL.md");
  const frontmatter = parseSkillFrontmatter(skillMarkdown?.contents ?? "");
  const installedName = frontmatter.name || params.directoryName;
  const digest = hashSnapshot(params.snapshot.files);
  const metadata: MarketplaceSkillMetadata = {
    source: params.reference.source,
    skillId: params.reference.skillId,
    name: installedName,
    ...(params.scope ? { scope: params.scope } : {}),
    hash: `sha256:${digest}`,
    ...(params.snapshot.hash ? { remoteHash: params.snapshot.hash } : {}),
    ...(frontmatter.version ? { version: frontmatter.version } : {}),
    installedAt: new Date().toISOString(),
    manager: "skills.sh",
  };

  const tempDir = await mkdtemp(join(params.root, ".tmp-marketplace-"));
  let backupDir: string | undefined;
  try {
    for (const file of params.snapshot.files) {
      const destination = join(tempDir, file.path);
      assertInsideRoot(tempDir, destination);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.contents, "utf8");
    }
    await writeFile(join(tempDir, "_meta.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

    if (existsSync(target)) {
      backupDir = join(params.root, `.bak-marketplace-${basename(tempDir)}`);
      await rename(target, backupDir);
    }
    try {
      await rename(tempDir, target);
    } catch (error) {
      if (backupDir) await rename(backupDir, target).catch(() => {});
      throw error;
    }
    if (backupDir) await rm(backupDir, { recursive: true, force: true });
    return {
      path: target,
      installedName,
      ...(frontmatter.version ? { version: frontmatter.version } : {}),
    };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function validateSnapshot(snapshot: unknown): SkillsShSnapshot {
  if (!isRecord(snapshot)) {
    throw new SkillMarketplaceError(
      "invalid_response",
      "skills.sh snapshot must be a JSON object",
    );
  }
  const files = readSnapshotFileEntries(snapshot.files);
  if (files.length === 0) {
    throw new SkillMarketplaceError("invalid_response", "skills.sh snapshot contains no files");
  }
  if (files.length > MAX_SNAPSHOT_FILES) {
    throw new SkillMarketplaceError(
      "limit_exceeded",
      `skills.sh snapshot exceeds ${MAX_SNAPSHOT_FILES} files`,
    );
  }
  const seen = new Set<string>();
  const normalizedFiles: SkillsShSnapshotFile[] = [];
  let totalBytes = 0;
  for (const raw of files) {
    if (!isRecord(raw) || typeof raw.path !== "string") {
      throw new SkillMarketplaceError(
        "invalid_response",
        "skills.sh snapshot contains an invalid file entry",
      );
    }
    // 兼容两种已验证/可能的 payload：`contents`（skills.sh 当前返回）与 `content`。
    const contents = raw.contents ?? raw.content;
    if (typeof contents !== "string") {
      throw new SkillMarketplaceError(
        "invalid_response",
        "skills.sh snapshot contains an invalid file entry",
      );
    }
    const path = normalizeSnapshotPath(raw.path);
    if (seen.has(path)) {
      throw new SkillMarketplaceError(
        "unsafe_snapshot",
        `skills.sh snapshot contains duplicate path: ${path}`,
      );
    }
    seen.add(path);
    normalizedFiles.push({ path, contents });
    const fileBytes = Buffer.byteLength(contents, "utf8");
    if (fileBytes > MAX_SNAPSHOT_FILE_BYTES) {
      throw new SkillMarketplaceError(
        "limit_exceeded",
        `skills.sh snapshot file exceeds 5 MiB: ${path}`,
      );
    }
    totalBytes += fileBytes;
    if (totalBytes > MAX_SNAPSHOT_TOTAL_BYTES) {
      throw new SkillMarketplaceError(
        "limit_exceeded",
        "skills.sh snapshot exceeds the 10 MiB limit",
      );
    }
  }
  if (!seen.has("SKILL.md")) {
    throw new SkillMarketplaceError(
      "unsafe_snapshot",
      "skills.sh snapshot must contain SKILL.md at its root",
    );
  }
  if (snapshot.hash !== undefined && typeof snapshot.hash !== "string") {
    throw new SkillMarketplaceError(
      "invalid_response",
      "skills.sh snapshot hash must be a string",
    );
  }
  // 返回按校验结果重建的规范快照，写入阶段不再信任原始 path。
  return {
    files: normalizedFiles,
    ...(typeof snapshot.hash === "string" ? { hash: snapshot.hash } : {}),
  };
}

/**
 * 容忍两种 files 形态：
 * - `[{ path, contents | content }]`（skills.sh 当前返回）
 * - `{ "<path>": "<content>" }`（对象映射）
 */
function readSnapshotFileEntries(rawFiles: unknown): unknown[] {
  if (Array.isArray(rawFiles)) {
    return rawFiles;
  }
  if (isRecord(rawFiles)) {
    return Object.entries(rawFiles).map(([path, contents]) => ({ path, contents }));
  }
  throw new SkillMarketplaceError(
    "invalid_response",
    "skills.sh snapshot must contain a files array or map",
  );
}

function normalizeSnapshotPath(rawPath: string): string {
  if (rawPath.length === 0 || rawPath.includes("\0")) {
    throw new SkillMarketplaceError("unsafe_snapshot", "skills.sh snapshot contains an unsafe path");
  }
  // 统一分隔符后再校验：Windows 风格路径同样必须落在相对路径白名单内。
  const withPosixSeparators = rawPath.replaceAll("\\", "/");
  if (isAbsolute(withPosixSeparators) || /^[A-Za-z]:/u.test(withPosixSeparators)) {
    throw new SkillMarketplaceError(
      "unsafe_snapshot",
      "skills.sh snapshot contains an absolute path",
    );
  }
  const normalized = posix.normalize(withPosixSeparators);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..")
  ) {
    throw new SkillMarketplaceError(
      "unsafe_snapshot",
      "skills.sh snapshot contains a path traversal",
    );
  }
  return normalized;
}

function assertInsideRoot(root: string, target: string): void {
  const relativePath = relative(root, target);
  if (relativePath.length === 0) return;
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new SkillMarketplaceError(
      "unsafe_snapshot",
      "skills.sh snapshot path escapes the skill directory",
    );
  }
}

async function assertReplaceableMarketplaceDirectory(
  target: string,
  reference: MarketplaceSkillReference,
): Promise<void> {
  const stats = await lstat(target);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new SkillMarketplaceError(
      "write_conflict",
      `refusing to overwrite a non-directory skill path: ${target}`,
    );
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(await readFile(join(target, "_meta.json"), "utf8"));
  } catch {
    throw new SkillMarketplaceError(
      "write_conflict",
      `refusing to overwrite a hand-written skill at ${target}; remove it manually first`,
    );
  }
  if (
    !isRecord(metadata) ||
    metadata.source !== reference.source ||
    metadata.skillId !== reference.skillId
  ) {
    throw new SkillMarketplaceError(
      "write_conflict",
      `refusing to overwrite ${target}: it is managed by a different marketplace source`,
    );
  }
}

async function readSkillFrontmatterName(skillMarkdownPath: string): Promise<string | undefined> {
  try {
    return parseSkillFrontmatter(await readFile(skillMarkdownPath, "utf8")).name;
  } catch {
    return undefined;
  }
}

function parseSkillFrontmatter(content: string): { name?: string; version?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content);
  if (!match) return {};
  try {
    const parsed = parseYaml(match[1] ?? "");
    if (!isRecord(parsed)) return {};
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    const version =
      typeof parsed.version === "string"
        ? parsed.version.trim()
        : typeof parsed.version === "number"
          ? String(parsed.version)
          : "";
    return {
      ...(name ? { name } : {}),
      ...(version ? { version } : {}),
    };
  } catch {
    return {};
  }
}

function hashSnapshot(files: SkillsShSnapshotFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.contents);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "user-agent": "zcode-skill-marketplace/1.0" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new SkillMarketplaceError(
      "network",
      `skills.sh request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return response;
}

function isSafeSource(source: string): boolean {
  const parts = source.split("/");
  return (
    parts.length === 2 &&
    SAFE_SEGMENT.test(parts[0] ?? "") &&
    SAFE_SEGMENT.test(parts[1] ?? "")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
