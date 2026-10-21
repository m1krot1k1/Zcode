import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SELF_IMPROVE_EVALUATOR_CHECK,
  evaluateStagedCandidate,
  parseEvaluatorArgs,
  runAllowlistedCheck,
  terminateProcessTree,
} from "../self-improve-evaluator.mjs";
import { SELF_IMPROVE_RECEIPT_CRITERIA as evaluatorReceiptCriteria } from "../self-improve-contract.mjs";
import {
  SELF_IMPROVE_RECEIPT_CRITERIA,
  parseCandidateEvidence,
  sha256,
} from "../self-improve-pr.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PROTECTED_FILES = [
  "scripts/self-improve-contract.mjs",
  "scripts/self-improve-evaluator.mjs",
  "scripts/test/self-improve-pr.test.mjs",
  "scripts/test/self-improve-evaluator.test.mjs",
];

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

async function createFixture(
  t,
  { candidateText = "// staged candidate\n", candidatePath, headHelperSuffix = "" } = {},
) {
  const parentDirectory = await mkdtemp(path.join(os.tmpdir(), "zcode-prism-evaluator-"));
  t.after(() => rm(parentDirectory, { recursive: true, force: true }));
  const rootDirectory = path.join(parentDirectory, "repo");
  const evidenceDirectory = path.join(parentDirectory, "evidence");
  await mkdir(rootDirectory);

  for (const relativePath of [...PROTECTED_FILES, "scripts/self-improve-pr.mjs"]) {
    const target = path.join(rootDirectory, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(path.join(REPO_ROOT, relativePath)));
  }
  if (headHelperSuffix) {
    await writeFile(path.join(rootDirectory, "scripts/self-improve-pr.mjs"), headHelperSuffix, {
      flag: "a",
    });
  }

  git(rootDirectory, ["init", "--initial-branch=dev"]);
  git(rootDirectory, ["config", "user.name", "PRISM Evaluator Test"]);
  git(rootDirectory, ["config", "user.email", "prism-evaluator@example.invalid"]);
  git(rootDirectory, ["config", "commit.gpgsign", "false"]);
  git(rootDirectory, ["add", "scripts"]);
  git(rootDirectory, ["commit", "-m", "Создать базу evaluator fixture"]);

  const targetPath = candidatePath ?? "scripts/self-improve-pr.mjs";
  const candidateFile = path.join(rootDirectory, targetPath);
  if (targetPath !== "scripts/self-improve-pr.mjs") {
    await mkdir(path.dirname(candidateFile), { recursive: true });
  }
  await writeFile(candidateFile, candidateText, {
    flag: targetPath === "scripts/self-improve-pr.mjs" ? "a" : "w",
  });
  git(rootDirectory, ["add", "--", targetPath]);

  return { parentDirectory, rootDirectory, evidenceDirectory, targetPath };
}

test("allowlist и parser не принимают команды или подменяемые результаты", () => {
  assert.deepEqual(SELF_IMPROVE_EVALUATOR_CHECK.args, [
    "--test",
    "scripts/test/self-improve-pr.test.mjs",
  ]);
  assert.equal(
    evaluatorReceiptCriteria[SELF_IMPROVE_EVALUATOR_CHECK.criterionId].command,
    SELF_IMPROVE_RECEIPT_CRITERIA[SELF_IMPROVE_EVALUATOR_CHECK.criterionId].command,
  );
  assert.equal(SELF_IMPROVE_EVALUATOR_CHECK.evaluationScope, "HEAD_INFRASTRUCTURE_ONLY");
  assert.deepEqual(parseEvaluatorArgs([]), { evidenceDirectory: undefined });
  assert.deepEqual(parseEvaluatorArgs(["--evidence-dir", "/tmp/evidence"]), {
    evidenceDirectory: "/tmp/evidence",
  });
  assert.throws(() => parseEvaluatorArgs(["--command", "exit 0"]), /Неизвестный/u);
  assert.throws(() => parseEvaluatorArgs(["--exit-code", "0"]), /Неизвестный/u);
  assert.throws(() => parseEvaluatorArgs(["--artifact-sha256", "a".repeat(64)]), /Неизвестный/u);
  assert.throws(
    () => parseEvaluatorArgs(["--evidence-dir", "a", "--evidence-dir", "b"]),
    /повторный/u,
  );
  assert.throws(() => parseEvaluatorArgs(["--evidence-dir", "--command"]), /Укажи путь/u);
});

