#!/usr/bin/env node
/**
 * Stage-1 skills mining: selects recurring successful tasks from eval records and
 * emits candidates for human-reviewed distillation. It never writes a skill or
 * changes agent profiles automatically.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVAL_DIR = path.join(ROOT, "config/prompts/eval");
const OUTPUT = path.join(ROOT, "config/skills-mining/candidates.json");

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function mineSkillCandidates(records) {
  const byTask = new Map();
  for (const record of records) {
    if (!record || typeof record.taskId !== "string") continue;
    if (record.arm !== "baseline" && record.arm !== "candidate") continue;
    const task = byTask.get(record.taskId) ?? { baseline: [], candidate: [] };
    task[record.arm].push(record);
    byTask.set(record.taskId, task);
  }
  const candidates = [];
  for (const [taskId, arms] of byTask) {
    if (arms.baseline.length < 3 || arms.candidate.length < 3) continue;
    if (!arms.candidate.every((record) => record.success)) continue;
    if (!arms.baseline.every((record) => record.success)) continue;
    const baselineTokens = median(arms.baseline.map((record) => record.tokens));
    const candidateTokens = median(arms.candidate.map((record) => record.tokens));
    const baselineDuration = median(arms.baseline.map((record) => record.durationMs));
    const candidateDuration = median(arms.candidate.map((record) => record.durationMs));
    if (candidateTokens >= baselineTokens && candidateDuration >= baselineDuration) continue;
    candidates.push({
      taskId,
      baselineMedianTokens: baselineTokens,
      candidateMedianTokens: candidateTokens,
      tokenDeltaPct:
        baselineTokens === 0
          ? 0
          : Math.round(((candidateTokens - baselineTokens) / baselineTokens) * 1000) / 10,
      baselineMedianDurationMs: baselineDuration,
      candidateMedianDurationMs: candidateDuration,
      approval: "required",
      nextStep:
        "Distill the winning trajectory into a skill only after human review and a second holdout.",
    });
  }
  candidates.sort(
    (left, right) =>
      left.tokenDeltaPct - right.tokenDeltaPct || left.taskId.localeCompare(right.taskId),
  );
  return candidates;
}

export async function loadEvalRecords(dir = EVAL_DIR) {
  const files = (await readdir(dir)).filter((file) => /^holdout.*\.jsonl$/u.test(file));
  const records = [];
  for (const file of files) {
    const text = await readFile(path.join(dir, file), "utf8");
    for (const line of text.split(/\r?\n/u)) {
      if (line.trim().length === 0) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // Ignore malformed eval lines; the eval lab itself is the strict gate for them.
      }
    }
  }
  return records;
}

async function main() {
  const records = await loadEvalRecords();
  const candidates = mineSkillCandidates(records);
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: "config/prompts/eval/holdout*.jsonl",
    candidates,
  };
  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(
    `skills mining: ${candidates.length} candidate(s) -> ${path.relative(ROOT, OUTPUT)}\n`,
  );
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
