// ============================================================
// skills.sh marketplace client
// ============================================================
// Public, credential-free endpoints used by the official `skills` CLI:
//   GET https://skills.sh/api/search?q=<query>[&owner=<owner>]
//   GET https://skills.sh/api/download/<owner>/<repo>/<skillId>
// Skill content is untrusted input: we validate every relative path, cap the
// snapshot size, and never execute anything from the downloaded bundle.

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type {
  SkillMarketplaceSearchItem,
  SkillMarketplaceSearchRequest,
  SkillMarketplaceSearchResult,
  SkillOperationOptions,
} from "@zcode/contracts";

const SKILLS_SH_ORIGIN = "https://skills.sh";
const SEARCH_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const MAX_SEARCH_QUERY_LENGTH = 200;
const MAX_SEARCH_LIMIT = 50;
const MAX_SNAPSHOT_FILES = 500;
const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;
const MAX_SNAPSHOT_FILE_BYTES = 5 * 1024 * 1024;
const SAFE_SOURCE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;

interface SkillsShSnapshotFile {
  path: string;
  contents: string;
}

interface SkillsShSnapshot {
  files: SkillsShSnapshotFile[];
  hash?: string;
}

interface SkillsShSearchPayload {
  skills?: unknown;
}

export function resolveMarketplaceInstallRoot(params: {
  workingDirectory: string;
  scope: "workspace" | "user";
  homeDirectory?: string;
}): string {
  const base =
    params.scope === "user" ? (params.homeDirectory ?? homedir()) : resolve(params.workingDirectory);
  return join(base, ".agents", "skills");
}

export async function searchSkillsSh(
  request: SkillMarketplaceSearchRequest,
  options?: SkillOperationOptions,
): Promise<SkillMarketplaceSearchResult> {
  const query = request.query.trim();
  if (query.length < 2 || query.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new Error(`skills.sh search query must be 2-${MAX_SEARCH_QUERY_LENGTH} characters`);
  }
  const owner = request.owner?.trim().toLowerCase();
  if (owner !== undefined && !GITHUB_OWNER.test(owner)) {
    throw new Error("skills.sh owner must be a valid GitHub owner");
  }
  const limit = normalizeLimit(request.limit);
  const params = new URLSearchParams({ q: query });
  if (owner) params.set("owner", owner);
  const response = await fetchWithTimeout(
    `${SKILLS_SH_ORIGIN}/api/search?${params.toString()}`,
    SEARCH_TIMEOUT_MS,
    options?.signal,
  );
  if (!response.ok) {
    throw new Error(`skills.sh search failed with HTTP ${response.status}`);
  }
  const payload = (await response.json()) as SkillsShSearchPayload;
  const rawSkills = Array.isArray(payload.skills) ? payload.skills : [];
  const items = rawSkills
    .flatMap((raw): SkillMarketplaceSearchItem[] => {
      if (!isRecord(raw)) return [];
      const source = readString(raw.source);
      const skillId = readString(raw.skillId);
      const name = readString(raw.name);
      if (!source || !skillId || !name) return [];
      if (!isSafeSource(source) || !SAFE_SKILL_ID.test(skillId)) return [];
      const installs = typeof raw.installs === "number" && raw.installs >= 0 ? raw.installs : undefined;
      return [
        {
          id: `${source}/${skillId}`,
          source,
          skillId,
          name: sanitizeModelFacingText(name),
          ...(installs === undefined ? {} : { installs }),
          installed: false,
        },
      ];
    })
    .sort((left, right) => (right.installs ?? 0) - (left.installs ?? 0))
    .slice(0, limit);
  return { query, items };
}

