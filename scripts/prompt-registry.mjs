#!/usr/bin/env node
/**
 * Prompt registry gate: validates prompt source budgets, required rules, and
 * cross-layer duplication. It reads source files; it never calls a model.
 *
 * Usage:
 *   node scripts/prompt-registry.mjs --check [--strict] [--json]
 *   node scripts/prompt-registry.mjs --report
 */
import { execFile } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REGISTRY = path.join(REPO_ROOT, "config/prompts/registry.json");

function fail(message) {
  throw new Error(message);
}

function estimateTokens(chars) {
  return Math.ceil(chars / 4);
}

function normalizeLine(line) {
  return line.replace(/\s+/gu, " ").trim();
}

function isTrivialLine(line) {
  return (
    line.length < 80 ||
    line.startsWith("//") ||
    line.startsWith("/*") ||
    line.startsWith("*") ||
    line.startsWith("#") ||
    line.startsWith("```") ||
    line === "{" ||
    line === "}" ||
    line === "],"
  );
}

export function parseRegistry(registry) {
  if (!registry || typeof registry !== "object") fail("registry must be an object");
  if (registry.version !== 1) fail("registry.version must be 1");
  if (!Array.isArray(registry.entries) || registry.entries.length === 0) {
    fail("registry.entries must be a non-empty array");
  }
  const ids = new Set();
  for (const entry of registry.entries) {
    if (!entry || typeof entry !== "object") fail("registry entry must be an object");
    if (typeof entry.id !== "string" || entry.id.trim().length === 0) {
      fail("registry entry id must be a non-empty string");
    }
    if (ids.has(entry.id)) fail(`duplicate registry id: ${entry.id}`);
    ids.add(entry.id);
    if (typeof entry.path !== "string" || entry.path.trim().length === 0) {
      fail(`${entry.id}: path must be a non-empty string`);
    }
    if (!Number.isInteger(entry.maxChars) || entry.maxChars <= 0) {
      fail(`${entry.id}: maxChars must be a positive integer`);
    }
    if (
      entry.cacheHint !== undefined &&
      entry.cacheHint !== "stable" &&
      entry.cacheHint !== "dynamic"
    ) {
      fail(`${entry.id}: cacheHint must be stable or dynamic`);
    }
    if (
      entry.required !== undefined &&
      (!Array.isArray(entry.required) || entry.required.some((item) => typeof item !== "string"))
    ) {
      fail(`${entry.id}: required must be an array of strings`);
    }
  }
  return registry;
}

