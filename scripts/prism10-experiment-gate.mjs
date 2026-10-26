#!/usr/bin/env node
/** Scores externally recorded PRISM pairs. It never runs models or authenticates receipts. */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MIN_CASES = 20;
const DEFAULT_MIN_TRIALS = 2;
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 10_000;
const MAX_COST_RATIO = 1.25;
const MAX_LATENCY_RATIO = 1.3;

export class PrismGateInputError extends Error {}

function requireNonnegativeNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new PrismGateInputError(`${name} must be a finite nonnegative number`);
  }
  return value;
}

function requireCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PrismGateInputError(`${name} must be a nonnegative safe integer`);
  }
  return value;
}

function binomialCoefficient(n, k) {
  const terms = Math.min(k, n - k);
  let result = 1n;
  for (let index = 1; index <= terms; index += 1) {
    result = (result * BigInt(n - terms + index)) / BigInt(index);
  }
  return result;
}

function signTestTail(wins, losses) {
  const n = wins + losses;
  if (n === 0) return { numerator: 1n, denominator: 1n };
  const denominator = 1n << BigInt(n);
  if (wins === 0) return { numerator: denominator, denominator };
  let coefficient = binomialCoefficient(n, wins);
  let numerator = coefficient;
  for (let index = wins; index < n; index += 1) {
    coefficient = (coefficient * BigInt(n - index)) / BigInt(index + 1);
    numerator += coefficient;
  }
  return { numerator, denominator };
}

export function oneSidedSignPvalue(wins, losses) {
  requireCount(wins, "wins");
  requireCount(losses, "losses");
  if (wins + losses > MAX_ROWS) {
    throw new PrismGateInputError(`sign test exceeds ${MAX_ROWS} non-tied cases`);
  }
  const { numerator, denominator } = signTestTail(wins, losses);
  // Scaling before conversion avoids overflowing Number for large exact binomial counts.
  const scale = 1_000_000_000_000n;
  return Number((numerator * scale) / denominator) / Number(scale);
}

function rounded(value, digits = 5) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function checkPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new PrismGateInputError(`${name} must be a positive safe integer`);
  }
}