export async function downloadSkillsShSnapshot(
  request: { source: string; skillId: string },
  options?: SkillOperationOptions,
): Promise<SkillsShSnapshot> {
  const source = request.source.trim();
  if (!isSafeSource(source)) {
    throw new Error("skills.sh source must be <owner>/<repo>");
  }
  const skillId = request.skillId.trim();
  if (!SAFE_SKILL_ID.test(skillId)) {
    throw new Error("skills.sh skillId contains unsupported characters");
  }
  const [owner, repo] = source.split("/");
  const url = `${SKILLS_SH_ORIGIN}/api/download/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}/${encodeURIComponent(skillId)}`;
  const response = await fetchWithTimeout(url, DOWNLOAD_TIMEOUT_MS, options?.signal);
  if (!response.ok) {
    throw new Error(`skills.sh download failed with HTTP ${response.status}`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_SNAPSHOT_BYTES) {
    throw new Error("skills.sh snapshot exceeds the 10 MiB limit");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("skills.sh snapshot is not valid JSON");
  }
  validateSkillSnapshot(payload);
  return payload;
}

function validateSkillSnapshot(snapshot: unknown): asserts snapshot is SkillsShSnapshot {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.files)) {
    throw new Error("skills.sh snapshot must contain a files array");
  }
  if (snapshot.files.length === 0) {
    throw new Error("skills.sh snapshot contains no files");
  }
  if (snapshot.files.length > MAX_SNAPSHOT_FILES) {
    throw new Error(`skills.sh snapshot exceeds ${MAX_SNAPSHOT_FILES} files`);
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const file of snapshot.files) {
    if (!isRecord(file) || typeof file.path !== "string" || typeof file.contents !== "string") {
      throw new Error("skills.sh snapshot contains an invalid file entry");
    }
    const path = normalizeSnapshotPath(file.path);
    if (seen.has(path)) {
      throw new Error(`skills.sh snapshot contains duplicate path: ${path}`);
    }
    seen.add(path);
    const fileBytes = Buffer.byteLength(file.contents, "utf8");
    if (fileBytes > MAX_SNAPSHOT_FILE_BYTES) {
      throw new Error(`skills.sh snapshot file exceeds 5 MiB: ${path}`);
    }
    totalBytes += fileBytes;
    if (totalBytes > MAX_SNAPSHOT_BYTES) {
      throw new Error("skills.sh snapshot exceeds the 10 MiB limit");
    }
  }
  if (!seen.has("SKILL.md")) {
    throw new Error("skills.sh snapshot must contain SKILL.md at its root");
  }
}

export async function writeSkillSnapshot(params: {
  root: string;
  source: string;
  skillId: string;
  snapshot: SkillsShSnapshot;
  overwrite: boolean;
}): Promise<{ path: string; filesWritten: number; alreadyInstalled: boolean }> {
  const target = join(params.root, params.skillId);
  assertInsideRoot(params.root, target);
  if (existsSync(target)) {
    if (!params.overwrite) {
      return { path: target, filesWritten: 0, alreadyInstalled: true };
    }
    // Only a marketplace-managed directory may be replaced. A hand-written skill
    // with the same slug must not be deleted by an agent install.
    const meta = await readMarketplaceMeta(target);
    if (!meta || meta.source !== params.source) {
      throw new Error(
        `refusing to overwrite non-marketplace skill at ${target}; remove it manually or choose another id`,
      );
    }
    await rm(target, { recursive: true, force: true });
  }
  await mkdir(target, { recursive: true });
  for (const file of params.snapshot.files) {
    const destination = join(target, file.path);
    assertInsideRoot(target, destination);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.contents, "utf8");
  }
  const metadata = {
    source: params.source,
    skillId: params.skillId,
    ...(params.snapshot.hash ? { hash: params.snapshot.hash } : {}),
    installedAt: new Date().toISOString(),
    manager: "skills.sh",
  };
  await writeFile(join(target, "_meta.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return { path: target, filesWritten: params.snapshot.files.length + 1, alreadyInstalled: false };
}

async function readMarketplaceMeta(
  target: string,
): Promise<{ source?: string; skillId?: string } | null> {
  try {
    const parsed = JSON.parse(await readFile(join(target, "_meta.json"), "utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    throw new Error(`skills.sh search limit must be 1-${MAX_SEARCH_LIMIT}`);
  }
  return limit;
}

function isSafeSource(source: string): boolean {
  const parts = source.split("/");
  return (
    parts.length === 2 &&
    SAFE_SOURCE_SEGMENT.test(parts[0] ?? "") &&
    SAFE_SOURCE_SEGMENT.test(parts[1] ?? "")
  );
}

function normalizeSnapshotPath(rawPath: string): string {
  if (rawPath.length === 0 || rawPath.includes("\0") || rawPath.includes("\\")) {
    throw new Error("skills.sh snapshot contains an unsafe path");
  }
  if (isAbsolute(rawPath)) {
    throw new Error("skills.sh snapshot contains an absolute path");
  }
  const normalized = posix.normalize(rawPath);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error("skills.sh snapshot contains a path traversal");
  }
  return normalized;
}

function assertInsideRoot(root: string, target: string): void {
  const relativePath = relative(root, target);
  if (relativePath.length === 0) return;
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error("skills.sh snapshot path escapes the skill directory");
  }
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("skills.sh request timed out")), timeoutMs);
  const abortHandler = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abortHandler, { once: true });
  try {
    return await fetch(url, {
      headers: { "user-agent": "zcode-skill-marketplace/1.0" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortHandler);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function sanitizeModelFacingText(value: string): string {
  return value.replace(/[\r\n\t]+/gu, " ").slice(0, 200);
}
