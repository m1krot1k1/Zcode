#!/usr/bin/env node
/**
 * Fail-closed gate for recorded /evaluate outcomes.
 *
 * It never runs models, never authenticates evidence, and never publishes a
 * percentage or score. It only checks that every shared case has a pass row
 * recorded at the current git HEAD with non-empty evidence.
 */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG_RELATIVE_PATH = ".zcode/evaluation-cases.json";
const RESULTS_RELATIVE_PATH = ".zcode/eval-results.jsonl";
const CASE_ID_PATTERN = /^[A-Z][A-Z0-9-]{1,40}$/u;
const CASE_TEXT_LIMIT = 240;
const CASE_LIMIT = 50;
const CASE_FIELDS = new Set(["id", "criterion", "evidence"]);
const RESULT_FIELDS = new Set(["case_id", "revision", "result", "evidence"]);
const RESULT_VALUES = new Set(["pass", "fail", "not_run"]);

export class EvalGateInputError extends Error {}

function shortRevision(revision) {
  return typeof revision === "string" && revision.length > 7 ? revision.slice(0, 7) : revision;
}

function readCaseText(value, field, index) {
  if (typeof value !== "string") {
    throw new EvalGateInputError(`case ${index + 1}: ${field} must be a string`);
  }
  const text = value.trim();
  if (text.length === 0 || text.length > CASE_TEXT_LIMIT || text.includes("\n")) {
    throw new EvalGateInputError(
      `case ${index + 1}: ${field} must be one line of 1-${CASE_TEXT_LIMIT} characters`,
    );
  }
  return text;
}

export function parseEvaluationCases(text) {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new EvalGateInputError(`${CATALOG_RELATIVE_PATH} is not valid JSON`);
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new EvalGateInputError(`${CATALOG_RELATIVE_PATH} must contain a JSON object`);
  }
  if (document.version !== 1) {
    throw new EvalGateInputError(`${CATALOG_RELATIVE_PATH}: version must be 1`);
  }
  if (!Array.isArray(document.cases)) {
    throw new EvalGateInputError(`${CATALOG_RELATIVE_PATH}: cases must be an array`);
  }
  if (document.cases.length === 0) {
    throw new EvalGateInputError(`${CATALOG_RELATIVE_PATH}: catalog has no cases`);
  }
  if (document.cases.length > CASE_LIMIT) {
    throw new EvalGateInputError(
      `${CATALOG_RELATIVE_PATH}: at most ${CASE_LIMIT} cases are allowed`,
    );
  }

  const seen = new Set();
  return document.cases.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new EvalGateInputError(`case ${index + 1}: case must be an object`);
    }
    for (const key of Object.keys(item)) {
      if (!CASE_FIELDS.has(key)) {
        throw new EvalGateInputError(`case ${index + 1}: unknown field "${key}"`);
      }
    }
    if (typeof item.id !== "string" || !CASE_ID_PATTERN.test(item.id)) {
      throw new EvalGateInputError(`case ${index + 1}: id must match ${CASE_ID_PATTERN.source}`);
    }
    if (seen.has(item.id)) {
      throw new EvalGateInputError(`duplicate case id ${item.id}`);
    }
    seen.add(item.id);
    const entry = { id: item.id, criterion: readCaseText(item.criterion, "criterion", index) };
    if (item.evidence !== undefined) {
      entry.evidence = readCaseText(item.evidence, "evidence", index);
    }
    return entry;
  });
}

export function parseEvaluationResults(text) {
  const rows = [];
  const lines = text.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new EvalGateInputError(`${RESULTS_RELATIVE_PATH} line ${index + 1}: invalid JSON`);
    }
    rows.push({ line: index + 1, row });
  }
  return rows;
}

