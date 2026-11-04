#!/usr/bin/env node
/** Runs only repository-owned local checks and records observed process output. */
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SELF_IMPROVE_EVALUATOR_CHECK } from "./self-improve-contract.mjs";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECEIPT_SCHEMA = "zcode.prism.receipt.v3";
const ARTIFACT_NAME = "self-improve-head-infrastructure-tests.log";
const RECEIPT_NAME = "receipts.jsonl";
export { SELF_IMPROVE_EVALUATOR_CHECK };
const PROTECTED_PATHS = Object.freeze([
  "scripts/self-improve-contract.mjs",
  "scripts/self-improve-evaluator.mjs",
  "scripts/test/self-improve-pr.test.mjs",
  "scripts/test/self-improve-evaluator.test.mjs",
]);
const HEAD_SNAPSHOT_FILES = Object.freeze([
  "scripts/self-improve-contract.mjs",
  "scripts/self-improve-pr.mjs",
  "scripts/test/self-improve-pr.test.mjs",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
const SAFE_ENV_KEYS = Object.freeze([
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SYSTEMROOT",
  "SystemRoot",
  "COMSPEC",
  "LANG",
  "LC_ALL",
  "TZ",
]);

function isWithinDirectory(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

function assertEvidenceOutsideCheckout(rootDirectory, evidenceDirectory) {
  if (
    isWithinDirectory(rootDirectory, evidenceDirectory) ||
    isWithinDirectory(evidenceDirectory, rootDirectory)
  ) {
    throw new Error("Evidence-каталог и checkout не должны пересекаться");
  }
}

function captureGit(args, cwd, { trim = true } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: createSafeEnvironment(),
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} завершился с кодом ${result.status}`);
  }
  return trim ? result.stdout.trim() : result.stdout;
}

function captureGitBuffer(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: null,
    env: createSafeEnvironment(),
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw new Error(`git ${args.join(" ")} не вернул ожидаемый объект HEAD`);
  }
  return result.stdout;
}

function readHeadBlob(rootDirectory, baseSha, relativePath) {
  const entryText = captureGit(["ls-tree", "-z", baseSha, "--", relativePath], rootDirectory, {
    trim: false,
  });
  const entries = entryText.split("\0").filter(Boolean);
  if (entries.length !== 1) {
    throw new Error(`В HEAD должен быть ровно один trusted test blob: ${relativePath}`);
  }
  const match = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/u.exec(entries[0]);
  if (!match || match[3] !== relativePath) {
    throw new Error(
      `HEAD test path должен быть обычным blob, не symlink/submodule: ${relativePath}`,
    );
  }
  return captureGitBuffer(["cat-file", "blob", match[2]], rootDirectory);
}

async function createHeadSnapshot(rootDirectory, baseSha) {
  const snapshotDirectory = await mkdtemp(
    path.join(os.tmpdir(), "zcode-prism-head-infrastructure-"),
  );
  try {
    for (const relativePath of HEAD_SNAPSHOT_FILES) {
      const targetPath = path.join(snapshotDirectory, relativePath);
      await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
      await writeFile(targetPath, readHeadBlob(rootDirectory, baseSha, relativePath), {
        flag: "wx",
        mode: 0o600,
      });
    }
    return snapshotDirectory;
  } catch (error) {
    await rm(snapshotDirectory, { recursive: true, force: true });
    throw error;
  }
}

function collectStagedCandidate(rootDirectory) {
  const branchName = captureGit(["branch", "--show-current"], rootDirectory);
  if (branchName !== "dev") {
    throw new Error(`Открой staged candidate на dev; текущая ветка: ${branchName || "неизвестно"}`);
  }

  const status = captureGit(
    ["status", "--porcelain", "--untracked-files=all", "-z"],
    rootDirectory,
    { trim: false },
  );
  const statusEntries = status ? status.split("\0").filter(Boolean) : [];
  if (
    statusEntries.some((entry) => {
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
      "Evaluator принимает только staged изменения без rename/copy, unstaged и untracked файлов",
    );
  }

  const pathsText = captureGit(
    ["diff", "--cached", "--name-only", "--no-renames", "-z", "HEAD"],
    rootDirectory,
    { trim: false },
  );
  const paths = pathsText ? pathsText.split("\0").filter(Boolean) : [];
  const secretPathPattern =
    /(?:^|\/)(?:\.env(?:\.[^/]*)?|auth\.json|id_(?:rsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx))$/iu;
  const unsafePath = paths.find((candidatePath) => secretPathPattern.test(candidatePath));
  if (unsafePath) throw new Error(`Кандидат содержит потенциальный секретный файл: ${unsafePath}`);

  const baseSha = captureGit(["rev-parse", "HEAD"], rootDirectory);
  const candidateDiff = captureGit(["diff", "--cached", "--binary", "HEAD"], rootDirectory, {
    trim: false,
  });
  return {
    paths,
    baseSha,
    candidateDiff,
    candidatePatchSha256: sha256(candidateDiff),
  };
}

function createSafeEnvironment(source = process.env) {
  const environment = {};
  for (const key of SAFE_ENV_KEYS) {
    if (typeof source[key] === "string") environment[key] = source[key];
  }
  environment.CI = "1";
  environment.NODE_ENV = "test";
  return environment;
}

export function terminateProcessTree(
  child,
  signal = "SIGTERM",
  {
    platform = process.platform,
    systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT,
    runTaskkill = spawnSync,
  } = {},
) {
  if (!child?.pid) return false;
  if (platform === "win32") {
    if (systemRoot) {
      try {
        runTaskkill(
          path.join(systemRoot, "System32", "taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"],
          {
            env: createSafeEnvironment(),
            stdio: "ignore",
            timeout: 5_000,
            windowsHide: true,
          },
        );
        // taskkill status 只表示请求已处理；最终结论由 terminateWindowsProcessTreeAndWait 的身份轮询给出。
        return true;
      } catch {
        // 如果 taskkill 无法启动，只尝试停止由 Node 句柄直接持有的 root。
      }
    }
    try {
      child.kill(signal);
    } catch {
      // Диагностический результат останется без receipt, если системный tree kill недоступен.
    }
    return false;
  }

  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    try {
      child.kill(signal);
    } catch {
      // A process that already exited has no remaining work to stop.
    }
    return false;
  }
}

function processGroupExists(processId) {
  try {
    process.kill(-processId, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function waitForProcessGroupExit(processId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(processId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processGroupExists(processId);
}

function parseWindowsProcessList(stdout) {
  const identities = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const [pidText, parentPidText, creationTime] = line.trim().split(/\s+/u);
    const pid = Number(pidText);
    const parentPid = Number(parentPidText);
    if (
      !Number.isInteger(pid) ||
      pid <= 0 ||
      !Number.isInteger(parentPid) ||
      parentPid < 0 ||
      !/^\d+$/u.test(creationTime ?? "")
    ) {
      continue;
    }
    identities.push({ pid, parentPid, creationTime });
  }
  return identities;
}

function readWindowsProcessList({ runProcessList = spawnSync } = {}) {
  const result = runProcessList(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Where-Object { $_.CreationDate -ne $null } | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().Ticks }",
    ],
    {
      encoding: "utf8",
      timeout: 1_000,
      windowsHide: true,
      env: createSafeEnvironment(),
    },
  );
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error("Не удалось получить проверяемые Windows process identities");
  }
  return parseWindowsProcessList(result.stdout);
}

function captureWindowsProcessTree(rootPid, identities) {
  const byPid = new Map(identities.map((identity) => [identity.pid, identity]));
  const byParentPid = new Map();
  for (const identity of identities) {
    const children = byParentPid.get(identity.parentPid) ?? [];
    children.push(identity);
    byParentPid.set(identity.parentPid, children);
  }
  const captured = [];
  const visited = new Set();
  const visit = (pid) => {
    const identity = byPid.get(pid);
    if (identity && !visited.has(identity.pid)) {
      visited.add(identity.pid);
      captured.push(identity);
    }
    for (const child of byParentPid.get(pid) ?? []) {
      if (visited.has(child.pid)) continue;
      visited.add(child.pid);
      captured.push(child);
      visit(child.pid);
    }
  };
  visit(rootPid);
  return captured;
}

export async function terminateWindowsProcessTreeAndWait(
  child,
  {
    systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT,
    runTaskkill = spawnSync,
    readProcessList = () => readWindowsProcessList(),
    timeoutMs = 1_000,
    pollIntervalMs = 25,
  } = {},
) {
  if (!child?.pid) return false;
  if (!systemRoot) {
    try {
      child.kill("SIGTERM");
    } catch {
      // 没有系统级 tree killer 和身份查询时，无法证明子进程已全部退出，因此保持 fail closed。
    }
    return false;
  }
  let identities;
  try {
    identities = captureWindowsProcessTree(child.pid, await readProcessList());
  } catch {
    identities = null;
  }
  // 根 PID 不在快照中时，操作系统可能已将该 PID 重新分配给其他进程。
  // 未记录创建时间就按 PID 调用 taskkill 可能会误杀无关进程。
  if (!identities?.some((identity) => identity.pid === child.pid)) {
    try {
      child.kill("SIGTERM");
    } catch {
      // 保持 fail closed，并且不对未经身份确认的 PID 调用 taskkill。
    }
    return false;
  }

  terminateProcessTree(child, "SIGTERM", {
    platform: "win32",
    systemRoot,
    runTaskkill,
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const liveByPid = new Map(
        (await readProcessList()).map((identity) => [identity.pid, identity]),
      );
      const originalIdentityAlive = identities.some((identity) => {
        const live = liveByPid.get(identity.pid);
        return live?.creationTime === identity.creationTime;
      });
      if (!originalIdentityAlive) return true;
    } catch {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  try {
    const liveByPid = new Map(
      (await readProcessList()).map((identity) => [identity.pid, identity]),
    );
    return !identities.some((identity) => {
      const live = liveByPid.get(identity.pid);
      return live?.creationTime === identity.creationTime;
    });
  } catch {
    return false;
  }
}

async function terminateProcessTreeAndWait(child) {
  if (process.platform === "win32") {
    return terminateWindowsProcessTreeAndWait(child);
  }

  if (!terminateProcessTree(child, "SIGTERM")) return false;
  if (await waitForProcessGroupExit(child.pid, 1_000)) return true;
  if (!terminateProcessTree(child, "SIGKILL")) return false;
  return waitForProcessGroupExit(child.pid, 1_000);
}

export function parseEvaluatorArgs(argv) {
  let evidenceDirectory;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--evidence-dir" || evidenceDirectory !== undefined) {
      throw new Error(`Неизвестный или повторный аргумент evaluator: ${argument}`);
    }
    const value = argv[index + 1];
    if (typeof value !== "string" || value.trim() === "" || value.startsWith("--")) {
      throw new Error("Укажи путь после --evidence-dir");
    }
    evidenceDirectory = value;
    index += 1;
  }
  return { evidenceDirectory };
}

async function createEvidenceDirectory(rootDirectory, requestedPath) {
  const root = await realpath(rootDirectory);
  let evidenceDirectory;
  if (requestedPath === undefined) {
    evidenceDirectory = await mkdtemp(path.join(os.tmpdir(), "zcode-prism-local-evidence-"));
  } else {
    const requested = path.resolve(root, requestedPath);
    const parent = await realpath(path.dirname(requested));
    evidenceDirectory = path.join(parent, path.basename(requested));
    assertEvidenceOutsideCheckout(root, evidenceDirectory);
    await mkdir(evidenceDirectory, { mode: 0o700 });
  }
  evidenceDirectory = await realpath(evidenceDirectory);
  assertEvidenceOutsideCheckout(root, evidenceDirectory);
  return evidenceDirectory;
}

function assertProtectedPaths(candidatePaths, rootDirectory, captureCommand = captureGit) {
  const changedProtectedPath = candidatePaths.find((candidatePath) =>
    PROTECTED_PATHS.includes(candidatePath),
  );
  if (changedProtectedPath) {
    throw new Error(
      `Evaluator не запускается при изменении собственного allowlist/evidence: ${changedProtectedPath}`,
    );
  }
  for (const protectedPath of PROTECTED_PATHS) {
    captureCommand(["cat-file", "-e", `HEAD:${protectedPath}`], rootDirectory);
  }
}

export function runAllowlistedCheck({
  rootDirectory = DEFAULT_ROOT,
  timeoutMs = SELF_IMPROVE_EVALUATOR_CHECK.timeoutMs,
  maxOutputBytes = SELF_IMPROVE_EVALUATOR_CHECK.maxOutputBytes,
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(process.execPath, SELF_IMPROVE_EVALUATOR_CHECK.args, {
        cwd: rootDirectory,
        env: createSafeEnvironment(),
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    const stdout = [];
    const stderr = [];
    let totalBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let treeTerminationConfirmed;
    let spawnError;
    let terminationPromise;
    const requestTreeTermination = () => {
      if (!terminationPromise) {
        terminationPromise = terminateProcessTreeAndWait(child).then((confirmed) => {
          treeTerminationConfirmed = confirmed;
          return confirmed;
        });
      }
      return terminationPromise;
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      void requestTreeTermination();
    }, timeoutMs);
    timeout.unref?.();

    const collect = (target) => (chunk) => {
      const bytes = Buffer.from(chunk);
      const remaining = Math.max(0, maxOutputBytes - totalBytes);
      if (remaining > 0) {
        const accepted = bytes.subarray(0, remaining);
        target.push(accepted);
        totalBytes += accepted.byteLength;
      }
      if (bytes.byteLength > remaining && !outputLimitExceeded) {
        outputLimitExceeded = true;
        void requestTreeTermination();
      }
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", async (exitCode, signal) => {
      clearTimeout(timeout);
      if (terminationPromise) await terminationPromise;
      resolve({
        exitCode,
        signal,
        timedOut,
        outputLimitExceeded,
        treeTerminationConfirmed,
        spawnError,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

function buildArtifactBytes(result) {
  const header = Buffer.from(
    `Команда: ${SELF_IMPROVE_EVALUATOR_CHECK.command}\n` +
      `evaluation_scope: ${SELF_IMPROVE_EVALUATOR_CHECK.evaluationScope}\n` +
      "source: exact HEAD Git blobs in isolated minimal snapshot\n" +
      `exit_code: ${String(result.exitCode)}\n` +
      `signal: ${String(result.signal ?? "none")}\n` +
      `timed_out: ${String(result.timedOut)}\n` +
      `output_limit_exceeded: ${String(result.outputLimitExceeded)}\n\n` +
      `tree_termination_confirmed: ${String(result.treeTerminationConfirmed ?? "not-required")}\n\n` +
      "--- stdout ---\n",
    "utf8",
  );
  const separator = Buffer.from("\n--- stderr ---\n", "utf8");
  return Buffer.concat([header, result.stdout, separator, result.stderr]);
}

export async function evaluateStagedCandidate({
  rootDirectory = DEFAULT_ROOT,
  evidenceDirectory: requestedEvidenceDirectory,
} = {}) {
  const candidate = collectStagedCandidate(rootDirectory);
  if (candidate.candidateDiff.trim() === "") {
    throw new Error("Нельзя оценивать пустой staged candidate");
  }
  assertProtectedPaths(candidate.paths, rootDirectory);
  const headSnapshot = await createHeadSnapshot(rootDirectory, candidate.baseSha);
  try {
    const evidenceDirectory = await createEvidenceDirectory(
      rootDirectory,
      requestedEvidenceDirectory,
    );
    const artifactPath = path.join(evidenceDirectory, ARTIFACT_NAME);
    const result = await runAllowlistedCheck({ rootDirectory: headSnapshot });
    const artifactBytes = buildArtifactBytes(result);
    if (artifactBytes.byteLength > SELF_IMPROVE_EVALUATOR_CHECK.maxArtifactBytes) {
      throw new Error(
        `Локальный stdout/stderr artifact превышает лимит ${SELF_IMPROVE_EVALUATOR_CHECK.maxArtifactBytes} bytes`,
      );
    }
    await writeFile(artifactPath, artifactBytes, { flag: "wx", mode: 0o600 });
    const storedArtifact = await readFile(artifactPath);
    const artifactSha256 = sha256(storedArtifact);

    if (
      result.spawnError ||
      result.exitCode !== 0 ||
      result.signal !== null ||
      result.timedOut ||
      result.outputLimitExceeded ||
      result.treeTerminationConfirmed === false
    ) {
      const details = result.timedOut
        ? "достигнут timeout"
        : result.outputLimitExceeded
          ? "превышен лимит stdout/stderr"
          : result.spawnError
            ? "не удалось запустить Node test process"
            : `процесс завершился с кодом ${String(result.exitCode)}`;
      throw new Error(
        `HEAD infrastructure self-test не пройден: ${details}; artifact: ${artifactPath}`,
      );
    }

    const currentCandidate = collectStagedCandidate(rootDirectory);
    if (
      currentCandidate.baseSha !== candidate.baseSha ||
      currentCandidate.candidatePatchSha256 !== candidate.candidatePatchSha256
    ) {
      throw new Error("HEAD или staged patch изменились во время инфраструктурного self-test");
    }

    const receipt = {
      schema: RECEIPT_SCHEMA,
      criterion_id: SELF_IMPROVE_EVALUATOR_CHECK.criterionId,
      evaluation_scope: SELF_IMPROVE_EVALUATOR_CHECK.evaluationScope,
      reported_status: "pass",
      command: SELF_IMPROVE_EVALUATOR_CHECK.command,
      exit_code: result.exitCode,
      observed_at: new Date().toISOString(),
      base_sha: candidate.baseSha,
      candidate_patch_sha256: candidate.candidatePatchSha256,
      artifact_path: ARTIFACT_NAME,
      artifact_sha256: artifactSha256,
    };
    const receiptPath = path.join(evidenceDirectory, RECEIPT_NAME);
    await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return {
      evidenceDirectory,
      receiptPath,
      artifactPath,
      receipt,
      acceptance: "VALIDATED_LOCAL",
      evaluationScope: SELF_IMPROVE_EVALUATOR_CHECK.evaluationScope,
    };
  } finally {
    await rm(headSnapshot, { recursive: true, force: true });
  }
}

export async function runEvaluatorCli(argv, options = {}) {
  const parsed = parseEvaluatorArgs(argv);
  return evaluateStagedCandidate({
    ...options,
    evidenceDirectory: parsed.evidenceDirectory,
  });
}

// macOS временный путь может идти через /var или /private/var; сравниваем канонические пути CLI.
const invokedPath = process.argv[1] ? realpathSync(path.resolve(process.argv[1])) : "";
const modulePath = realpathSync(fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
  runEvaluatorCli(process.argv.slice(2))
    .then((result) => {
      console.log(
        `VALIDATED_LOCAL (HEAD infrastructure self-test only; candidate is not evaluated): ${result.receiptPath}`,
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
