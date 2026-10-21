import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SELF_IMPROVE_RECEIPT_CRITERIA,
  buildSelfImprovePlan,
  parseCandidateEvidence,
  runSelfImproveCli,
  sha256,
  validateCandidatePaths,
} from "../self-improve-pr.mjs";

const baseSha = "1".repeat(40);
const patch = "diff --git a/a.ts b/a.ts\n+change\n";
const patchSha = sha256(patch);
const criterionId = Object.keys(SELF_IMPROVE_RECEIPT_CRITERIA)[0];
const command = SELF_IMPROVE_RECEIPT_CRITERIA[criterionId].command;
const evaluationScope = SELF_IMPROVE_RECEIPT_CRITERIA[criterionId].evaluationScope;

function git(cwd, args, { trim = true } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(" ")} failed`);
  return trim ? result.stdout.trim() : result.stdout;
}

async function createEvidenceDirectory(t) {
  const evidenceDirectory = await mkdtemp(path.join(os.tmpdir(), "zcode-prism-evidence-"));
  t.after(() => rm(evidenceDirectory, { recursive: true, force: true }));
  const artifactBytes = Buffer.from("test output\n", "utf8");
  await writeFile(path.join(evidenceDirectory, "helper-tests.log"), artifactBytes);
  const receipt = {
    schema: "zcode.prism.receipt.v3",
    criterion_id: criterionId,
    evaluation_scope: evaluationScope,
    reported_status: "pass",
    command,
    exit_code: 0,
    observed_at: "2026-10-21T00:00:00Z",
    base_sha: baseSha,
    candidate_patch_sha256: patchSha,
    artifact_path: "helper-tests.log",
    artifact_sha256: sha256(artifactBytes),
  };
  const evidencePath = path.join(evidenceDirectory, "receipts.jsonl");
  await writeFile(evidencePath, `${JSON.stringify(receipt)}\n`);
  return { evidenceDirectory, evidencePath, receipt, artifactBytes };
}

async function createGitFixture(
  t,
  { secretCandidate = false, secretRenameCandidate = false } = {},
) {
  const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "zcode-self-improve-git-"));
  t.after(() => rm(fixtureDirectory, { recursive: true, force: true }));
  const rootDirectory = path.join(fixtureDirectory, "repo");
  const originDirectory = path.join(fixtureDirectory, "origin.git");
  await mkdir(rootDirectory);
  git(fixtureDirectory, ["init", "--bare", "--initial-branch=dev", originDirectory]);
  git(rootDirectory, ["init", "--initial-branch=dev"]);
  git(rootDirectory, ["config", "user.name", "PRISM Test"]);
  git(rootDirectory, ["config", "user.email", "prism-test@example.invalid"]);
  await writeFile(path.join(rootDirectory, "baseline.txt"), "baseline\n");
  if (secretRenameCandidate) {
    await writeFile(path.join(rootDirectory, ".env.local"), "secret-from-old-path\n");
  }
  git(rootDirectory, ["add", "baseline.txt"]);
  if (secretRenameCandidate) git(rootDirectory, ["add", ".env.local"]);
  git(rootDirectory, ["commit", "-m", "Создать локальную базу"]);
  git(rootDirectory, ["remote", "add", "origin", originDirectory]);
  git(rootDirectory, ["push", "-u", "origin", "dev"]);

  const candidatePath = secretCandidate ? ".env.local" : "candidate.txt";
  if (secretRenameCandidate) {
    git(rootDirectory, ["mv", ".env.local", "candidate.txt"]);
  } else {
    await writeFile(path.join(rootDirectory, candidatePath), "candidate\n");
    git(rootDirectory, ["add", candidatePath]);
  }
  const actualBaseSha = git(rootDirectory, ["rev-parse", "HEAD"]);
  const candidatePatch = git(rootDirectory, ["diff", "--cached", "--binary", "HEAD"], {
    trim: false,
  });
  const evidenceDirectory = await mkdtemp(path.join(os.tmpdir(), "zcode-prism-evidence-"));
  t.after(() => rm(evidenceDirectory, { recursive: true, force: true }));
  const artifactBytes = Buffer.from("self-improve test output\n", "utf8");
  await writeFile(path.join(evidenceDirectory, "helper-tests.log"), artifactBytes);
  const receipt = {
    schema: "zcode.prism.receipt.v3",
    criterion_id: criterionId,
    evaluation_scope: evaluationScope,
    reported_status: "pass",
    command,
    exit_code: 0,
    observed_at: "2026-10-21T00:00:00Z",
    base_sha: actualBaseSha,
    candidate_patch_sha256: sha256(candidatePatch),
    artifact_path: "helper-tests.log",
    artifact_sha256: sha256(artifactBytes),
  };
  const evidencePath = path.join(evidenceDirectory, "receipts.jsonl");
  await writeFile(evidencePath, `${JSON.stringify(receipt)}\n`);
  return { rootDirectory, originDirectory, evidenceDirectory, evidencePath, receipt };
}

test("receipt принимает только repo allowlist и пересчитанный локальный artifact hash", async (t) => {
  const fixture = await createEvidenceDirectory(t);
  const parsed = await parseCandidateEvidence(await readFile(fixture.evidencePath, "utf8"), {
    baseSha,
    candidatePatchSha256: patchSha,
    evidenceDirectory: fixture.evidenceDirectory,
  });
  assert.equal(parsed[0].artifact_sha256, sha256(fixture.artifactBytes));
  assert.equal(parsed[0].command, command);

  const rejects = async (receipt, pattern = /receipt-контракт/u) => {
    await assert.rejects(
      parseCandidateEvidence(`${JSON.stringify(receipt)}\n`, {
        baseSha,
        candidatePatchSha256: patchSha,
        evidenceDirectory: fixture.evidenceDirectory,
      }),
      pattern,
    );
  };
  await rejects({ ...fixture.receipt, criterion_id: "OPEN-02" });
  await rejects({ ...fixture.receipt, evaluation_scope: "CANDIDATE_EVALUATED" });
  await rejects({ ...fixture.receipt, schema: "zcode.prism.receipt.v2" });
  await rejects({ ...fixture.receipt, command: "pnpm test --filter opencode-go" });
  await rejects({ ...fixture.receipt, artifact_sha256: "a".repeat(64) }, /не совпадает/u);
  await rejects({ ...fixture.receipt, artifact_url: "https://example.invalid/artifact" });
  await rejects({ ...fixture.receipt, extra: "ignored fields are forbidden" });
  await rejects({ ...fixture.receipt, reported_status: "unknown" });

  await writeFile(path.join(fixture.evidenceDirectory, "helper-tests.log"), "tampered output\n");
  await rejects(fixture.receipt, /не совпадает/u);
});

test("receipt требует каждый allowlist criterion ровно один раз", async (t) => {
  const fixture = await createEvidenceDirectory(t);
  const text = JSON.stringify(fixture.receipt);
  await assert.rejects(
    parseCandidateEvidence(`${text}\n${text}\n`, {
      baseSha,
      candidatePatchSha256: patchSha,
      evidenceDirectory: fixture.evidenceDirectory,
    }),
    /ровно один раз/u,
  );
  await assert.rejects(
    parseCandidateEvidence("\n", {
      baseSha,
      candidatePatchSha256: patchSha,
      evidenceDirectory: fixture.evidenceDirectory,
    }),
    /ровно один раз/u,
  );
});

test("artifact traversal, symlink и превышение лимита отклоняются", async (t) => {
  const fixture = await createEvidenceDirectory(t);
  const outsidePath = path.join(path.dirname(fixture.evidenceDirectory), "outside-artifact.log");
  await writeFile(outsidePath, "outside\n");
  t.after(() => rm(outsidePath, { force: true }));

  const traversing = { ...fixture.receipt, artifact_path: "../outside-artifact.log" };
  await assert.rejects(
    parseCandidateEvidence(JSON.stringify(traversing), {
      baseSha,
      candidatePatchSha256: patchSha,
      evidenceDirectory: fixture.evidenceDirectory,
    }),
    /внутри каталога/u,
  );

  try {
    await symlink(outsidePath, path.join(fixture.evidenceDirectory, "outside-link.log"));
    const linked = { ...fixture.receipt, artifact_path: "outside-link.log" };
    await assert.rejects(
      parseCandidateEvidence(JSON.stringify(linked), {
        baseSha,
        candidatePatchSha256: patchSha,
        evidenceDirectory: fixture.evidenceDirectory,
      }),
      /внутри каталога|symlink/u,
    );
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.diagnostic("Symlink creation is unavailable on this host; path traversal remains covered.");
    } else {
      throw error;
    }
  }

  const oversizedPath = path.join(fixture.evidenceDirectory, "oversized.log");
  await writeFile(oversizedPath, Buffer.alloc(10 * 1024 * 1024 + 1));
  const oversized = { ...fixture.receipt, artifact_path: "oversized.log" };
  await assert.rejects(
    parseCandidateEvidence(JSON.stringify(oversized), {
      baseSha,
      candidatePatchSha256: patchSha,
      evidenceDirectory: fixture.evidenceDirectory,
    }),
    /10 MiB/u,
  );
});

test("plan creates only a Draft PR command for the approved base", () => {
  const plan = buildSelfImprovePlan({
    branch: "self-improve/2026-10-21-1-1-1-11111111",
    base: "dev",
    baseSha,
    candidateDiff: patch,
    evidenceRecords: [
      {
        schema: "zcode.prism.receipt.v3",
        criterion_id: criterionId,
        evaluation_scope: evaluationScope,
        reported_status: "pass",
        command,
        exit_code: 0,
        observed_at: "2026-10-21T00:00:00Z",
        base_sha: baseSha,
        candidate_patch_sha256: patchSha,
        artifact_path: "helper-tests.log",
        artifact_sha256: "a".repeat(64),
      },
    ],
  });
  assert.deepEqual(plan.commands[3].slice(0, 3), ["gh", "pr", "create"]);
  assert.ok(plan.commands[3].includes("--draft"));
  assert.ok(plan.body.includes("VALIDATED_LOCAL"));
  assert.ok(plan.body.includes("HEAD_INFRASTRUCTURE_ONLY"));
  assert.ok(plan.body.includes("staged candidate не исполнялся"));
  assert.ok(plan.body.includes("--apply заблокирован"));
  assert.ok(!plan.body.includes("helper-tests.log"));
  assert.ok(!plan.body.includes("https://"));
  assert.throws(
    () =>
      buildSelfImprovePlan({
        branch: "self-improve/no-diff",
        base: "dev",
        baseSha,
        candidateDiff: "",
        evidenceRecords: [],
      }),
    /Пустой candidate diff/u,
  );
  assert.throws(
    () =>
      buildSelfImprovePlan({
        branch: "self-improve/wrong-base",
        base: "main",
        baseSha,
        candidateDiff: patch,
        evidenceRecords: [],
      }),
    /только в dev/u,
  );
});

test("CLI default mode is read-only in a temporary Git repository", async (t) => {
  const fixture = await createGitFixture(t);
  const ghCalls = [];
  const runCalls = [];
  const result = await runSelfImproveCli(["--evidence", fixture.evidencePath], {
    rootDirectory: fixture.rootDirectory,
    runCommand: async (commandArgs, cwd) => {
      runCalls.push(commandArgs);
      return localGitRunner(fixture.rootDirectory, ghCalls)(commandArgs, cwd);
    },
    log: () => {},
  });
  assert.equal(result.applied, false);
  assert.deepEqual(runCalls, []);
  assert.deepEqual(ghCalls, []);
  assert.equal(git(fixture.rootDirectory, ["branch", "--show-current"]), "dev");
  assert.equal(git(fixture.rootDirectory, ["status", "--porcelain"]), "A  candidate.txt");
});

test("CLI blocks apply before any git or GitHub command without an external protected gate", async (t) => {
  const fixture = await createGitFixture(t);
  const commands = [];
  const captureCommands = [];
  await assert.rejects(
    runSelfImproveCli(["--apply", "--evidence", fixture.evidencePath], {
      rootDirectory: fixture.rootDirectory,
      captureCommand: async (commandArgs) => captureCommands.push(commandArgs),
      runCommand: async (commandArgs) => commands.push(commandArgs),
      log: () => {},
    }),
    /заранее существующий внешний protected secret gate/u,
  );
  assert.deepEqual(captureCommands, []);
  assert.deepEqual(commands, []);
  assert.equal(git(fixture.rootDirectory, ["branch", "--show-current"]), "dev");
  assert.equal(git(fixture.rootDirectory, ["status", "--porcelain"]), "A  candidate.txt");
  assert.equal(
    git(fixture.originDirectory, ["for-each-ref", "--format=%(refname)", "refs/heads/dev"]),
    "refs/heads/dev",
  );
});

test("apply remains blocked even when a caller injects a write runner", async (t) => {
  const fixture = await createGitFixture(t);
  const writeCommands = [];
  await assert.rejects(
    runSelfImproveCli(["--apply", "--evidence", fixture.evidencePath], {
      rootDirectory: fixture.rootDirectory,
      runCommand: async (commandArgs, cwd) => {
        writeCommands.push(commandArgs);
        assert.equal(cwd, fixture.rootDirectory);
      },
      log: () => {},
    }),
    /--apply запрещён/u,
  );
  assert.deepEqual(writeCommands, []);
});

test("CLI receipt rejection and branch collision happen before write commands", async (t) => {
  const fixture = await createGitFixture(t);
  const ghCalls = [];
  const runCalls = [];
  const invalidReceipt = { ...fixture.receipt, command: "sh -c arbitrary" };
  await writeFile(fixture.evidencePath, `${JSON.stringify(invalidReceipt)}\n`);
  await assert.rejects(
    runSelfImproveCli(["--evidence", fixture.evidencePath], {
      rootDirectory: fixture.rootDirectory,
      runCommand: async (commandArgs) => runCalls.push(commandArgs),
      log: () => {},
    }),
    /receipt-контракт/u,
  );
  assert.deepEqual(runCalls, []);
  assert.deepEqual(ghCalls, []);

  await writeFile(fixture.evidencePath, `${JSON.stringify(fixture.receipt)}\n`);
  await assert.rejects(
    runSelfImproveCli(["--evidence", fixture.evidencePath], {
      rootDirectory: fixture.rootDirectory,
      branchExists: () => true,
      runCommand: async (commandArgs) => runCalls.push(commandArgs),
      log: () => {},
    }),
    /ветка уже существует/u,
  );
  assert.deepEqual(runCalls, []);
});

test("CLI rejects an untracked workspace file before write commands", async (t) => {
  const fixture = await createGitFixture(t);
  await writeFile(path.join(fixture.rootDirectory, "untracked.txt"), "outside staged diff\n");
  const runCalls = [];
  await assert.rejects(
    runSelfImproveCli(["--evidence", fixture.evidencePath], {
      rootDirectory: fixture.rootDirectory,
      runCommand: async (commandArgs) => runCalls.push(commandArgs),
      log: () => {},
    }),
    /unstaged\/untracked/u,
  );
  assert.deepEqual(runCalls, []);
});

test("candidate secret paths are rejected before applying", async (t) => {
  assert.throws(() => validateCandidatePaths([".env.local"]), /секретный файл/u);
  assert.throws(() => validateCandidatePaths(["config/keys/client.p12"]), /секретный файл/u);
  assert.doesNotThrow(() => validateCandidatePaths(["docs/specs/prism10.md"]));

  const fixture = await createGitFixture(t, { secretCandidate: true });
  const evidence = await createEvidenceDirectory(t);
  const expectedPatch = git(fixture.rootDirectory, ["diff", "--cached", "--binary", "HEAD"], {
    trim: false,
  });
  const receipt = {
    ...evidence.receipt,
    base_sha: git(fixture.rootDirectory, ["rev-parse", "HEAD"]),
    candidate_patch_sha256: sha256(expectedPatch),
  };
  await writeFile(evidence.evidencePath, `${JSON.stringify(receipt)}\n`);
  const runCalls = [];
  await assert.rejects(
    runSelfImproveCli(["--evidence", evidence.evidencePath], {
      rootDirectory: fixture.rootDirectory,
      runCommand: async (commandArgs) => runCalls.push(commandArgs),
      log: () => {},
    }),
    /секретный файл/u,
  );
  assert.deepEqual(runCalls, []);
});

test("candidate secret paths remain rejected after a staged rename", async (t) => {
  const fixture = await createGitFixture(t, { secretRenameCandidate: true });
  const evidence = await createEvidenceDirectory(t);
  const expectedPatch = git(fixture.rootDirectory, ["diff", "--cached", "--binary", "HEAD"], {
    trim: false,
  });
  const receipt = {
    ...evidence.receipt,
    base_sha: git(fixture.rootDirectory, ["rev-parse", "HEAD"]),
    candidate_patch_sha256: sha256(expectedPatch),
  };
  await writeFile(evidence.evidencePath, `${JSON.stringify(receipt)}\n`);
  const runCalls = [];
  await assert.rejects(
    runSelfImproveCli(["--evidence", evidence.evidencePath], {
      rootDirectory: fixture.rootDirectory,
      runCommand: async (commandArgs) => runCalls.push(commandArgs),
      log: () => {},
    }),
    /rename\/copy|секретный файл/u,
  );
  assert.deepEqual(runCalls, []);
});