test("валидный staged diff запускает реальный allowlist child и создаёт проверяемый receipt", async (t) => {
  const candidateSentinel = path.join(os.tmpdir(), `zcode-candidate-${process.pid}-${Date.now()}`);
  t.after(() => rm(candidateSentinel, { force: true }));
  const fixture = await createFixture(t, {
    candidateText: `\nawait import("node:fs/promises").then(({ writeFile }) => writeFile(${JSON.stringify(candidateSentinel)}, "executed"));\n`,
  });
  const evaluatorCli = path.join(fixture.rootDirectory, "scripts/self-improve-evaluator.mjs");
  const cliResult = spawnSync(
    process.execPath,
    [evaluatorCli, "--evidence-dir", fixture.evidenceDirectory],
    {
      cwd: fixture.rootDirectory,
      encoding: "utf8",
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        CI: "1",
        NODE_ENV: "test",
      },
    },
  );
  assert.equal(cliResult.status, 0, cliResult.stderr);
  assert.match(
    cliResult.stdout,
    /^VALIDATED_LOCAL \(HEAD infrastructure self-test only; candidate is not evaluated\): .+receipts\.jsonl\s*$/u,
  );
  await assert.rejects(access(candidateSentinel), { code: "ENOENT" });

  const receiptPath = path.join(fixture.evidenceDirectory, "receipts.jsonl");
  const receipt = JSON.parse((await readFile(receiptPath, "utf8")).trim());
  const artifactPath = path.join(
    fixture.evidenceDirectory,
    "self-improve-head-infrastructure-tests.log",
  );
  assert.equal(receipt.exit_code, 0);
  assert.equal(receipt.command, SELF_IMPROVE_EVALUATOR_CHECK.command);
  assert.equal(receipt.evaluation_scope, "HEAD_INFRASTRUCTURE_ONLY");
  assert.equal(receipt.base_sha, git(fixture.rootDirectory, ["rev-parse", "HEAD"]));

  const stagedPatch = spawnSync("git", ["diff", "--cached", "--binary", "HEAD"], {
    cwd: fixture.rootDirectory,
    encoding: "utf8",
  });
  assert.equal(stagedPatch.status, 0, stagedPatch.stderr);
  assert.equal(receipt.candidate_patch_sha256, sha256(stagedPatch.stdout));
  assert.match(await readFile(artifactPath, "utf8"), /receipt принимает только repo allowlist/u);

  const parsed = await parseCandidateEvidence(await readFile(receiptPath, "utf8"), {
    baseSha: receipt.base_sha,
    candidatePatchSha256: receipt.candidate_patch_sha256,
    evidenceDirectory: fixture.evidenceDirectory,
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].artifact_sha256, receipt.artifact_sha256);
});

test("провал фиксированных тестов оставляет только наблюдённый artifact без pass receipt", async (t) => {
  const fixture = await createFixture(t, {
    candidatePath: "candidate.txt",
    candidateText: "candidate source is not executed\n",
    headHelperSuffix: "\nthrow new Error('intentional trusted HEAD failure');\n",
  });

  await assert.rejects(
    evaluateStagedCandidate(fixture),
    (error) => error.message.includes("artifact:") && error.message.includes("не пройден"),
  );
  const files = await readdir(fixture.evidenceDirectory);
  assert.deepEqual(files, ["self-improve-head-infrastructure-tests.log"]);
  assert.match(
    await readFile(
      path.join(fixture.evidenceDirectory, "self-improve-head-infrastructure-tests.log"),
      "utf8",
    ),
    /intentional trusted HEAD failure/u,
  );
});

