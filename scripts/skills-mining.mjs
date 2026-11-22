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

export function approveCandidate(candidates, taskId) {
  const candidate = candidates.find((entry) => entry.taskId === taskId);
  if (!candidate) throw new Error(`unknown skill candidate: ${taskId}`);
  candidate.approval = "approved";
  return candidate;
}

export function renderMinedSkill(candidate) {
  const slug = `mined-${candidate.taskId.replace(/[^a-z0-9-]+/giu, "-").toLowerCase()}`;
  return `---\nname: ${slug}\ndescription: Use when the task matches the approved holdout pattern ${candidate.taskId}.\n---\n\n# ${candidate.taskId}\n\nThis skill was generated from an approved holdout candidate. It is a scaffold, not a transcript.\n\n## Procedure\n\n1. Restate the requested fact or deliverable and the allowed scope.\n2. Read only the named primary source needed for that deliverable.\n3. Return the result with evidence (path:line or command output) and mark unresolved items.\n\n## Evidence\n\n- Baseline median tokens: ${candidate.baselineMedianTokens}\n- Candidate median tokens: ${candidate.candidateMedianTokens}\n- Token delta: ${candidate.tokenDeltaPct}%\n- Approval: ${candidate.approval}\n`;
}

export async function generateApprovedSkills(candidates, root = ROOT) {
  const generated = [];
  for (const candidate of candidates) {
    if (candidate.approval !== "approved") continue;
    const slug = `mined-${candidate.taskId.replace(/[^a-z0-9-]+/giu, "-").toLowerCase()}`;
    const dir = path.join(root, ".agents/skills", slug);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "SKILL.md");
    try {
      await writeFile(file, renderMinedSkill(candidate), { encoding: "utf8", flag: "wx" });
      generated.push(path.relative(root, file));
    } catch (error) {
      if (error && error.code === "EEXIST") continue;
      throw error;
    }
  }
  return generated;
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
  const args = process.argv.slice(2);
  const records = await loadEvalRecords();
  let candidates = mineSkillCandidates(records);
  try {
    const previous = JSON.parse(await readFile(OUTPUT, "utf8"));
    const approvals = new Map(
      (previous.candidates ?? []).map((candidate) => [candidate.taskId, candidate.approval]),
    );
    candidates = candidates.map((candidate) =>
      approvals.get(candidate.taskId) === "approved"
        ? { ...candidate, approval: "approved" }
        : candidate,
    );
  } catch {
    // No previous approval file: all candidates require review.
  }
  const approveIndex = args.indexOf("--approve");
  if (approveIndex >= 0) {
    const taskId = args[approveIndex + 1];
    if (!taskId) throw new Error("--approve requires a taskId");
    const candidate = approveCandidate(candidates, taskId);
    const payload = { version: 1, generatedAt: new Date().toISOString(), candidates };
    await mkdir(path.dirname(OUTPUT), { recursive: true });
    await writeFile(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    process.stdout.write(`approved: ${candidate.taskId}\n`);
    return;
  }
  if (args.includes("--generate")) {
    const generated = await generateApprovedSkills(candidates);
    process.stdout.write(`generated skills: ${generated.length}\n${generated.join("\n")}\n`);
    return;
  }
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
