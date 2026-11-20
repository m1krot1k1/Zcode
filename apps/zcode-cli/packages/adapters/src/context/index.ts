// ============================================================
// Node Context Source Adapter
// ============================================================

import { open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { arch, homedir, release } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { formatLocalIsoDate } from "@zcode/contracts";
import type {
  ContextSourceDiagnostic,
  ContextSourcePort,
  ContextSourceRequest,
  ContextSourceSnapshot,
  EnvInfo,
  Logger,
  PackageManager,
  ProjectContext,
  ProjectType,
  ResolvedHarnessRule,
  ResolvedUserInstructionSource,
  ResolvedUserInstructions,
  ResolvedWorkspaceRule,
  UserInstructionsOptions,
} from "@zcode/contracts";
import { resolveGitSnapshot } from "./git-snapshot.js";
import type { WorkspaceFactsIo } from "./workspace-facts.js";
import type { WorkspaceFactsCache } from "./workspace-facts-cache.js";
import {
  createWorkspaceFactsCache,
  resolveWorkspaceProjectContext,
} from "./workspace-facts-wiring.js";

const DEFAULT_PRIORITY_FILES = ["AGENTS.md"];
const DEFAULT_MAX_BYTES = 100 * 1024;
const WORKSPACE_RULE_DIRECTORIES = [".zcode/rules"] as const;
const WORKSPACE_RULE_MAX_BYTES = 64 * 1024;
const WORKSPACE_RULE_TOTAL_MAX_BYTES = 256 * 1024;
const WORKSPACE_RULE_MAX_GLOBS = 32;
const WORKSPACE_RULE_MAX_GLOB_EXPANSIONS = 64;
const BUNDLED_HARNESS_RULE_DIRECTORY_CANDIDATES = [
  "packages/bundled-skills/rules",
  "../bundled-skills/rules",
  "../../bundled-skills/rules",
  "../../../bundled-skills/rules",
] as const;
const BUNDLED_HARNESS_RULE_MAX_BYTES = 16 * 1024;
const BUNDLED_HARNESS_RULE_TOTAL_MAX_BYTES = 64 * 1024;

export interface NodeContextSourceAdapterOptions {
  env?: NodeJS.ProcessEnv;
  /** Explicit package asset root; normally supplied by bootstrap for Desktop and SEA. */
  bundledHarnessRulesDirectory?: string;
  /**
   * Cache root workspace facts. `false` отключает персистентный кеш.
   * По умолчанию — `$HOME/.zcode/v2/cache/workspace-facts`, если HOME/USERPROFILE
   * резолвится из env адаптера; иначе кеш отключён (fail-open без записи в чужой home).
   */
  workspaceFactsCacheRoot?: string | false;
  /** TTL записи кеша; по умолчанию 24 часа. */
  workspaceFactsTtlMs?: number;
  /** Test seam: подмена IO с подсчётом чтений. */
  workspaceFactsIo?: WorkspaceFactsIo;
  now?: () => number;
  logger?: Pick<Logger, "debug" | "warn">;
}

export class NodeContextSourceAdapter implements ContextSourcePort {
  private readonly env: NodeJS.ProcessEnv;
  private readonly bundledHarnessRulesDirectory?: string;
  private readonly workspaceFactsCache: WorkspaceFactsCache | undefined;
  private readonly now: () => number;

  constructor(options: NodeContextSourceAdapterOptions = {}) {
    this.env = options.env ?? process.env;
    this.bundledHarnessRulesDirectory = options.bundledHarnessRulesDirectory;
    this.now = options.now ?? Date.now;
    this.workspaceFactsCache = createWorkspaceFactsCache({
      env: this.env,
      now: this.now,
      workspaceFactsCacheRoot: options.workspaceFactsCacheRoot,
      workspaceFactsTtlMs: options.workspaceFactsTtlMs,
      workspaceFactsIo: options.workspaceFactsIo,
      logger: options.logger,
    });
  }

  async resolveContextSources(request: ContextSourceRequest): Promise<ContextSourceSnapshot> {
    const workingDirectory = resolve(request.workingDirectory);
    const diagnostics: ContextSourceDiagnostic[] = [];
    const projectRoot = await findProjectRoot(workingDirectory);

    const envInfo =
      request.envInfo ??
      (await this.detectEnvInfo(workingDirectory, request.effectiveShellDisplayName));
    const userInstructions = request.userInstructions
      ? await resolveUserInstructions(
          {
            ...request.userInstructions,
            workingDirectory: request.userInstructions.workingDirectory ?? workingDirectory,
            projectRoot: request.userInstructions.projectRoot ?? projectRoot ?? undefined,
          },
          diagnostics,
          this.env,
        )
      : undefined;
    const workspaceRules = await resolveWorkspaceRules(
      projectRoot ?? workingDirectory,
      [...(request.ruleTargetPaths ?? []), ...(request.userInstructions?.ruleTargetPaths ?? [])],
      diagnostics,
    );
    const bundledHarnessRules = await resolveBundledHarnessRules(
      this.bundledHarnessRulesDirectory,
      diagnostics,
    );
    const projectContext =
      request.projectContext ??
      (projectRoot ? await this.resolveProjectContext(projectRoot, request, envInfo) : undefined);

    return {
      workingDirectory,
      envInfo,
      currentDate: request.currentDate ?? formatLocalIsoDate(new Date()),
      userInstructions,
      ...(bundledHarnessRules.length > 0 ? { bundledHarnessRules } : {}),
      ...(workspaceRules.length > 0 ? { workspaceRules } : {}),
      projectContext,
      diagnostics,
    };
  }

  /**
   * Связка с workspace facts живёт в ./workspace-facts-wiring:
   * derivation identity key, git-подпись и fail-open fallback — там.
   */
  private async resolveProjectContext(
    projectRoot: string,
    request: ContextSourceRequest,
    envInfo: EnvInfo,
  ): Promise<ProjectContext> {
    return resolveWorkspaceProjectContext({
      cache: this.workspaceFactsCache,
      projectRoot,
      request,
      envInfo,
      now: this.now,
      fallback: detectProjectContextLegacy,
    });
  }

  private async detectEnvInfo(
    workingDirectory: string,
    effectiveShellDisplayName?: string,
  ): Promise<EnvInfo> {
    const shellPath = this.env.SHELL ?? this.env.ComSpec ?? this.env.COMSPEC ?? "";
    const shell = effectiveShellDisplayName ?? (shellPath ? basename(shellPath) : "unknown");
    const gitSnapshot = await resolveGitSnapshot(workingDirectory);
    return {
      cwd: workingDirectory,
      platform: process.platform,
      shell,
      osVersion: `${process.platform} ${release()} ${arch()}`,
      nodeVersion: process.version,
      ...gitSnapshot,
    };
  }
}

async function resolveBundledHarnessRules(
  configuredDirectory: string | undefined,
  diagnostics: ContextSourceDiagnostic[],
): Promise<ResolvedHarnessRule[]> {
  const entryDirectory = process.argv[1] ? dirname(resolve(process.argv[1])) : undefined;
  const candidates = configuredDirectory
    ? [resolve(configuredDirectory)]
    : [
        ...BUNDLED_HARNESS_RULE_DIRECTORY_CANDIDATES.map((candidate) => resolve(candidate)),
        ...(entryDirectory
          ? BUNDLED_HARNESS_RULE_DIRECTORY_CANDIDATES.map((candidate) =>
              resolve(entryDirectory, candidate),
            )
          : []),
      ];
  let canonicalRoot: string | undefined;
  for (const candidate of candidates) {
    try {
      canonicalRoot = await realpath(candidate);
      break;
    } catch {
      // A source tree can be run from several package directories. Try the next known layout.
    }
  }
  if (!canonicalRoot) {
    if (configuredDirectory) {
      diagnostics.push({
        code: "bundled_harness_rules_missing",
        message: "The required bundled harness rules directory could not be resolved.",
        path: configuredDirectory,
      });
    }
    return [];
  }

  let entries;
  try {
    entries = await readdir(canonicalRoot, { withFileTypes: true });
  } catch (error) {
    diagnostics.push({
      code: "bundled_harness_rules_read_failed",
      message: error instanceof Error ? error.message : "Failed to list bundled harness rules.",
      path: canonicalRoot,
    });
    return [];
  }

  const resolved: ResolvedHarnessRule[] = [];
  let totalBytes = 0;
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".mdc"))) {
    const rulePath = join(canonicalRoot, entry.name);
    try {
      const canonicalPath = await realpath(rulePath);
      if (!isContainedPath(canonicalRoot, canonicalPath)) {
        diagnostics.push({
          code: "bundled_harness_rule_path_escape",
          message: "Bundled harness rule resolves outside its package directory and was ignored.",
          path: rulePath,
        });
        continue;
      }
      const info = await stat(canonicalPath);
      const remainingBytes = BUNDLED_HARNESS_RULE_TOTAL_MAX_BYTES - totalBytes;
      if (!info.isFile() || remainingBytes <= 0) {
        if (remainingBytes <= 0) {
          diagnostics.push({
            code: "bundled_harness_rules_size_limit",
            message:
              "Further bundled harness rules were ignored after reaching the aggregate size limit.",
            path: rulePath,
          });
          break;
        }
        continue;
      }
      const maxBytes = Math.min(BUNDLED_HARNESS_RULE_MAX_BYTES, remainingBytes);
      const { content, bytesRead } = await readBoundedText(canonicalPath, maxBytes);
      totalBytes += bytesRead;
      const parsed = parseWorkspaceRule(content, rulePath, diagnostics);
      if (!parsed) continue;
      if (!parsed.alwaysApply || parsed.globs.length > 0 || !parsed.body) {
        diagnostics.push({
          code: "bundled_harness_rule_not_always_on",
          message:
            "Bundled harness rules must have alwaysApply: true, no globs, and a non-empty body.",
          path: rulePath,
        });
        continue;
      }
      resolved.push({
        id: entry.name.slice(0, -".mdc".length),
        ...(parsed.description ? { description: parsed.description } : {}),
        content: parsed.body,
      });
    } catch (error) {
      diagnostics.push({
        code: "bundled_harness_rule_read_failed",
        message: error instanceof Error ? error.message : "Failed to read bundled harness rule.",
        path: rulePath,
      });
    }
  }
  return resolved.sort((left, right) => left.id.localeCompare(right.id));
}

