#!/usr/bin/env node
// ============================================================
// skills.sh -> .agents/skills sync
// ============================================================
// Uses the same public, credential-free endpoints as `npx skills`:
//   /api/search?q=... and /api/download/<owner>/<repo>/<skillId>.
// External skill content is untrusted: paths are validated, snapshots are
// size-capped, and nothing is executed. Existing hand-written skills are
// never overwritten.

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DEST = join(REPO_ROOT, ".agents", "skills");
const BUNDLED_SKILLS_DIR = join(
  REPO_ROOT,
  "apps",
  "zcode-cli",
  "packages",
  "bundled-skills",
  "skills",
);
const LOCK_PATH = join(REPO_ROOT, "skills-sh.lock.json");
const SKILLS_SH_ORIGIN = "https://skills.sh";
const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const SAFE_SOURCE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const DEFAULT_QUERIES = [
  "react",
  "nextjs",
  "typescript",
  "testing",
  "design",
  "frontend",
  "backend",
  "security",
  "documentation",
  "git",
  "python",
  "rust",
  "go",
  "docker",
  "kubernetes",
  "aws",
  "database",
  "api",
  "agent",
  "workflow",
  "pdf",
  "spreadsheet",
  "presentation",
  "animation",
  "mobile",
  "accessibility",
  "performance",
  "debugging",
  "refactoring",
];
const CURATED_SKILLS = [
  "vercel-labs/skills/find-skills",
  "vercel-labs/agent-skills/vercel-react-native-skills",
  "vercel-labs/agent-skills/vercel-react-view-transitions",
  "vercel-labs/agent-skills/web-design-guidelines",
  "anthropics/skills/frontend-design",
  "anthropics/skills/skill-creator",
  "emilkowalski/skills/apple-design",
  "emilkowalski/skills/emil-design-eng",
  "emilkowalski/skills/review-animations",
  "designed-by-ai/skills/design-mobile-apps",
  "prisma/skills/prisma-client-api",
  "google/agents-cli/google-agents-cli-adk-code",
  "google/agents-cli/google-agents-cli-observability",
  "google/agents-cli/google-agents-cli-scaffold",
  "mattpocock/skills/grill-with-docs",
  "mattpocock/skills/triage",
  "mattpocock/skills/diagnosing-bugs",
  "mattpocock/skills/code-review",
  "mattpocock/skills/wayfinder",
  "mattpocock/skills/wizard",
];