test("изменение evaluator/check fixture отклоняется до запуска и записи evidence", async (t) => {
  const fixture = await createFixture(t, {
    candidatePath: "scripts/self-improve-evaluator.mjs",
    candidateText: "// попытка изменить доверенный evaluator\n",
  });

  await assert.rejects(evaluateStagedCandidate(fixture), /изменении собственного allowlist/u);
  await assert.rejects(access(fixture.evidenceDirectory), { code: "ENOENT" });
});

test("protected self-test нельзя подменить staged symlink или submodule", async (t) => {
  await t.test("symlink на внешний тест отклоняется до запуска", async (t) => {
    const fixture = await createFixture(t);
    const protectedPath = path.join(fixture.rootDirectory, "scripts/test/self-improve-pr.test.mjs");
    const externalTest = path.join(fixture.parentDirectory, "untrusted-test.mjs");
    const sentinel = path.join(fixture.parentDirectory, "untrusted-test-executed");
    await writeFile(
      externalTest,
      `await import("node:fs/promises").then(({ writeFile }) => writeFile(${JSON.stringify(sentinel)}, "executed"));\n`,
    );
    await rm(protectedPath);
    await symlink(externalTest, protectedPath);
    git(fixture.rootDirectory, ["add", "--", "scripts/test/self-improve-pr.test.mjs"]);

    await assert.rejects(evaluateStagedCandidate(fixture), /изменении собственного/u);
    await assert.rejects(access(fixture.evidenceDirectory), { code: "ENOENT" });
    await assert.rejects(access(sentinel), { code: "ENOENT" });
  });

  await t.test("gitlink на внешний submodule отклоняется до snapshot", async (t) => {
    const fixture = await createFixture(t);
    const submoduleDirectory = path.join(fixture.parentDirectory, "submodule");
    await mkdir(submoduleDirectory);
    git(submoduleDirectory, ["init", "--initial-branch=dev"]);
    git(submoduleDirectory, ["config", "user.name", "PRISM Submodule Test"]);
    git(submoduleDirectory, ["config", "user.email", "prism-submodule@example.invalid"]);
    await writeFile(path.join(submoduleDirectory, "test.mjs"), "// untrusted submodule\n");
    git(submoduleDirectory, ["add", "test.mjs"]);
    git(submoduleDirectory, ["commit", "-m", "Создать локальный submodule fixture"]);

    const protectedPath = "scripts/test/self-improve-pr.test.mjs";
    git(fixture.rootDirectory, ["rm", "--", protectedPath]);
    git(fixture.rootDirectory, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      submoduleDirectory,
      protectedPath,
    ]);

    await assert.rejects(evaluateStagedCandidate(fixture), /изменении собственного/u);
    await assert.rejects(access(fixture.evidenceDirectory), { code: "ENOENT" });
  });
});

test("linked worktree использует свой HEAD object database и не исполняет staged helper", async (t) => {
  const fixture = await createFixture(t);
  git(fixture.rootDirectory, ["branch", "-m", "fixture-base"]);
  const worktreeDirectory = path.join(fixture.parentDirectory, "linked-worktree");
  git(fixture.rootDirectory, ["worktree", "add", "-b", "dev", worktreeDirectory, "HEAD"]);
  const sentinel = path.join(fixture.parentDirectory, "worktree-candidate-executed");
  await writeFile(
    path.join(worktreeDirectory, "scripts/self-improve-pr.mjs"),
    `\nawait import("node:fs/promises").then(({ writeFile }) => writeFile(${JSON.stringify(sentinel)}, "executed"));\n`,
    { flag: "a" },
  );
  git(worktreeDirectory, ["add", "scripts/self-improve-pr.mjs"]);

  const result = await evaluateStagedCandidate({
    rootDirectory: worktreeDirectory,
    evidenceDirectory: fixture.evidenceDirectory,
  });
  assert.equal(result.evaluationScope, "HEAD_INFRASTRUCTURE_ONLY");
  await assert.rejects(access(sentinel), { code: "ENOENT" });
});