export function assessEvaluationResults({ cases, results, headRevision }) {
  const errors = [];
  const atHead = new Map();
  const staleRevisions = new Set();
  const knownIds = new Set(cases.map((item) => item.id));

  for (const { line, row } of results) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      errors.push(`${RESULTS_RELATIVE_PATH} line ${line}: row must be an object`);
      continue;
    }
    for (const key of Object.keys(row)) {
      if (!RESULT_FIELDS.has(key)) {
        errors.push(`${RESULTS_RELATIVE_PATH} line ${line}: unknown field "${key}"`);
      }
    }
    const caseId = row.case_id;
    if (typeof caseId !== "string" || !CASE_ID_PATTERN.test(caseId)) {
      errors.push(`${RESULTS_RELATIVE_PATH} line ${line}: case_id is invalid`);
      continue;
    }
    if (!knownIds.has(caseId)) {
      errors.push(`${RESULTS_RELATIVE_PATH} line ${line}: unknown case ${caseId}`);
      continue;
    }
    if (typeof row.revision !== "string" || row.revision.length === 0) {
      errors.push(`${RESULTS_RELATIVE_PATH} line ${line}: revision is required`);
      continue;
    }
    if (row.revision !== headRevision) {
      staleRevisions.add(row.revision);
      continue;
    }
    if (!RESULT_VALUES.has(row.result)) {
      errors.push(`${RESULTS_RELATIVE_PATH} line ${line}: result must be pass, fail, or not_run`);
      continue;
    }
    if (
      row.evidence !== undefined &&
      (typeof row.evidence !== "string" || row.evidence.trim().length === 0)
    ) {
      errors.push(`${RESULTS_RELATIVE_PATH} line ${line}: evidence must be a non-empty string`);
      continue;
    }
    const previous = atHead.get(caseId);
    if (previous !== undefined && previous.result !== row.result) {
      errors.push(`conflicting results for ${caseId} at HEAD ${shortRevision(headRevision)}`);
      continue;
    }
    atHead.set(caseId, row);
  }

  if (atHead.size === 0 && staleRevisions.size > 0) {
    errors.push(
      `no results at HEAD ${shortRevision(headRevision)}; found results for other revisions: ${[...staleRevisions].join(", ")}`,
    );
  }

  for (const item of cases) {
    const row = atHead.get(item.id);
    if (row === undefined) {
      errors.push(`missing result for ${item.id} at HEAD ${shortRevision(headRevision)}`);
      continue;
    }
    if (row.result === "not_run") {
      errors.push(`${item.id}: not_run is not pass`);
      continue;
    }
    if (row.result === "fail") {
      errors.push(`${item.id}: fail`);
      continue;
    }
    if (typeof row.evidence !== "string" || row.evidence.trim().length === 0) {
      errors.push(`${item.id}: pass requires evidence`);
    }
  }

  return {
    errors: [...new Set(errors)],
    exitCode: errors.length === 0 ? 0 : 1,
    total: cases.length,
  };
}

export function evaluateGate({ catalogText, resultsText, headRevision }) {
  try {
    if (typeof headRevision !== "string" || headRevision.trim().length === 0) {
      throw new EvalGateInputError("HEAD revision is unavailable");
    }
    const cases = parseEvaluationCases(catalogText);
    const results = parseEvaluationResults(resultsText);
    return assessEvaluationResults({ cases, results, headRevision: headRevision.trim() });
  } catch (error) {
    if (error instanceof EvalGateInputError) {
      return { errors: [error.message], exitCode: 1, total: 0 };
    }
    throw error;
  }
}

export async function runEvaluationGate(options = {}) {
  const root = options.root ?? REPOSITORY_ROOT;
  let headRevision = options.headRevision;
  if (headRevision === undefined) {
    try {
      headRevision = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim();
    } catch {
      return {
        errors: ["cannot read git HEAD for the evaluation checkout"],
        exitCode: 1,
        total: 0,
      };
    }
  }

  let catalogText;
  try {
    catalogText = await readFile(path.join(root, CATALOG_RELATIVE_PATH), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        errors: [`${CATALOG_RELATIVE_PATH} is missing; the shared suite has no owner file`],
        exitCode: 1,
        total: 0,
      };
    }
    return {
      errors: [`${CATALOG_RELATIVE_PATH} is unreadable: ${error.message}`],
      exitCode: 1,
      total: 0,
    };
  }

  let resultsText;
  try {
    resultsText = await readFile(path.join(root, RESULTS_RELATIVE_PATH), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        errors: [
          `${RESULTS_RELATIVE_PATH} is missing; run /evaluate at HEAD ${shortRevision(headRevision)}`,
        ],
        exitCode: 1,
        total: 0,
      };
    }
    return {
      errors: [`${RESULTS_RELATIVE_PATH} is unreadable: ${error.message}`],
      exitCode: 1,
      total: 0,
    };
  }

  return evaluateGate({ catalogText, headRevision, resultsText });
}

export async function main() {
  const report = await runEvaluationGate();
  if (report.exitCode === 0) {
    process.stdout.write(`eval gate: all ${report.total} shared cases pass at HEAD\n`);
    return 0;
  }
  process.stderr.write(
    `eval gate: FAIL (${report.errors.length} problem${report.errors.length === 1 ? "" : "s"})\n`,
  );
  for (const message of report.errors) process.stderr.write(`- ${message}\n`);
  return report.exitCode;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main();
}