function parseArgs(argv) {
  const options = {
    dest: DEFAULT_DEST,
    limit: 20,
    minInstalls: 1000,
    queries: DEFAULT_QUERIES,
    skills: CURATED_SKILLS,
    exclude: undefined,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--dest") options.dest = resolve(argv[++index]);
    else if (arg === "--limit") options.limit = Number(argv[++index]);
    else if (arg === "--min-installs") options.minInstalls = Number(argv[++index]);
    else if (arg === "--queries") {
      options.queries = String(argv[++index]).split(",").filter(Boolean);
      options.skills = [];
    } else if (arg === "--skills") options.skills = String(argv[++index]).split(",").filter(Boolean);
    else if (arg === "--exclude") options.exclude = new RegExp(String(argv[++index]), "u");
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: node scripts/sync-skills-sh.mjs [--limit 20] [--min-installs 1000] [--dest .agents/skills] [--queries a,b,c] [--skills owner/repo/skill,...] [--exclude regex] [--dry-run]",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new Error("--limit must be 1-100");
  }
  if (!Number.isInteger(options.minInstalls) || options.minInstalls < 0) {
    throw new Error("--min-installs must be >= 0");
  }
  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, timeoutMs) {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, {
      headers: { "user-agent": "zcode-skills-sync/1.0" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return response.json();
    lastStatus = response.status;
    if (response.status !== 429 && response.status < 500) break;
    await sleep(1000 * (attempt + 1));
  }
  throw new Error(`${url} returned HTTP ${lastStatus}`);
}

function parseSkillSpec(spec) {
  const parts = spec.split("/");
  if (parts.length < 3) throw new Error(`Invalid --skills entry: ${spec}`);
  const source = parts.slice(0, 2).join("/");
  const skillId = parts.slice(2).join("/");
  if (!SAFE_SOURCE_SEGMENT.test(parts[0] ?? "") || !SAFE_SOURCE_SEGMENT.test(parts[1] ?? "")) {
    throw new Error(`Invalid --skills source: ${spec}`);
  }
  if (!SAFE_SKILL_ID.test(skillId)) throw new Error(`Invalid --skills skillId: ${spec}`);
  return { id: `${source}/${skillId}`, source, skillId, name: skillId, installs: 0 };
}

async function search(query) {
  const url = `${SKILLS_SH_ORIGIN}/api/search?q=${encodeURIComponent(query)}`;
  const payload = await fetchJson(url, 20_000);
  return Array.isArray(payload.skills) ? payload.skills : [];
}

async function downloadSnapshot(source, skillId) {
  const [owner, repo, extra] = source.split("/");
  if (
    extra !== undefined ||
    !SAFE_SOURCE_SEGMENT.test(owner ?? "") ||
    !SAFE_SOURCE_SEGMENT.test(repo ?? "") ||
    !SAFE_SKILL_ID.test(skillId)
  ) {
    throw new Error(`Invalid skills.sh source/skillId: ${source}/${skillId}`);
  }
  const url = `${SKILLS_SH_ORIGIN}/api/download/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(skillId)}`;
  const payload = await fetchJson(url, 30_000);
  validateSnapshot(payload);
  return payload;
}

function validateSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.files) || snapshot.files.length === 0) {
    throw new Error("Snapshot contains no files");
  }
  if (snapshot.files.length > MAX_FILES) throw new Error("Snapshot has too many files");
  const seen = new Set();
  let totalBytes = 0;
  for (const file of snapshot.files) {
    if (!file || typeof file.path !== "string" || typeof file.contents !== "string") {
      throw new Error("Snapshot contains an invalid file entry");
    }
    const path = normalizeSnapshotPath(file.path);
    if (seen.has(path)) throw new Error(`Snapshot has duplicate path: ${path}`);
    seen.add(path);
    const bytes = Buffer.byteLength(file.contents, "utf8");
    if (bytes > MAX_FILE_BYTES) throw new Error(`Snapshot file is too large: ${path}`);
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Snapshot exceeds the size limit");
  }
  if (!seen.has("SKILL.md")) throw new Error("Snapshot must contain SKILL.md at its root");
}

function normalizeSnapshotPath(rawPath) {
  if (!rawPath || rawPath.includes("\0") || rawPath.includes("\\") || isAbsolute(rawPath)) {
    throw new Error("Snapshot contains an unsafe path");
  }
  const normalized = posix.normalize(rawPath);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error("Snapshot contains a path traversal");
  }
  return normalized;
}