async function resolveWorkspaceRules(
  projectRoot: string,
  rawTargets: readonly string[],
  diagnostics: ContextSourceDiagnostic[],
): Promise<ResolvedWorkspaceRule[]> {
  const targets = normalizeRuleTargetPaths(projectRoot, rawTargets, diagnostics);
  const candidates = new Map<string, { path: string; name: string; root: string }>();
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(projectRoot);
  } catch {
    return [];
  }

  for (const directory of WORKSPACE_RULE_DIRECTORIES) {
    const directoryPath = join(canonicalRoot, directory);
    let canonicalDirectory: string;
    let entries;
    try {
      canonicalDirectory = await realpath(directoryPath);
      if (!isContainedPath(canonicalRoot, canonicalDirectory)) {
        diagnostics.push({
          code: "workspace_rule_path_escape",
          message: "Rules directory resolves outside the workspace and was ignored.",
          path: directoryPath,
        });
        continue;
      }
      entries = await readdir(canonicalDirectory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.name.endsWith(".mdc")) continue;
      candidates.set(join(canonicalDirectory, entry.name), {
        path: join(canonicalDirectory, entry.name),
        name: entry.name,
        root: canonicalRoot,
      });
    }
  }

  const resolved: ResolvedWorkspaceRule[] = [];
  let totalBytes = 0;
  for (const candidate of [...candidates.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(candidate.path);
      if (!isContainedPath(candidate.root, canonicalPath)) {
        diagnostics.push({
          code: "workspace_rule_path_escape",
          message: "Rule file resolves outside the workspace and was ignored.",
          path: candidate.path,
        });
        continue;
      }
      const info = await stat(canonicalPath);
      if (!info.isFile()) continue;
      const remainingBytes = WORKSPACE_RULE_TOTAL_MAX_BYTES - totalBytes;
      if (remainingBytes <= 0) {
        diagnostics.push({
          code: "workspace_rule_total_size_limit",
          message: "Further workspace rules were ignored after reaching the aggregate size limit.",
          path: candidate.path,
        });
        break;
      }
      const maxBytes = Math.min(WORKSPACE_RULE_MAX_BYTES, remainingBytes);
      const { content, bytesRead } = await readBoundedText(canonicalPath, maxBytes);
      totalBytes += bytesRead;
      const parsed = parseWorkspaceRule(content, candidate.path, diagnostics);
      if (!parsed) continue;
      const appliedBy = parsed.alwaysApply
        ? "alwaysApply"
        : parsed.globs.some((glob) =>
              targets.some((target) => matchesWorkspaceRuleGlob(glob, target)),
            )
          ? "glob"
          : undefined;
      if (!appliedBy) continue;
      resolved.push({
        filePath: canonicalPath,
        fileName: candidate.name,
        ...(parsed.description ? { description: parsed.description } : {}),
        globs: parsed.globs,
        alwaysApply: parsed.alwaysApply,
        appliedBy,
        content: parsed.body,
        bytesRead,
        sizeBytes: info.size,
        truncated: info.size > maxBytes,
      });
    } catch (error) {
      diagnostics.push({
        code: "workspace_rule_read_failed",
        message: error instanceof Error ? error.message : "Failed to read workspace rule.",
        path: candidate.path,
      });
    }
  }
  return resolved;
}