export async function checkRegistry(registry, root = REPO_ROOT) {
  const parsed = parseRegistry(registry);
  const entries = [];
  const allLines = new Map();

  for (const entry of parsed.entries) {
    const filePath = path.resolve(root, entry.path);
    let content;
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) fail(`${entry.id}: not a file: ${entry.path}`);
      content = await readFile(filePath, "utf8");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`${entry.id}:`)) throw error;
      fail(
        `${entry.id}: cannot read ${entry.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const chars = content.length;
    const estimatedTokens = estimateTokens(chars);
    const missingRequired = (entry.required ?? []).filter((marker) => !content.includes(marker));

    for (const line of content.split(/\r?\n/u)) {
      const normalized = normalizeLine(line);
      if (isTrivialLine(normalized)) continue;
      const owners = allLines.get(normalized) ?? [];
      owners.push(entry.id);
      allLines.set(normalized, owners);
    }

    entries.push({
      id: entry.id,
      path: entry.path,
      chars,
      estimatedTokens,
      maxChars: entry.maxChars,
      overBudget: chars > entry.maxChars,
      missingRequired,
      required: entry.required ?? [],
      cacheHint: entry.cacheHint,
      cacheVolatile: entry.cacheHint === "stable" ? checkStablePromptCacheLayout(content) : [],
    });
  }

  const duplicateLines = [];
  for (const [line, owners] of allLines) {
    if (owners.length < 2) continue;
    duplicateLines.push({ line, owners: [...new Set(owners)] });
  }

  const failures = [];
  for (const entry of entries) {
    if (entry.overBudget) {
      failures.push(`${entry.id}: ${entry.chars} chars > budget ${entry.maxChars} (${entry.path})`);
    }
    for (const marker of entry.missingRequired) {
      failures.push(`${entry.id}: missing required marker ${JSON.stringify(marker)}`);
    }
    for (const volatile of entry.cacheVolatile) {
      failures.push(`${entry.id}: volatile ${volatile} token in stable cache prefix`);
    }
  }

  return {
    entries,
    duplicateLines,
    failures,
    warnings: duplicateLines.map(
      ({ line, owners }) => `duplicate rule across ${owners.join(", ")}: ${line.slice(0, 160)}`,
    ),
  };
}

export function parseEvalRecords(text) {
  const records = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (line.trim().length === 0) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      fail(`eval line ${index + 1}: invalid JSON`);
    }
    if (typeof record.taskId !== "string" || record.taskId.trim().length === 0) {
      fail(`eval line ${index + 1}: taskId must be a non-empty string`);
    }
    if (record.arm !== "baseline" && record.arm !== "candidate") {
      fail(`eval line ${index + 1}: arm must be baseline or candidate`);
    }
    if (!Number.isInteger(record.run) || record.run < 1) {
      fail(`eval line ${index + 1}: run must be a positive integer`);
    }
    if (typeof record.success !== "boolean")
      fail(`eval line ${index + 1}: success must be boolean`);
    for (const field of ["tokens", "cacheReadTokens", "durationMs"]) {
      if (!Number.isFinite(record[field]) || record[field] < 0) {
        fail(`eval line ${index + 1}: ${field} must be a non-negative number`);
      }
    }
    if (
      record.quality !== undefined &&
      (!Number.isFinite(record.quality) || record.quality < 0 || record.quality > 1)
    ) {
      fail(`eval line ${index + 1}: quality must be between 0 and 1`);
    }
    if (
      record.criticalRegressions !== undefined &&
      (!Number.isInteger(record.criticalRegressions) || record.criticalRegressions < 0)
    ) {
      fail(`eval line ${index + 1}: criticalRegressions must be a non-negative integer`);
    }
    records.push({
      ...record,
      holdout: record.holdout === true,
      synthetic: record.synthetic === true,
    });
  }
  return records;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function compareEvalRecords(baselineText, candidateText) {
  const all = [...parseEvalRecords(baselineText), ...parseEvalRecords(candidateText)];
  const byTask = new Map();
  for (const record of all) {
    const task = byTask.get(record.taskId) ?? { baseline: [], candidate: [] };
    task[record.arm].push(record);
    byTask.set(record.taskId, task);
  }
  const failures = [];
  const tasks = [];
  for (const [taskId, arms] of byTask) {
    if (arms.baseline.length === 0 || arms.candidate.length === 0) {
      failures.push(`${taskId}: both baseline and candidate records are required`);
      continue;
    }
    if (arms.baseline.length < 3 || arms.candidate.length < 3) {
      failures.push(`${taskId}: at least 3 runs per arm are required`);
    }
    const summarize = (records) => ({
      runs: records.length,
      successRate: records.filter((record) => record.success).length / records.length,
      medianTokens: median(records.map((record) => record.tokens)),
      medianCacheReadTokens: median(records.map((record) => record.cacheReadTokens)),
      medianDurationMs: median(records.map((record) => record.durationMs)),
      meanQuality: records.every((record) => record.quality === undefined)
        ? undefined
        : records.reduce((sum, record) => sum + (record.quality ?? 0), 0) / records.length,
      criticalRegressions: records.reduce(
        (sum, record) => sum + (record.criticalRegressions ?? 0),
        0,
      ),
      holdout: records.some((record) => record.holdout),
      synthetic: records.every((record) => record.synthetic),
    });
    const baseline = summarize(arms.baseline);
    const candidate = summarize(arms.candidate);
    const reasons = [];
    if (candidate.successRate < baseline.successRate) {
      reasons.push("candidate success rate is lower");
    }
    if (candidate.criticalRegressions > baseline.criticalRegressions) {
      reasons.push("candidate has more critical regressions");
    }
    if (candidate.medianDurationMs > baseline.medianDurationMs * 1.5) {
      reasons.push("candidate median duration regressed by more than 50%");
    }
    if (
      candidate.medianTokens > baseline.medianTokens * 1.2 &&
      candidate.successRate <= baseline.successRate &&
      (baseline.meanQuality === undefined ||
        candidate.meanQuality === undefined ||
        candidate.meanQuality <= baseline.meanQuality + 0.01)
    ) {
      reasons.push("candidate median tokens regressed by more than 20%");
    }
    if (
      baseline.meanQuality !== undefined &&
      candidate.meanQuality !== undefined &&
      candidate.meanQuality < baseline.meanQuality - 0.05
    ) {
      reasons.push("candidate mean quality dropped by more than 0.05");
    }
    const improved =
      candidate.medianTokens < baseline.medianTokens ||
      candidate.medianDurationMs < baseline.medianDurationMs ||
      (baseline.meanQuality !== undefined &&
        candidate.meanQuality !== undefined &&
        candidate.meanQuality > baseline.meanQuality + 0.01);
    if (!improved) reasons.push("no efficiency or quality metric improved");
    tasks.push({ taskId, baseline, candidate, reasons });
    for (const reason of reasons) failures.push(`${taskId}: ${reason}`);
  }
  if ([...byTask.values()].every((arms) => !arms.baseline.some((record) => record.holdout))) {
    failures.push("at least one protected holdout task is required");
  }
  const evidence = all.every((record) => record.synthetic) ? "synthetic" : "real";
  const verdict =
    failures.length > 0 ? "reject" : evidence === "synthetic" ? "inconclusive" : "candidate";
  return { verdict, evidence, tasks, failures };
}

export async function writePromptSnapshot(result, file, root = REPO_ROOT) {
  const head = await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: root })
    .then(({ stdout }) => stdout.trim())
    .catch(() => "unknown");
  const snapshot = {
    version: 1,
    createdAt: new Date().toISOString(),
    gitHead: head.trim(),
    layers: result.entries.map(({ id, path: layerPath, chars, estimatedTokens }) => ({
      id,
      path: layerPath,
      chars,
      estimatedTokens,
    })),
  };
  await writeFile(path.resolve(root, file), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return snapshot;
}

export function checkStablePromptCacheLayout(content) {
  const volatilePatterns = [
    { id: "clock", pattern: /\b(?:new Date\s*\(|Date\.now\s*\()/u },
    { id: "random", pattern: /\bMath\.random\s*\(/u },
    { id: "cwd", pattern: /\bprocess\.cwd\s*\(/u },
    { id: "absolute-home", pattern: /(?:\/home\/|\/Users\/|[A-Z]:\\Users\\)/u },
    { id: "iso-timestamp", pattern: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u },
    {
      id: "uuid",
      pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu,
    },
  ];
  return volatilePatterns.filter(({ pattern }) => pattern.test(content)).map(({ id }) => id);
}

export function formatReport(result) {
  const rows = result.entries.map(
    (entry) =>
      `${entry.overBudget ? "FAIL" : "ok  "} ${entry.id.padEnd(24)} ${String(entry.chars).padStart(6)} chars  ~${String(entry.estimatedTokens).padStart(5)} tok  budget ${entry.maxChars}`,
  );
  const lines = [
    "Prompt registry",
    ...rows,
    "",
    `duplicate rules: ${result.duplicateLines.length}`,
    ...result.warnings.slice(0, 20).map((warning) => `  warn: ${warning}`),
    ...result.failures.map((failure) => `  fail: ${failure}`),
  ];
  if (result.duplicateLines.length > 20) {
    lines.push(`  warn: …and ${result.duplicateLines.length - 20} more duplicate lines`);
  }
  return lines.join("\n");
}

async function loadRegistry(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function parseArgs(argv) {
  const options = {
    check: false,
    report: false,
    strict: false,
    json: false,
    registry: DEFAULT_REGISTRY,
    snapshot: undefined,
    compare: undefined,
    candidate: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") options.check = true;
    else if (arg === "--report") options.report = true;
    else if (arg === "--strict") options.strict = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--snapshot") options.snapshot = argv[++index] ?? "";
    else if (arg === "--compare") options.compare = argv[++index] ?? "";
    else if (arg === "--candidate") options.candidate = argv[++index] ?? "";
    else if (arg === "--registry") options.registry = path.resolve(argv[++index] ?? "");
    else if (arg.startsWith("--registry="))
      options.registry = path.resolve(arg.slice("--registry=".length));
    else fail(`unknown argument: ${arg}`);
  }
  if (!options.check && !options.report && !options.snapshot && !options.compare) {
    options.check = true;
  }
  if (options.compare && !options.candidate) fail("--compare requires --candidate <file>");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.snapshot) {
    const result = await checkRegistry(await loadRegistry(options.registry));
    if (result.failures.length > 0) {
      process.stderr.write(`${formatReport(result)}\n`);
      process.exitCode = 1;
      return;
    }
    const snapshot = await writePromptSnapshot(result, options.snapshot);
    process.stdout.write(
      `prompt snapshot: ${snapshot.layers.length} layers -> ${options.snapshot}\n`,
    );
    return;
  }
  if (options.compare) {
    const [baselineText, candidateText] = await Promise.all([
      readFile(path.resolve(options.compare), "utf8"),
      readFile(path.resolve(options.candidate), "utf8"),
    ]);
    const comparison = compareEvalRecords(baselineText, candidateText);
    process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
    if (comparison.verdict === "reject") process.exitCode = 1;
    return;
  }
  const result = await checkRegistry(await loadRegistry(options.registry));
  const strictFailures = options.strict ? result.warnings : [];
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ ...result, failures: [...result.failures, ...strictFailures] }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(`${formatReport(result)}\n`);
  }
  if (result.failures.length > 0 || strictFailures.length > 0) {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