test("admission требует dev и только staged путями без секретов", async (t) => {
  await t.test("отклоняет ветку кроме dev", async (t) => {
    const fixture = await createFixture(t);
    git(fixture.rootDirectory, ["branch", "-m", "main"]);
    await assert.rejects(evaluateStagedCandidate(fixture), /текущая ветка: main/u);
    await assert.rejects(access(fixture.evidenceDirectory), { code: "ENOENT" });
  });

  await t.test("отклоняет unstaged изменения", async (t) => {
    const fixture = await createFixture(t);
    await writeFile(path.join(fixture.rootDirectory, fixture.targetPath), "unstaged edit\n", {
      flag: "a",
    });
    await assert.rejects(evaluateStagedCandidate(fixture), /только staged изменения/u);
    await assert.rejects(access(fixture.evidenceDirectory), { code: "ENOENT" });
  });

  await t.test("отклоняет untracked файлы", async (t) => {
    const fixture = await createFixture(t);
    await writeFile(path.join(fixture.rootDirectory, "untracked.txt"), "not staged\n");
    await assert.rejects(evaluateStagedCandidate(fixture), /только staged изменения/u);
    await assert.rejects(access(fixture.evidenceDirectory), { code: "ENOENT" });
  });

  await t.test("отклоняет staged rename", async (t) => {
    const fixture = await createFixture(t);
    git(fixture.rootDirectory, ["mv", fixture.targetPath, "scripts/self-improve-renamed.mjs"]);
    await assert.rejects(evaluateStagedCandidate(fixture), /rename\/copy/u);
    await assert.rejects(access(fixture.evidenceDirectory), { code: "ENOENT" });
  });

  await t.test("отклоняет потенциальный secret path", async (t) => {
    const fixture = await createFixture(t, { candidatePath: ".env.local" });
    await assert.rejects(evaluateStagedCandidate(fixture), /потенциальный секретный файл/u);
    await assert.rejects(access(fixture.evidenceDirectory), { code: "ENOENT" });
  });
});

test("runner останавливает allowlisted child по timeout и ограничению вывода", async () => {
  const timeoutResult = await runAllowlistedCheck({ rootDirectory: REPO_ROOT, timeoutMs: 1 });
  assert.equal(timeoutResult.timedOut, true);
  assert.notEqual(timeoutResult.exitCode, 0);
  if (process.platform !== "win32") {
    assert.equal(timeoutResult.treeTerminationConfirmed, true);
  }

  const outputResult = await runAllowlistedCheck({ rootDirectory: REPO_ROOT, maxOutputBytes: 1 });
  assert.equal(outputResult.outputLimitExceeded, true);
  assert.ok(outputResult.stdout.byteLength + outputResult.stderr.byteLength <= 1);
});

test(
  "завершение timeout process group убивает дочерний процесс",
  { skip: process.platform === "win32" && !process.env.SystemRoot && !process.env.SYSTEMROOT },
  async (t) => {
    const childSource = [
      'import { spawn } from "node:child_process";',
      'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      "console.log(grandchild.pid);",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const parent = spawn(process.execPath, ["--input-type=module", "-e", childSource], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "ignore"],
    });
    t.after(() => terminateProcessTree(parent, "SIGKILL"));

    const grandchildPid = await new Promise((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(
        () => reject(new Error("process fixture did not report child PID")),
        5_000,
      );
      parent.stdout.on("data", (chunk) => {
        output += chunk.toString("utf8");
        const match = /(?:^|\n)(\d+)(?:\n|$)/u.exec(output);
        if (match) {
          clearTimeout(timeout);
          resolve(Number(match[1]));
        }
      });
      parent.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    assert.ok(grandchildPid > 0);
    assert.equal(terminateProcessTree(parent, "SIGTERM"), true);
    await new Promise((resolve) => parent.once("close", resolve));

    let descendantStopped = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        process.kill(grandchildPid, 0);
      } catch (error) {
        if (error?.code === "ESRCH") {
          descendantStopped = true;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(
      descendantStopped,
      true,
      `descendant ${grandchildPid} survived process-tree termination`,
    );
  },
);