async function readBoundedText(
  path: string,
  maxBytes: number,
): Promise<{ content: string; bytesRead: number }> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return { content: buffer.subarray(0, bytesRead).toString("utf8"), bytesRead };
  } finally {
    await handle.close();
  }
}

function normalizeRuleTargetPaths(
  projectRoot: string,
  rawTargets: readonly string[],
  diagnostics: ContextSourceDiagnostic[],
): string[] {
  const targets = new Set<string>();
  for (const rawTarget of rawTargets) {
    const normalized = rawTarget.replaceAll("\\", "/").trim();
    if (
      !normalized ||
      normalized.startsWith("/") ||
      /^[A-Za-z]:\//u.test(normalized) ||
      isAbsolute(rawTarget) ||
      normalized.split("/").includes("..")
    ) {
      diagnostics.push({
        code: "workspace_rule_target_invalid",
        message: "Rule target must be a workspace-relative path.",
        path: rawTarget,
      });
      continue;
    }
    const absolutePath = resolve(projectRoot, normalized);
    const relativePath = relative(projectRoot, absolutePath);
    if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
      diagnostics.push({
        code: "workspace_rule_target_invalid",
        message: "Rule target resolves outside the workspace and was ignored.",
        path: rawTarget,
      });
      continue;
    }
    targets.add(relativePath.split(sep).join("/"));
  }
  return [...targets];
}