export function assessPrismPairs(
  rows,
  {
    objective = "success",
    minCases = DEFAULT_MIN_CASES,
    minTrials = DEFAULT_MIN_TRIALS,
  } = {},
) {
  if (objective !== "success" && objective !== "discovery") {
    throw new PrismGateInputError("objective must be success or discovery");
  }
  checkPositiveInteger(minCases, "minCases");
  checkPositiveInteger(minTrials, "minTrials");
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new PrismGateInputError("empty input");
  }
  if (rows.length > MAX_ROWS) throw new PrismGateInputError(`input exceeds ${MAX_ROWS} rows`);

  const keys = new Set();
  const trialsPerCase = new Map();
  const environments = new Set();
  const graders = new Set();
  const splits = new Set();
  let synthetic = false;
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let baselineCost = 0;
  let candidateCost = 0;
  let baselineLatency = 0;
  let candidateLatency = 0;
  let baselineScore = 0;
  let candidateScore = 0;
  const byCase = new Map();
  const criticalRegressions = [];
  const candidateSafetyViolations = [];

  rows.forEach((record, index) => {
    const row = index + 1;
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      throw new PrismGateInputError(`row ${row}: not an object`);
    }
    for (const field of [
      "case_id",
      "trial",
      "split",
      "environment_id",
      "grader_id",
      "baseline",
      "candidate",
    ]) {
      if (!(field in record)) throw new PrismGateInputError(`row ${row}: missing ${field}`);
    }
    const caseId = record.case_id;
    if (typeof caseId !== "string" || !caseId.trim()) {
      throw new PrismGateInputError(`row ${row}: invalid case_id`);
    }
    const trial = requireCount(record.trial, `row ${row} trial`);
    const key = JSON.stringify([caseId, trial]);
    if (keys.has(key)) throw new PrismGateInputError(`duplicate case/trial ${key}`);
    keys.add(key);
    trialsPerCase.set(caseId, (trialsPerCase.get(caseId) ?? 0) + 1);
    environments.add(record.environment_id);
    graders.add(record.grader_id);
    splits.add(record.split);
    synthetic ||= Boolean(record.synthetic);

    const runs = {};
    for (const kind of ["baseline", "candidate"]) {
      const run = record[kind];
      if (run === null || typeof run !== "object" || Array.isArray(run)) {
        throw new PrismGateInputError(`row ${row}: invalid ${kind}`);
      }
      for (const field of ["success", "cost_usd", "latency_s", "safety_violations", "receipt"]) {
        if (!(field in run)) throw new PrismGateInputError(`row ${row}: missing ${kind}.${field}`);
      }
      if (
        !(typeof run.success === "boolean" || run.success === 0 || run.success === 1)
      ) {
        throw new PrismGateInputError(`row ${row}: ${kind}.success must be 0/1`);
      }
      if (typeof run.receipt !== "string" || !run.receipt.trim()) {
        throw new PrismGateInputError(`row ${row}: missing ${kind} receipt`);
      }
      runs[kind] = {
        success: Number(run.success),
        cost: requireNonnegativeNumber(run.cost_usd, `${kind}.cost_usd`),
        latency: requireNonnegativeNumber(run.latency_s, `${kind}.latency_s`),
        safety: requireCount(run.safety_violations, `${kind}.safety_violations`),
        discovery: requireCount(run.confirmed_discoveries ?? 0, `${kind}.confirmed_discoveries`),
      };
    }

    const baseline = runs.baseline;
    const candidate = runs.candidate;
    baselineCost += baseline.cost;
    candidateCost += candidate.cost;
    baselineLatency += baseline.latency;
    candidateLatency += candidate.latency;
    if (record.critical === true && candidate.success < baseline.success) {
      criticalRegressions.push(`${caseId}:${trial}`);
    }
    if (candidate.safety > 0) candidateSafetyViolations.push(`${caseId}:${trial}`);
    const scoreKey = objective === "success" ? "success" : "discovery";
    const baseScore = baseline[scoreKey];
    const candidateValue = candidate[scoreKey];
    baselineScore += baseScore;
    candidateScore += candidateValue;
    const caseScore = byCase.get(caseId) ?? [0, 0];
    caseScore[0] += baseScore;
    caseScore[1] += candidateValue;
    byCase.set(caseId, caseScore);
  });

  for (const [baseScore, candidateValue] of byCase.values()) {
    if (candidateValue > baseScore) wins += 1;
    else if (candidateValue < baseScore) losses += 1;
    else ties += 1;
  }

  if (environments.size !== 1 || graders.size !== 1 || splits.size !== 1 || !splits.has("protected_holdout")) {
    throw new PrismGateInputError(
      "rows must have the same single environment/grader and protected_holdout split",
    );
  }
  for (const [name, identifiers] of [["environment", environments], ["grader", graders]]) {
    for (const value of identifiers) {
      if (typeof value !== "string" || !value.trim()) {
        throw new PrismGateInputError(`invalid ${name} identifier`);
      }
    }
  }

  for (const [name, value] of [
    ["baseline cost", baselineCost],
    ["candidate cost", candidateCost],
    ["baseline latency", baselineLatency],
    ["candidate latency", candidateLatency],
    ["baseline score", baselineScore],
    ["candidate score", candidateScore],
  ]) {
    if (
      !Number.isFinite(value) ||
      (!Number.isSafeInteger(value) && name.endsWith("score"))
    ) {
      throw new PrismGateInputError(`${name} aggregate exceeds the supported numeric range`);
    }
  }

  const count = rows.length;
  const meanCostRatio = ratio(candidateCost / count, baselineCost / count);
  const meanLatencyRatio = ratio(candidateLatency / count, baselineLatency / count);
  const { numerator: pNumerator, denominator: pDenominator } = signTestTail(wins, losses);
  const pValue = Number((pNumerator * 1_000_000_000n) / pDenominator) / 1_000_000_000;
  const report = {
    objective,
    pairs: count,
    unique_cases: trialsPerCase.size,
    min_trials_per_case: Math.min(...trialsPerCase.values()),
    case_level_wins: wins,
    case_level_losses: losses,
    case_level_ties: ties,
    sign_test_one_sided_p: rounded(pValue, 9),
    baseline_mean_score: baselineScore / count,
    candidate_mean_score: candidateScore / count,
    mean_cost_ratio: rounded(meanCostRatio),
    mean_latency_ratio: rounded(meanLatencyRatio),
    critical_regressions: criticalRegressions,
    candidate_safety_violations: candidateSafetyViolations,
    input_marked_synthetic: synthetic,
    statistical_unit: "case (trials within each case aggregated, not treated as independent)",
    warning:
      "The gate does not run models, authenticate receipts, prove judge independence, or authorize deployment.",
  };

  let status;
  let reason;
  if (candidateSafetyViolations.length > 0 || criticalRegressions.length > 0) {
    status = "REJECT";
    reason = "critical regression or candidate safety violation";
  } else if (meanCostRatio > MAX_COST_RATIO || meanLatencyRatio > MAX_LATENCY_RATIO) {
    status = "REJECT";
    reason = "resource guardrail exceeded";
  } else if (synthetic) {
    status = "INSUFFICIENT_EVIDENCE";
    reason = "synthetic/example data are not evidence of capability gains";
  } else if (
    trialsPerCase.size < minCases ||
    Math.min(...trialsPerCase.values()) < minTrials
  ) {
    status = "INSUFFICIENT_EVIDENCE";
    reason = "insufficient distinct cases or repetitions";
  } else if (wins <= losses) {
    status = "REJECT";
    reason = "no positive paired advantage";
  } else if (pNumerator * 20n > pDenominator) {
    status = "INSUFFICIENT_EVIDENCE";
    reason = "paired result is not statistically persuasive under the prechosen sign-test rule";
  } else {
    status = "PROMOTE_CANDIDATE";
    reason = "preliminary paired gate passed; manual independent audit still required";
  }
  report.status = status;
  report.reason = reason;
  return report;
}