async function readExistingSkillNames(directories) {
  const names = new Set();
  for (const dest of directories) {
    if (!existsSync(dest)) continue;
    for (const entry of await readdir(dest, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const content = await readFile(join(dest, entry.name, "SKILL.md"), "utf8");
        const match = content.match(/^---[\s\S]*?\nname:\s*(.+)$/m);
        if (match?.[1]) names.add(match[1].trim().replace(/^["']|["']$/gu, ""));
      } catch {
        // A directory without SKILL.md is not a skill; ignore it.
      }
    }
  }
  return names;
}

async function readPluginSkillNames() {
  const packagesRoot = join(REPO_ROOT, "apps", "zcode-cli", "packages");
  const names = new Set();
  for (const entry of await readdir(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith("-plugin")) continue;
    for (const name of await readExistingSkillNames([
      join(packagesRoot, entry.name, "skills"),
    ])) {
      names.add(name);
    }
  }
  return names;
}

async function installSkill(dest, item, snapshot) {
  const target = join(dest, item.skillId);
  const relativePath = relative(dest, target);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error("Install target escapes the destination");
  }
  await mkdir(target, { recursive: true });
  for (const file of snapshot.files) {
    const filePath = join(target, file.path);
    const fileRelative = relative(target, filePath);
    if (fileRelative === ".." || fileRelative.startsWith(`..${sep}`) || isAbsolute(fileRelative)) {
      throw new Error("Snapshot path escapes the skill directory");
    }
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, file.contents, "utf8");
  }
  await writeFile(
    join(target, "_meta.json"),
    `${JSON.stringify(
      {
        source: item.source,
        skillId: item.skillId,
        name: item.name,
        installs: item.installs,
        ...(snapshot.hash ? { hash: snapshot.hash } : {}),
        installedAt: new Date().toISOString(),
        manager: "skills.sh",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function readLock() {
  if (!existsSync(LOCK_PATH)) return { version: 1, skills: [] };
  try {
    const parsed = JSON.parse(await readFile(LOCK_PATH, "utf8"));
    return { version: 1, skills: Array.isArray(parsed.skills) ? parsed.skills : [] };
  } catch {
    return { version: 1, skills: [] };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const existingNames = new Set([
    ...(await readExistingSkillNames([options.dest, BUNDLED_SKILLS_DIR])),
    ...(await readPluginSkillNames()),
  ]);
  const byId = new Map();
  for (const spec of options.skills) {
    const item = parseSkillSpec(spec);
    byId.set(item.id, item);
  }
  for (const query of options.skills.length > 0 ? [] : options.queries) {
    try {
      for (const raw of await search(query)) {
        if (!raw || typeof raw.source !== "string" || typeof raw.skillId !== "string") continue;
        if (!SAFE_SOURCE_SEGMENT.test(raw.source.split("/")[0] ?? "")) continue;
        if (!SAFE_SOURCE_SEGMENT.test(raw.source.split("/")[1] ?? "")) continue;
        if (!SAFE_SKILL_ID.test(raw.skillId)) continue;
        const installs = typeof raw.installs === "number" ? raw.installs : 0;
        if (installs < options.minInstalls) continue;
        const id = `${raw.source}/${raw.skillId}`;
        if (!byId.has(id)) {
          byId.set(id, {
            id,
            source: raw.source,
            skillId: raw.skillId,
            name: typeof raw.name === "string" ? raw.name : raw.skillId,
            installs,
          });
        }
      }
    } catch (error) {
      console.warn(`search failed for "${query}": ${error.message}`);
    }
  }
  const selected = [...byId.values()]
    .sort((left, right) => right.installs - left.installs)
    .filter(
      (item) =>
        !existingNames.has(item.name) &&
        !existsSync(join(options.dest, item.skillId)) &&
        (!options.exclude || !options.exclude.test(item.id)),
    )
    .slice(0, options.limit);
  if (selected.length === 0) {
    console.log("No new skills to install.");
    return;
  }
  console.log(`Installing ${selected.length} skills into ${options.dest}`);
  const lock = await readLock();
  let failed = 0;
  for (const item of selected) {
    console.log(`- ${item.id} (${item.installs} installs)`);
    if (options.dryRun) continue;
    try {
      const snapshot = await downloadSnapshot(item.source, item.skillId);
      await installSkill(options.dest, item, snapshot);
      lock.skills = [
        ...lock.skills.filter((entry) => entry.id !== item.id),
        {
          id: item.id,
          source: item.source,
          skillId: item.skillId,
          name: item.name,
          installs: item.installs,
          ...(snapshot.hash ? { hash: snapshot.hash } : {}),
        },
      ];
    } catch (error) {
      failed += 1;
      console.warn(`  failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!options.dryRun) {
    await writeFile(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
    console.log(`Updated ${LOCK_PATH}`);
  }
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