function isContainedPath(root: string, path: string): boolean {
  const pathRelativeToRoot = relative(root, path);
  return (
    pathRelativeToRoot === "" ||
    (pathRelativeToRoot !== ".." &&
      !pathRelativeToRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathRelativeToRoot))
  );
}

function parseWorkspaceRule(
  source: string,
  filePath: string,
  diagnostics: ContextSourceDiagnostic[],
): { description?: string; alwaysApply: boolean; globs: string[]; body: string } | undefined {
  const lines = source.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  if (lines[0] !== "---") {
    diagnostics.push({
      code: "workspace_rule_frontmatter_missing",
      message: "Rule has no YAML frontmatter and was ignored.",
      path: filePath,
    });
    return undefined;
  }
  const end = lines.indexOf("---", 1);
  if (end < 0) {
    diagnostics.push({
      code: "workspace_rule_frontmatter_malformed",
      message: "Rule frontmatter is not closed and was ignored.",
      path: filePath,
    });
    return undefined;
  }

  const metadata = new Map<string, string[]>();
  let currentKey: string | undefined;
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const listItem = line.match(/^\s+-\s+(.+)$/u);
    if (listItem && currentKey === "globs") {
      metadata.get("globs")?.push(listItem[1]!.trim());
      continue;
    }
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/u);
    if (!field) {
      diagnostics.push({
        code: "workspace_rule_frontmatter_malformed",
        message: "Rule frontmatter contains an unsupported line and was ignored.",
        path: filePath,
      });
      return undefined;
    }
    const key = field[1]!;
    if (metadata.has(key)) {
      diagnostics.push({
        code: "workspace_rule_frontmatter_duplicate",
        message: `Duplicate frontmatter field '${key}' was ignored.`,
        path: filePath,
      });
      return undefined;
    }
    currentKey = key;
    metadata.set(key, field[2] ? [field[2]!.trim()] : []);
  }

  for (const key of metadata.keys()) {
    if (!["description", "alwaysApply", "globs"].includes(key)) {
      diagnostics.push({
        code: "workspace_rule_frontmatter_unknown",
        message: `Unknown frontmatter field '${key}' was ignored.`,
        path: filePath,
      });
    }
  }
  const descriptionValue = metadata.get("description")?.[0];
  const description = descriptionValue ? parseRuleScalar(descriptionValue) : undefined;
  const alwaysApplyValue = metadata.get("alwaysApply")?.[0];
  let alwaysApply = false;
  if (alwaysApplyValue !== undefined) {
    const parsed = parseRuleScalar(alwaysApplyValue).toLowerCase();
    if (parsed !== "true" && parsed !== "false") {
      diagnostics.push({
        code: "workspace_rule_frontmatter_invalid",
        message: "alwaysApply must be true or false; rule was ignored.",
        path: filePath,
      });
      return undefined;
    }
    alwaysApply = parsed === "true";
  }
  const globs = (metadata.get("globs") ?? []).flatMap((value) => parseRuleList(value));
  if (
    globs.length > WORKSPACE_RULE_MAX_GLOBS ||
    globs.some(
      (glob) =>
        !glob ||
        glob.length > 512 ||
        glob.startsWith("/") ||
        /^[A-Za-z]:\//u.test(glob) ||
        glob.replaceAll("\\", "/").split("/").includes("..") ||
        (glob.match(/\{/gu)?.length ?? 0) !== (glob.match(/\}/gu)?.length ?? 0),
    )
  ) {
    diagnostics.push({
      code: "workspace_rule_glob_invalid",
      message: "Rule has an invalid glob pattern and was ignored.",
      path: filePath,
    });
    return undefined;
  }
  const body = lines
    .slice(end + 1)
    .join("\n")
    .trim();
  return { ...(description ? { description } : {}), alwaysApply, globs, body };
}

function parseRuleScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'"))
    return trimmed.slice(1, -1).replaceAll("''", "'");
  return trimmed.replace(/\s+#.*$/u, "").trim();
}

function parseRuleList(value: string): string[] {
  const trimmed = parseRuleScalar(value);
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [trimmed];
  return trimmed
    .slice(1, -1)
    .split(",")
    .map((item) => parseRuleScalar(item))
    .filter(Boolean);
}

function matchesWorkspaceRuleGlob(pattern: string, target: string): boolean {
  const expanded = expandWorkspaceRuleBraces(pattern);
  if (expanded.length > WORKSPACE_RULE_MAX_GLOB_EXPANSIONS) return false;
  return expanded.some((candidate) => globPatternToRegExp(candidate).test(target));
}

function expandWorkspaceRuleBraces(pattern: string): string[] {
  const match = pattern.match(/\{([^{}]+)\}/u);
  if (!match) return [pattern];
  const alternatives = match[1]!.split(",");
  if (alternatives.length < 2) return [pattern];
  const results: string[] = [];
  for (const part of alternatives) {
    results.push(
      ...expandWorkspaceRuleBraces(
        `${pattern.slice(0, match.index)}${part}${pattern.slice(match.index! + match[0].length)}`,
      ),
    );
    if (results.length > WORKSPACE_RULE_MAX_GLOB_EXPANSIONS) break;
  }
  return results;
}