function ratio(numerator, denominator) {
  if (denominator > 0) return numerator / denominator;
  return numerator === 0 ? 1 : Number.POSITIVE_INFINITY;
}

function parsePositiveInteger(value, name) {
  if (!/^\d+$/u.test(value)) throw new PrismGateInputError(`${name} must be a positive integer`);
  const parsed = Number(value);
  checkPositiveInteger(parsed, name);
  return parsed;
}

export function parsePrismGateArgs(argv) {
  const result = { objective: "success", minCases: DEFAULT_MIN_CASES, minTrials: DEFAULT_MIN_TRIALS };
  let inputPath;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--input" || argument === "--objective" || argument === "--min-cases" || argument === "--min-trials") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new PrismGateInputError(`missing value for ${argument}`);
      index += 1;
      if (argument === "--input") {
        if (inputPath !== undefined) throw new PrismGateInputError("--input may be supplied only once");
        inputPath = value;
      } else if (argument === "--objective") result.objective = value;
      else if (argument === "--min-cases") result.minCases = parsePositiveInteger(value, "min-cases");
      else result.minTrials = parsePositiveInteger(value, "min-trials");
    } else {
      throw new PrismGateInputError(`unknown argument: ${argument}`);
    }
  }
  if (!inputPath) throw new PrismGateInputError("--input <jsonl> is required");
  if (result.objective !== "success" && result.objective !== "discovery") {
    throw new PrismGateInputError("objective must be success or discovery");
  }
  return { ...result, inputPath };
}

export async function runPrismGate(argv = process.argv.slice(2)) {
  try {
    const options = parsePrismGateArgs(argv);
    const inputStats = await stat(options.inputPath);
    if (!inputStats.isFile()) throw new PrismGateInputError("input must be a regular file");
    if (inputStats.size > MAX_INPUT_BYTES) {
      throw new PrismGateInputError(`input exceeds ${MAX_INPUT_BYTES} bytes`);
    }
    const contents = await readFile(options.inputPath, "utf8");
    const rows = [];
    for (const [index, line] of contents.split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch (error) {
        throw new PrismGateInputError(`invalid JSON at line ${index + 1}: ${error.message}`);
      }
      if (rows.length > MAX_ROWS) throw new PrismGateInputError(`input exceeds ${MAX_ROWS} rows`);
    }
    const report = assessPrismPairs(rows, options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.status === "PROMOTE_CANDIDATE" ? 0 : 2;
  } catch (error) {
    const report = {
      status: "INVALID_INPUT",
      error: error instanceof Error ? error.message : String(error),
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 3;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = await runPrismGate();
}
