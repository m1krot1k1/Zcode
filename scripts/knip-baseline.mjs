#!/usr/bin/env node
/**
 * Knip baseline gate.
 *
 * The repository has a large historical backlog of unused files/exports. Running plain
 * `knip` exits 1 forever, so it cannot be used as a regression gate. This wrapper compares
 * the current report with a checked-in baseline and fails only on NEW issues. Existing
 * backlog stays visible as a count; resolved issues are reported so the baseline can shrink.
 *
 * Usage:
 *   node scripts/knip-baseline.mjs            # check against scripts/knip-baseline.json
 *   node scripts/knip-baseline.mjs --write    # regenerate the baseline
 */
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = path.join(root, "scripts", "knip-baseline.json");
const ISSUE_TYPES = [
  "binaries",
  "catalog",
  "dependencies",
  "devDependencies",
  "duplicates",
  "enumMembers",
  "exports",
  "files",
  "namespaceMembers",
  "optionalPeerDependencies",
  "types",
  "unlisted",
  "unresolved",
];

function issueName(issue) {
  if (typeof issue === "string") return issue;
  if (issue && typeof issue === "object") {
    if (typeof issue.name === "string") return issue.name;
    if (typeof issue.symbol === "string") return issue.symbol;
  }
  return JSON.stringify(issue);
}

export function collectIssueKeys(report) {
  const keys = new Set();
  for (const entry of report?.issues ?? []) {
    if (!entry || typeof entry.file !== "string") continue;
    for (const type of ISSUE_TYPES) {
      for (const issue of entry[type] ?? []) {
        keys.add(`${type}\t${entry.file}\t${issueName(issue)}`);
      }
    }
  }
  return [...keys].sort();
}

export function compareIssueKeys(current, baseline) {
  const currentSet = new Set(current);
  const baselineSet = new Set(baseline);
  return {
    newIssues: current.filter((key) => !baselineSet.has(key)),
    resolvedIssues: baseline.filter((key) => !currentSet.has(key)),
  };
}

function extractJsonReport(output) {
  // pnpm can print its "Unsupported engine" warning to stdout before the report.
  const reportLine = String(output)
    .split(/\r?\n/u)
    .find((line) => line.trimStart().startsWith('{"issues"'));
  if (!reportLine) throw new Error("knip did not return a JSON report");
  return reportLine;
}

async function runKnip() {
  const pnpm = process.env.npm_execpath;
  const pnpmIsScript = Boolean(pnpm && /\.[cm]?js$/i.test(pnpm));
  const command = pnpmIsScript ? process.execPath : (pnpm ?? "pnpm");
  const args = pnpmIsScript
    ? [pnpm, "exec", "knip", "--reporter", "json", "--no-progress"]
    : ["exec", "knip", "--reporter", "json", "--no-progress"];
  try {
    const result = await exec(command, args, {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
      ...(process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command) ? { shell: true } : {}),
    });
    return extractJsonReport(result.stdout);
  } catch (error) {
    // knip exits 1 when it finds issues; the JSON report is still on stdout.
    if (error?.stdout) return extractJsonReport(error.stdout);
    throw error;
  }
}

async function main() {
  const write = process.argv.includes("--write");
  const report = JSON.parse(await runKnip());
  const current = collectIssueKeys(report);

  if (write) {
    await writeFile(
      baselinePath,
      `${JSON.stringify({ version: 1, issues: current }, null, 2)}\n`,
      "utf8",
    );
    process.stdout.write(`knip baseline written: ${current.length} issues\n`);
    return;
  }

  let baseline = { issues: [] };
  try {
    baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    process.stdout.write("knip baseline is missing; run pnpm knip:update-baseline\n");
    process.exitCode = 1;
    return;
  }

  const { newIssues, resolvedIssues } = compareIssueKeys(current, baseline.issues ?? []);
  process.stdout.write(
    `knip baseline: current=${current.length} baseline=${(baseline.issues ?? []).length} new=${newIssues.length} resolved=${resolvedIssues.length}\n`,
  );
  if (newIssues.length > 0) {
    process.stdout.write(`New knip issues (${newIssues.length}):\n`);
    for (const key of newIssues.slice(0, 50))
      process.stdout.write(`  ${key.replaceAll("\t", " ")}\n`);
    if (newIssues.length > 50) process.stdout.write(`  ... and ${newIssues.length - 50} more\n`);
    process.exitCode = 1;
  }
  if (resolvedIssues.length > 0) {
    process.stdout.write(
      `Resolved knip issues (${resolvedIssues.length}); update the baseline to shrink it.\n`,
    );
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