function globPatternToRegExp(pattern: string): RegExp {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        expression += "(?:.*/)?";
      } else {
        expression += ".*";
      }
    } else if (char === "*") {
      expression += "[^/]*";
    } else if (char === "?") {
      expression += "[^/]";
    } else {
      expression += char.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
    }
  }
  return new RegExp(`${expression}$`, "u");
}

export function createNodeContextSourceAdapter(
  options: NodeContextSourceAdapterOptions = {},
): NodeContextSourceAdapter {
  return new NodeContextSourceAdapter(options);
}

async function resolveUserInstructions(
  options: UserInstructionsOptions,
  diagnostics: ContextSourceDiagnostic[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedUserInstructions | undefined> {
  const priorityFiles = options.priorityFiles ?? DEFAULT_PRIORITY_FILES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const projectRoot = options.projectRoot ?? (await findProjectRoot(options.workingDirectory));

  const defaultUserInstructionFile = await findDefaultUserInstructionFile(priorityFiles, env);
  const workspaceInstructionFile = await findInstructionFile(
    options.workingDirectory,
    projectRoot,
    priorityFiles,
  );
  const candidates = dedupeInstructionFileCandidates([
    defaultUserInstructionFile
      ? { ...defaultUserInstructionFile, scope: "user" as const }
      : undefined,
    workspaceInstructionFile
      ? { ...workspaceInstructionFile, scope: "workspace" as const }
      : undefined,
  ]);
  const sources: ResolvedUserInstructionSource[] = [];

  for (const candidate of candidates) {
    const source = await readInstructionSource(candidate, maxBytes, diagnostics);
    if (source) {
      sources.push(source);
    }
  }

  if (sources.length === 0) return undefined;

  return mergeInstructionSources(sources);
}

async function readFirstTextBytes(path: string, maxBytes: number): Promise<string> {
  const content = await readFile(path);
  return content.subarray(0, maxBytes).toString("utf8");
}

type InstructionFileCandidate = {
  filePath: string;
  fileName: string;
  scope: ResolvedUserInstructionSource["scope"];
};

function dedupeInstructionFileCandidates(
  candidates: Array<InstructionFileCandidate | undefined>,
): InstructionFileCandidate[] {
  const seen = new Set<string>();
  const deduped: InstructionFileCandidate[] = [];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = resolve(candidate.filePath);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }

  return deduped;
}

async function readInstructionSource(
  candidate: InstructionFileCandidate,
  maxBytes: number,
  diagnostics: ContextSourceDiagnostic[],
): Promise<ResolvedUserInstructionSource | undefined> {
  try {
    const info = await stat(candidate.filePath);
    const bytesToRead = Math.min(info.size, maxBytes);
    const content = await readFirstTextBytes(candidate.filePath, bytesToRead);
    return {
      scope: candidate.scope,
      filePath: candidate.filePath,
      fileName: candidate.fileName,
      content,
      bytesRead: Buffer.byteLength(content),
      sizeBytes: info.size,
      truncated: info.size > maxBytes,
    };
  } catch (error) {
    diagnostics.push({
      code: "user_instructions_read_failed",
      message: error instanceof Error ? error.message : "Failed to read user instructions",
      path: candidate.filePath,
    });
    return undefined;
  }
}

function mergeInstructionSources(
  sources: ResolvedUserInstructionSource[],
): ResolvedUserInstructions {
  const primary = sources.find((source) => source.scope === "workspace") ?? sources[0];
  const content = sources.map((source) => source.content).join("\n\n");

  return {
    filePath: primary.filePath,
    fileName: primary.fileName,
    content,
    bytesRead: sources.reduce((sum, source) => sum + source.bytesRead, 0),
    sizeBytes: sources.reduce((sum, source) => sum + source.sizeBytes, 0),
    truncated: sources.some((source) => source.truncated),
    sources,
  };
}

async function findInstructionFile(
  startDir: string,
  projectRoot: string | null,
  priorityFiles: string[],
): Promise<{ filePath: string; fileName: string } | undefined> {
  let current = resolve(startDir);

  while (true) {
    for (const fileName of priorityFiles) {
      const filePath = join(current, fileName);
      if (await isFile(filePath)) {
        return { filePath, fileName };
      }
    }

    if (current === projectRoot || current === dirname(current)) {
      break;
    }

    current = dirname(current);
  }

  return undefined;
}

async function findDefaultUserInstructionFile(
  priorityFiles: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ filePath: string; fileName: string } | undefined> {
  if (!priorityFiles.includes("AGENTS.md")) {
    return undefined;
  }

  const filePath = join(resolveUserHomeDir(env), ".zcode", "AGENTS.md");
  if (await isFile(filePath)) {
    return { filePath, fileName: "AGENTS.md" };
  }

  return undefined;
}

function resolveUserHomeDir(env: NodeJS.ProcessEnv): string {
  const envHome = env.HOME?.trim() || env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

async function detectProjectContextLegacy(projectRoot: string): Promise<ProjectContext> {
  let type: ProjectType = "unknown";
  let packageManager: PackageManager | undefined;
  let scripts: Record<string, string> | undefined;
  const buildFiles: string[] = [];

  const packageJsonPath = join(projectRoot, "package.json");
  if (await isFile(packageJsonPath)) {
    try {
      const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
        scripts?: unknown;
      };
      type = "node";
      if (pkg.scripts && typeof pkg.scripts === "object") {
        scripts = pkg.scripts as Record<string, string>;
      }
    } catch {
      type = "node";
    }
  }

  if (type === "unknown") {
    const pythonIndicators = ["requirements.txt", "pyproject.toml", "setup.py", "Pipfile"];
    for (const file of pythonIndicators) {
      if (await isFile(join(projectRoot, file))) {
        type = "python";
        break;
      }
    }
  }

  if (type === "unknown" && (await isFile(join(projectRoot, "Cargo.toml")))) {
    type = "rust";
  }
  if (type === "unknown" && (await isFile(join(projectRoot, "go.mod")))) {
    type = "go";
  }
  if (type === "unknown") {
    for (const file of ["pom.xml", "build.gradle", "build.gradle.kts"]) {
      if (await isFile(join(projectRoot, file))) {
        type = "java";
        break;
      }
    }
  }

  if (await isFile(join(projectRoot, "pnpm-lock.yaml"))) {
    packageManager = "pnpm";
  } else if (await isFile(join(projectRoot, "yarn.lock"))) {
    packageManager = "yarn";
  } else if (await isFile(join(projectRoot, "bun.lockb"))) {
    packageManager = "bun";
  } else if (await isFile(join(projectRoot, "package-lock.json"))) {
    packageManager = "npm";
  }

  for (const file of ["Makefile", "docker-compose.yml", "docker-compose.yaml", "Dockerfile"]) {
    if (await isFile(join(projectRoot, file))) {
      buildFiles.push(file);
    }
  }

  return {
    type,
    packageManager,
    scripts,
    buildFiles: buildFiles.length > 0 ? buildFiles : undefined,
  };
}

async function findProjectRoot(startDir: string): Promise<string | null> {
  let current = resolve(startDir);

  while (current !== dirname(current)) {
    if (await hasGitMarker(current)) return current;
    current = dirname(current);
  }

  return null;
}

async function hasGitMarker(directory: string): Promise<boolean> {
  try {
    await stat(join(directory, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}
