#!/usr/bin/env node
/**
 * Создаёт отдельный PR для явно staged кандидата. Структурные receipts не являются
 * подтверждением независимой оценки: merge, release и promotion требуют отдельного решения.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECEIPT_SCHEMA = "zcode.prism.receipt.v1";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isSafeArtifactUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

export function parseCandidateEvidence(text, { baseSha, candidatePatchSha256 }) {
  const records = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error(`Evidence JSONL строка ${index + 1} повреждена`);
      }
      if (
        !value ||
        typeof value !== "object" ||
        value.schema !== RECEIPT_SCHEMA ||
        typeof value.criterion_id !== "string" ||
        value.criterion_id.trim() === "" ||
        value.status !== "pass" ||
        typeof value.command !== "string" ||
        value.command.trim() === "" ||
        value.exit_code !== 0 ||
        typeof value.observed_at !== "string" ||
        Number.isNaN(Date.parse(value.observed_at)) ||
        value.base_sha !== baseSha ||
        value.candidate_patch_sha256 !== candidatePatchSha256 ||
        typeof value.artifact_url !== "string" ||
        !isSafeArtifactUrl(value.artifact_url) ||
        !/^[a-f0-9]{64}$/iu.test(value.artifact_sha256 ?? "")
      ) {
        throw new Error(`Evidence JSONL строка ${index + 1} не соответствует receipt-контракту`);
      }
      return value;
    });
  if (records.length === 0) throw new Error("Нет evidence receipts для candidate");
  return records;
}

export function validateCandidatePaths(paths) {
  const secretPathPattern =
    /(?:^|\/)(?:\.env(?:\.[^/]*)?|auth\.json|id_(?:rsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx))$/iu;
  const unsafe = paths.find((filePath) => secretPathPattern.test(filePath));
  if (unsafe) throw new Error(`Кандидат содержит потенциальный секретный файл: ${unsafe}`);
}

export function buildSelfImprovePlan({ branch, base, baseSha, candidateDiff, evidenceRecords }) {
  if (base !== "dev" || branch === "main" || branch === "master" || base === branch) {
    throw new Error("Кандидат может открывать PR только в dev, не в main");
  }
  if (!branch.startsWith("self-improve/")) {
    throw new Error("Ветка должна иметь префикс self-improve/");
  }
  if (typeof candidateDiff !== "string" || candidateDiff.trim() === "") {
    throw new Error("Пустой candidate diff нельзя отправить в PR");
  }
  if (!Array.isArray(evidenceRecords) || evidenceRecords.length === 0) {
    throw new Error("Для PR обязательны валидные evidence receipts");
  }
  const patchHash = sha256(candidateDiff);
  if (evidenceRecords.some((record) => record.candidate_patch_sha256 !== patchHash)) {
    throw new Error("Evidence относится к другому candidate patch");
  }
  if (evidenceRecords.some((record) => record.base_sha !== baseSha)) {
    throw new Error("Evidence относится к другой базовой ревизии");
  }
  const title = "Кандидат PRISM для независимого ревью";
  const body = [
    "## Кандидат",
    "",
    `База: \`${base}\` (${baseSha})`,
    `SHA-256 staged patch: \`${patchHash}\``,
    `Проверок с локальными receipts: ${evidenceRecords.length}`,
    "",
    "## Receipts",
    "",
    ...evidenceRecords.map(
      (record) =>
        `- ${record.criterion_id}: [receipt](${record.artifact_url}) \`${record.artifact_sha256}\``,
    ),
    "",
    "Receipts проверены только по схеме и привязке к patch/base. Они не удостоверяют артефакты, независимость оценщика или улучшение модели. CI и независимое ревью должны выполнить собственную проверку. Этот PR не мержится и не выпускается автоматически.",
  ].join("\n");
  return {
    branch,
    base,
    title,
    body,
    candidatePatchSha256: patchHash,
    commands: [
      ["git", "switch", "-c", branch],
      ["git", "commit", "-m", "Подготовить кандидата PRISM к ревью."],
      ["git", "push", "-u", "origin", branch],
      ["gh", "pr", "create", "--base", base, "--head", branch, "--title", title, "--body", body],
    ],
  };
}

function capture(command, trim = true) {
  const [file, ...args] = command;
  const result = spawnSync(file, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${file} завершился с кодом ${result.status}: ${(result.stderr || "").trim()}`);
  }
  return trim ? result.stdout.trim() : result.stdout;
}

function run(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command[0]} завершился с кодом ${code}`));
    });
  });
}

function assertOnlyStagedChanges() {
  const status = capture(["git", "status", "--porcelain", "--untracked-files=all"]);
  const lines = status ? status.split("\n") : [];
  if (lines.some((line) => line.startsWith("??") || line[0] === " " || line[1] !== " ")) {
    throw new Error(
      "Самоулучшение требует только staged изменений; unstaged/untracked файлы запрещены",
    );
  }
  return lines.map((line) => line.slice(3));
}

function parseArgs(argv) {
  const options = { apply: false, evidencePath: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--evidence") options.evidencePath = argv[++index];
    else throw new Error(`Неизвестный аргумент: ${argument}`);
  }
  if (!options.evidencePath) throw new Error("Укажи --evidence <receipt.jsonl>");
  return options;
}

function localBranchExists(branch) {
  const result = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git show-ref завершился с кодом ${result.status}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const branchName = capture(["git", "branch", "--show-current"]);
  if (branchName !== "dev")
    throw new Error(`Открой staged candidate на dev; текущая ветка: ${branchName}`);
  const paths = assertOnlyStagedChanges();
  validateCandidatePaths(paths);
  const baseSha = capture(["git", "rev-parse", "HEAD"]);
  const candidateDiff = capture(["git", "diff", "--cached", "--binary", "HEAD"], false);
  const candidatePatchSha256 = sha256(candidateDiff);
  const evidenceText = await readFile(path.resolve(options.evidencePath), "utf8");
  const evidenceRecords = parseCandidateEvidence(evidenceText, { baseSha, candidatePatchSha256 });
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-").slice(0, 19);
  const plan = buildSelfImprovePlan({
    branch: `self-improve/${stamp}-${baseSha.slice(0, 8)}`,
    base: "dev",
    baseSha,
    candidateDiff,
    evidenceRecords,
  });
  if (localBranchExists(plan.branch)) {
    throw new Error(`Локальная ветка уже существует: ${plan.branch}`);
  }
  if (!options.apply) {
    console.log(`Готов candidate ${plan.candidatePatchSha256} для ${plan.branch}`);
    console.log("Команды после явного --apply:");
    console.log(
      JSON.stringify(
        plan.commands.map((command) =>
          command[0] === "gh" ? [...command.slice(0, -1), "[generated PR body]"] : command,
        ),
        null,
        2,
      ),
    );
    return;
  }
  await run(["git", "fetch", "origin", "dev"]);
  if (capture(["git", "rev-parse", "origin/dev"]) !== baseSha) {
    throw new Error(
      "Локальный dev устарел относительно origin/dev; обнови базу и повтори evaluation",
    );
  }
  const remoteBranch = capture(["git", "ls-remote", "--heads", "origin", plan.branch]);
  if (remoteBranch) throw new Error(`Удалённая ветка уже существует: ${plan.branch}`);
  for (const command of plan.commands) await run(command);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
