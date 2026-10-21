#!/usr/bin/env node
/**
 * Подготавливает Draft PR для явно staged кандидата. Локальные receipts не подтверждают
 * исполнение команды или независимую оценку; merge, release и promotion требуют отдельного решения.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECEIPT_SCHEMA = "zcode.prism.receipt.v2";
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

export const SELF_IMPROVE_RECEIPT_CRITERIA = Object.freeze({
  "SELF-IMPROVE-HELPER-TESTS": Object.freeze({
    command: "node --test scripts/test/self-improve-pr.test.mjs",
  }),
});

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isWithinDirectory(directory, filePath) {
  const relative = path.relative(directory, filePath);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function inspectLocalArtifact(evidenceDirectory, artifactPath) {
  if (
    typeof artifactPath !== "string" ||
    artifactPath.trim() === "" ||
    path.isAbsolute(artifactPath) ||
    path.win32.isAbsolute(artifactPath)
  ) {
    throw new Error(
      "Evidence artifact_path должен быть относительным путём внутри каталога evidence",
    );
  }

  let evidenceRoot;
  let resolvedArtifact;
  try {
    evidenceRoot = await realpath(evidenceDirectory);
    resolvedArtifact = await realpath(path.resolve(evidenceRoot, artifactPath));
  } catch {
    throw new Error("Evidence artifact не найден в каталоге evidence");
  }
  if (!isWithinDirectory(evidenceRoot, resolvedArtifact)) {
    throw new Error("Evidence artifact должен оставаться внутри каталога evidence");
  }

  let metadata;
  try {
    metadata = await lstat(path.resolve(evidenceRoot, artifactPath));
  } catch {
    throw new Error("Evidence artifact недоступен");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Evidence artifact должен быть обычным файлом, не symlink");
  }
  if (metadata.size > MAX_ARTIFACT_BYTES) {
    throw new Error("Evidence artifact превышает локальный лимит 10 MiB");
  }

  let handle;
  try {
    handle = await open(resolvedArtifact, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new Error("Evidence artifact не удалось безопасно открыть");
  }
  try {
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile() || openedMetadata.size > MAX_ARTIFACT_BYTES) {
      throw new Error("Evidence artifact должен быть обычным файлом размером не более 10 MiB");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
      throw new Error("Evidence artifact превышает локальный лимит 10 MiB");
    }
    return sha256(bytes);
  } finally {
    await handle.close();
  }
}

export async function parseCandidateEvidence(
  text,
  { baseSha, candidatePatchSha256, evidenceDirectory },
) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_EVIDENCE_BYTES) {
    throw new Error("Evidence JSONL отсутствует или превышает локальный лимит 1 MiB");
  }
  if (typeof evidenceDirectory !== "string" || evidenceDirectory.trim() === "") {
    throw new Error("Не указан каталог локальных evidence artifacts");
  }

  const rawRecords = text
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
        !hasExactKeys(value, [
          "schema",
          "criterion_id",
          "reported_status",
          "command",
          "exit_code",
          "observed_at",
          "base_sha",
          "candidate_patch_sha256",
          "artifact_path",
          "artifact_sha256",
        ]) ||
        value.schema !== RECEIPT_SCHEMA ||
        typeof value.criterion_id !== "string" ||
        value.criterion_id.trim() === "" ||
        value.reported_status !== "pass" ||
        typeof value.command !== "string" ||
        value.command !== SELF_IMPROVE_RECEIPT_CRITERIA[value.criterion_id]?.command ||
        value.exit_code !== 0 ||
        typeof value.observed_at !== "string" ||
        Number.isNaN(Date.parse(value.observed_at)) ||
        value.base_sha !== baseSha ||
        value.candidate_patch_sha256 !== candidatePatchSha256 ||
        !isSha256(value.artifact_sha256)
      ) {
        throw new Error(`Evidence JSONL строка ${index + 1} не соответствует receipt-контракту`);
      }
      return value;
    });

  const expectedCriteria = Object.keys(SELF_IMPROVE_RECEIPT_CRITERIA);
  const observedCriteria = rawRecords.map((record) => record.criterion_id);
  if (
    observedCriteria.length !== expectedCriteria.length ||
    new Set(observedCriteria).size !== observedCriteria.length ||
    expectedCriteria.some((criterionId) => !observedCriteria.includes(criterionId))
  ) {
    throw new Error("Evidence receipts должны содержать каждый allowlist criterion ровно один раз");
  }

  const records = [];
  for (const record of rawRecords) {
    const artifactSha256 = await inspectLocalArtifact(evidenceDirectory, record.artifact_path);
    if (artifactSha256 !== record.artifact_sha256) {
      throw new Error(
        `Evidence artifact для ${record.criterion_id} не совпадает с заявленным SHA-256`,
      );
    }
    // Этот hash подтверждает целостность локальных bytes, а не источник или исполнение команды.
    records.push({ ...record, artifact_sha256: artifactSha256 });
  }
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
  const expectedCriteria = Object.keys(SELF_IMPROVE_RECEIPT_CRITERIA);
  const observedCriteria = evidenceRecords.map((record) => record.criterion_id);
  if (
    observedCriteria.length !== expectedCriteria.length ||
    new Set(observedCriteria).size !== observedCriteria.length ||
    expectedCriteria.some((criterionId) => !observedCriteria.includes(criterionId)) ||
    evidenceRecords.some(
      (record) => record.command !== SELF_IMPROVE_RECEIPT_CRITERIA[record.criterion_id]?.command,
    )
  ) {
    throw new Error(
      "Candidate содержит неразрешённый, отсутствующий или повторный allowlist criterion",
    );
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
    "Статус evidence: VALIDATED_LOCAL; результат не подтверждён внешним evaluator.",
    "",
    "## Allowlist checks и локальные artifacts",
    "",
    ...evidenceRecords.map(
      (record) =>
        `- ${record.criterion_id}: заявлена команда \`${SELF_IMPROVE_RECEIPT_CRITERIA[record.criterion_id].command}\`; локально пересчитанный artifact SHA-256 \`${record.artifact_sha256}\``,
    ),
    "",
    "Локальный файл проверен только на целостность bytes и соответствие hash. Receipt сам заявляет команду, exit status и artifact; этот helper не удостоверяет запуск команды, provenance, независимость оценки или улучшение системы. CI и независимое ревью должны выполнить собственную проверку. Этот Draft PR не мержится и не выпускается автоматически.",
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
      [
        "gh",
        "pr",
        "create",
        "--draft",
        "--base",
        base,
        "--head",
        branch,
        "--title",
        title,
        "--body",
        body,
      ],
    ],
  };
}

function capture(command, trim = true, cwd = DEFAULT_ROOT) {
  const [file, ...args] = command;
  const result = spawnSync(file, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${file} завершился с кодом ${result.status}: ${(result.stderr || "").trim()}`);
  }
  return trim ? result.stdout.trim() : result.stdout;
}

function run(command, cwd = DEFAULT_ROOT) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
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

function assertOnlyStagedChanges(cwd, captureCommand = capture) {
  const status = captureCommand(
    ["git", "status", "--porcelain", "--untracked-files=all", "-z"],
    false,
    cwd,
  );
  const entries = status ? status.split("\0").filter(Boolean) : [];
  if (
    entries.some((entry) => {
      const statusCode = entry.slice(0, 2);
      return (
        statusCode.includes("R") ||
        statusCode.includes("C") ||
        statusCode.startsWith("??") ||
        statusCode[0] === " " ||
        statusCode[1] !== " "
      );
    })
  ) {
    throw new Error(
      "Самоулучшение требует только staged изменений без rename/copy; unstaged/untracked файлы запрещены",
    );
  }
  const stagedPaths = captureCommand(
    ["git", "diff", "--cached", "--name-only", "--no-renames", "-z", "HEAD"],
    false,
    cwd,
  );
  return stagedPaths ? stagedPaths.split("\0").filter(Boolean) : [];
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

function localBranchExists(cwd, branch) {
  const result = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd,
    encoding: "utf8",
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git show-ref завершился с кодом ${result.status}`);
}

export async function runSelfImproveCli(
  argv,
  {
    rootDirectory = DEFAULT_ROOT,
    captureCommand = capture,
    runCommand = run,
    branchExists = localBranchExists,
    log = console.log,
  } = {},
) {
  const options = parseArgs(argv);
  const commandCapture = (command, trim = true) => captureCommand(command, trim, rootDirectory);
  const commandRun = (command) => runCommand(command, rootDirectory);
  const branchName = commandCapture(["git", "branch", "--show-current"]);
  if (branchName !== "dev")
    throw new Error(`Открой staged candidate на dev; текущая ветка: ${branchName}`);
  const paths = assertOnlyStagedChanges(rootDirectory, captureCommand);
  validateCandidatePaths(paths);
  const baseSha = commandCapture(["git", "rev-parse", "HEAD"]);
  const candidateDiff = commandCapture(["git", "diff", "--cached", "--binary", "HEAD"], false);
  const candidatePatchSha256 = sha256(candidateDiff);
  const evidencePath = path.resolve(rootDirectory, options.evidencePath);
  let evidenceMetadata;
  try {
    evidenceMetadata = await lstat(evidencePath);
  } catch {
    throw new Error("Evidence JSONL не найден");
  }
  if (!evidenceMetadata.isFile() || evidenceMetadata.isSymbolicLink()) {
    throw new Error("Evidence JSONL должен быть обычным файлом, не symlink");
  }
  if (evidenceMetadata.size > MAX_EVIDENCE_BYTES) {
    throw new Error("Evidence JSONL превышает локальный лимит 1 MiB");
  }
  const evidenceText = await readFile(evidencePath, "utf8");
  const evidenceRecords = await parseCandidateEvidence(evidenceText, {
    baseSha,
    candidatePatchSha256,
    evidenceDirectory: path.dirname(evidencePath),
  });
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-").slice(0, 19);
  const plan = buildSelfImprovePlan({
    branch: `self-improve/${stamp}-${baseSha.slice(0, 8)}`,
    base: "dev",
    baseSha,
    candidateDiff,
    evidenceRecords,
  });
  if (branchExists(rootDirectory, plan.branch)) {
    throw new Error(`Локальная ветка уже существует: ${plan.branch}`);
  }
  if (!options.apply) {
    log(`Готов candidate ${plan.candidatePatchSha256} для ${plan.branch}`);
    log("Команды после явного --apply:");
    log(
      JSON.stringify(
        plan.commands.map((command) =>
          command[0] === "gh" ? [...command.slice(0, -1), "[generated PR body]"] : command,
        ),
        null,
        2,
      ),
    );
    return { plan, applied: false };
  }
  await commandRun(["git", "fetch", "origin", "dev"]);
  if (commandCapture(["git", "rev-parse", "origin/dev"]) !== baseSha) {
    throw new Error(
      "Локальный dev устарел относительно origin/dev; обнови базу и повтори evaluation",
    );
  }
  const remoteBranch = commandCapture(["git", "ls-remote", "--heads", "origin", plan.branch]);
  if (remoteBranch) throw new Error(`Удалённая ветка уже существует: ${plan.branch}`);
  for (const command of plan.commands) await commandRun(command);
  return { plan, applied: true };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  runSelfImproveCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
