import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSelfImprovePlan,
  parseCandidateEvidence,
  sha256,
  validateCandidatePaths,
} from "../self-improve-pr.mjs";

const baseSha = "1".repeat(40);
const patch = "diff --git a/a.ts b/a.ts\n+change\n";
const patchSha = sha256(patch);
const receipt = {
  schema: "zcode.prism.receipt.v1",
  criterion_id: "OPEN-02",
  status: "pass",
  command: "pnpm test --filter opencode-go",
  exit_code: 0,
  observed_at: "2026-10-21T00:00:00Z",
  base_sha: baseSha,
  candidate_patch_sha256: patchSha,
  artifact_url: "https://github.com/owner/repo/actions/runs/1/artifacts/2",
  artifact_sha256: "a".repeat(64),
};

test("receipts привязываются к base и точному staged patch", () => {
  assert.deepEqual(
    parseCandidateEvidence(JSON.stringify(receipt), {
      baseSha,
      candidatePatchSha256: patchSha,
    }),
    [receipt],
  );
  assert.throws(
    () =>
      parseCandidateEvidence(
        JSON.stringify({ ...receipt, candidate_patch_sha256: "0".repeat(64) }),
        {
          baseSha,
          candidatePatchSha256: patchSha,
        },
      ),
    /receipt-контракт/,
  );
  assert.throws(
    () =>
      parseCandidateEvidence(
        JSON.stringify({ ...receipt, artifact_url: "https://user:token@host" }),
        {
          baseSha,
          candidatePatchSha256: patchSha,
        },
      ),
    /receipt-контракт/,
  );
});

test("план содержит diff/evidence summary и запрещает пустые и нецелевые кандидаты", () => {
  const plan = buildSelfImprovePlan({
    branch: "self-improve/2026-10-21-1-1-1-11111111",
    base: "dev",
    baseSha,
    candidateDiff: patch,
    evidenceRecords: [receipt],
  });
  assert.equal(plan.commands[0][0], "git");
  assert.equal(plan.commands[2][3], "origin");
  assert.equal(plan.commands[3][4], "dev");
  assert.match(plan.body, /независимое ревью/u);
  assert.throws(
    () =>
      buildSelfImprovePlan({
        branch: "self-improve/no-diff",
        base: "dev",
        baseSha,
        candidateDiff: "",
        evidenceRecords: [receipt],
      }),
    /Пустой candidate diff/,
  );
  assert.throws(
    () =>
      buildSelfImprovePlan({
        branch: "self-improve/wrong-base",
        base: "main",
        baseSha,
        candidateDiff: patch,
        evidenceRecords: [receipt],
      }),
    /только в dev/,
  );
});

test("потенциальные секреты не входят в candidate PR", () => {
  assert.throws(() => validateCandidatePaths([".env.local"]), /секретный файл/);
  assert.throws(() => validateCandidatePaths(["config/keys/client.p12"]), /секретный файл/);
  assert.doesNotThrow(() => validateCandidatePaths(["docs/specs/prism10.md"]));
});
