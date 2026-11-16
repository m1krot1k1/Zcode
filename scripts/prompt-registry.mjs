#!/usr/bin/env node
/**
 * Prompt registry gate: validates prompt source budgets, required rules, and
 * cross-layer duplication. It reads source files; it never calls a model.
 *
 * Usage:
 *   node scripts/prompt-registry.mjs --check [--strict] [--json]
 *   node scripts/prompt-registry.mjs --report
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
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
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") options.check = true;
    else if (arg === "--report") options.report = true;
    else if (arg === "--strict") options.strict = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--registry") options.registry = path.resolve(argv[++index] ?? "");
    else if (arg.startsWith("--registry="))
      options.registry = path.resolve(arg.slice("--registry=".length));
    else fail(`unknown argument: ${arg}`);
  }
  if (!options.check && !options.report) options.check = true;
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
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
