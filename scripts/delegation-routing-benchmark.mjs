#!/usr/bin/env node
/**
 * Paired benchmark gate for the delegation routing policy.
 *
 * It only compares recorded JSONL results; it never runs an LLM. Each task must have
 * one `baseline` (root inline) and one `candidate` (routing-gated delegation) record.
 * Synthetic fixtures are useful for testing the gate, not for claiming model gains.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ARMS = new Set(["baseline", "candidate"]);

function fail(message) {
  throw new Error(message);
}

function requireNonNegativeNumber(value, field, taskId, arm) {
  if (!Number.isFinite(value) || value < 0) {
    fail(`${taskId}/${arm}: ${field} must be a non-negative number`);
  }
}

export function parseBenchmarkRecords(text) {
  const records = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (line.trim().length === 0) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      fail(`line ${index + 1}: invalid JSON`);
    }
    if (typeof record.taskId !== "string" || record.taskId.trim().length === 0) {
      fail(`line ${index + 1}: taskId must be a non-empty string`);
    }
    if (!ARMS.has(record.arm)) {
      fail(`line ${index + 1}: arm must be baseline or candidate`);
    }
    if (typeof record.success !== "boolean") {
      fail(`line ${index + 1}: success must be boolean`);
    }
    requireNonNegativeNumber(record.durationMs, "durationMs", record.taskId, record.arm);
    requireNonNegativeNumber(record.tokens, "tokens", record.taskId, record.arm);
    if (record.duplicateClaims !== undefined) {
      if (!Number.isInteger(record.duplicateClaims) || record.duplicateClaims < 0) {
        fail(`${record.taskId}/${record.arm}: duplicateClaims must be a non-negative integer`);
      }
    }
    if (record.criticalRegressions !== undefined) {
      if (!Number.isInteger(record.criticalRegressions) || record.criticalRegressions < 0) {
        fail(`${record.taskId}/${record.arm}: criticalRegressions must be a non-negative integer`);
      }
    }
    records.push(record);
  }
  return records;
}

export function compareBenchmarkRecords(records) {
  const byTask = new Map();
  for (const record of records) {
    const arms = byTask.get(record.taskId) ?? {};
    if (arms[record.arm]) {
      fail(`task ${record.taskId}: duplicate ${record.arm} record`);
    }
    arms[record.arm] = record;
    byTask.set(record.taskId, arms);
  }

  const pairs = [];
  for (const [taskId, arms] of byTask) {
    if (!arms.baseline || !arms.candidate) {
      fail(`task ${taskId}: both baseline and candidate records are required`);
    }
    pairs.push({ taskId, baseline: arms.baseline, candidate: arms.candidate });
  }
  if (pairs.length === 0) fail("no paired records found");
  return pairs;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summarizeArm(pairs, arm) {
  const values = pairs.map((pair) => pair[arm]);
  return {
    tasks: values.length,
    successRate: values.filter((value) => value.success).length / values.length,
    medianDurationMs: median(values.map((value) => value.durationMs)),
    totalTokens: values.reduce((sum, value) => sum + value.tokens, 0),
    duplicateClaims: values.reduce((sum, value) => sum + (value.duplicateClaims ?? 0), 0),
    criticalRegressions: values.reduce((sum, value) => sum + (value.criticalRegressions ?? 0), 0),
  };
}

export function evaluateBenchmark(pairs) {
  const baseline = summarizeArm(pairs, "baseline");
  const candidate = summarizeArm(pairs, "candidate");
  const deltas = {
    successRate: candidate.successRate - baseline.successRate,
    medianDurationMs: candidate.medianDurationMs - baseline.medianDurationMs,
    totalTokens: candidate.totalTokens - baseline.totalTokens,
    duplicateClaims: candidate.duplicateClaims - baseline.duplicateClaims,
    criticalRegressions: candidate.criticalRegressions - baseline.criticalRegressions,
  };

  const rejected =
    candidate.criticalRegressions > 0 || candidate.successRate < baseline.successRate;
  const efficiencyWin =
    candidate.medianDurationMs < baseline.medianDurationMs ||
    candidate.totalTokens < baseline.totalTokens ||
    candidate.duplicateClaims < baseline.duplicateClaims;
  const verdict = rejected ? "reject" : efficiencyWin ? "candidate" : "inconclusive";

  return { baseline, candidate, deltas, verdict };
}

function parseArgs(argv) {
  const options = { baseline: null, candidate: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--baseline" || arg === "--candidate") {
      const value = argv[index + 1];
      if (!value) fail(`${arg} requires a path`);
      options[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    fail(`unknown argument: ${arg}`);
  }
  if (!options.baseline || !options.candidate) {
    fail(
      "usage: node scripts/delegation-routing-benchmark.mjs --baseline <jsonl> --candidate <jsonl>",
    );
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [baselineText, candidateText] = await Promise.all([
    readFile(path.resolve(options.baseline), "utf8"),
    readFile(path.resolve(options.candidate), "utf8"),
  ]);
  const pairs = compareBenchmarkRecords([
    ...parseBenchmarkRecords(baselineText),
    ...parseBenchmarkRecords(candidateText),
  ]);
  const report = evaluateBenchmark(pairs);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.verdict === "reject") process.exitCode = 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
