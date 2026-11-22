import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  assessPrismPairs,
  oneSidedSignPvalue,
  PrismGateInputError,
} from "../prism10-experiment-gate.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function pairs({ cases = 12, trials = 2, synthetic = false } = {}) {
  return Array.from({ length: cases }, (_, caseIndex) =>
    Array.from({ length: trials }, (_, trial) => ({
      case_id: `case-${caseIndex}`,
      trial,
      split: "protected_holdout",
      environment_id: "test-env-sha256:123",
      grader_id: "test-grader-v1",
      synthetic,
      critical: false,
      baseline: {
        success: 0,
        confirmed_discoveries: 0,
        cost_usd: 1,
        latency_s: 1,
        safety_violations: 0,
        receipt: `baseline-${caseIndex}-${trial}`,
      },
      candidate: {
        success: 1,
        confirmed_discoveries: 1,
        cost_usd: 1.1,
        latency_s: 1.1,
        safety_violations: 0,
        receipt: `candidate-${caseIndex}-${trial}`,
      },
    })),
  ).flat();
}

test("uses the exact one-sided sign test and excludes ties", () => {
  assert.equal(oneSidedSignPvalue(4, 0), 1 / 16);
  assert.equal(oneSidedSignPvalue(0, 0), 1);
});

test("recommends only a sufficiently sized, non-synthetic paired improvement", () => {
  const report = assessPrismPairs(pairs({ cases: 20 }), { minCases: 20, minTrials: 2 });
  assert.equal(report.status, "PROMOTE_CANDIDATE");
  assert.equal(report.unique_cases, 20);
  assert.equal(report.case_level_wins, 20);
  assert.match(report.warning, /does not run models, authenticate receipts/u);
});

test("synthetic/example records cannot receive a promotion recommendation", () => {
  const report = assessPrismPairs(pairs({ cases: 20, synthetic: true }), {
    minCases: 20,
  });
  assert.equal(report.status, "INSUFFICIENT_EVIDENCE");
});

test("requires the PRISM default of 20 distinct cases and two trials each", () => {
  assert.equal(assessPrismPairs(pairs({ cases: 12 })).status, "INSUFFICIENT_EVIDENCE");
  assert.equal(assessPrismPairs(pairs({ cases: 20, trials: 1 })).status, "INSUFFICIENT_EVIDENCE");
});

test("supports discovery as a separate objective", () => {
  const rows = pairs({ cases: 20 });
  for (const row of rows) {
    row.baseline.success = 1;
    row.candidate.success = 1;
  }
  assert.equal(assessPrismPairs(rows, { objective: "discovery" }).status, "PROMOTE_CANDIDATE");
});

test("rejects candidate safety violations and critical regressions", () => {
  const unsafe = pairs({ cases: 20 });
  unsafe[0].candidate.safety_violations = 1;
  assert.equal(assessPrismPairs(unsafe).status, "REJECT");

  const regression = pairs({ cases: 20 });
  regression[0].critical = true;
  regression[0].baseline.success = 1;
  regression[0].candidate.success = 0;
  assert.equal(assessPrismPairs(regression).status, "REJECT");
});

test("rejects cost and latency guardrail regressions", () => {
  const expensive = pairs({ cases: 20 });
  for (const row of expensive) row.candidate.cost_usd = 2;
  assert.equal(assessPrismPairs(expensive).status, "REJECT");

  const slow = pairs({ cases: 20 });
  for (const row of slow) row.candidate.latency_s = 2;
  assert.equal(assessPrismPairs(slow).status, "REJECT");

  const zeroBaseline = pairs({ cases: 20 });
  for (const row of zeroBaseline) {
    row.baseline.cost_usd = 0;
    row.candidate.cost_usd = 1;
  }
  const report = assessPrismPairs(zeroBaseline);
  assert.equal(report.status, "REJECT");
  assert.equal(report.mean_cost_ratio, null);
});

test("rejects mismatched conditions, duplicate trials, invalid scores and missing receipts", () => {
  const mismatched = pairs({ cases: 20 });
  mismatched[0].grader_id = "other-grader";
  assert.throws(() => assessPrismPairs(mismatched), PrismGateInputError);

  const duplicate = pairs({ cases: 20 });
  duplicate.push(duplicate[0]);
  assert.throws(() => assessPrismPairs(duplicate), /duplicate case\/trial/u);

  const invalidScore = pairs({ cases: 20 });
  invalidScore[0].candidate.success = 0.7;
  assert.throws(() => assessPrismPairs(invalidScore), /success must be 0\/1/u);

  const noReceipt = pairs({ cases: 20 });
  noReceipt[0].baseline.receipt = " ";
  assert.throws(() => assessPrismPairs(noReceipt), /missing baseline receipt/u);
});

test("rejects empty data and inconsistent holdout splits", () => {
  assert.throws(() => assessPrismPairs([]), /empty input/u);
  const wrongSplit = pairs({ cases: 20 });
  wrongSplit[0].split = "development";
  assert.throws(() => assessPrismPairs(wrongSplit), /protected_holdout/u);
});

test("CLI reads recorded synthetic fixture without executing input and exits 2", () => {
  const fixturePath = path.join(
    repositoryRoot,
    "docs/vendor/prism10/fixtures/example_SYNTHETIC_no_valid_promotion.jsonl",
  );
  const result = spawnSync(
    process.execPath,
    ["scripts/prism10-experiment-gate.mjs", "--input", fixturePath],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).status, "INSUFFICIENT_EVIDENCE");
  assert.match(result.stdout, /does not run models, authenticate receipts/u);
});

test("CLI classifies malformed JSONL as invalid input", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "zcode-prism-gate-test-"));
  try {
    const inputPath = path.join(tempDirectory, "invalid.jsonl");
    await writeFile(inputPath, "{not-json}\n", "utf8");
    const result = spawnSync(
      process.execPath,
      ["scripts/prism10-experiment-gate.mjs", "--input", inputPath],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    assert.equal(result.status, 3);
    assert.match(JSON.parse(result.stdout).error, /invalid JSON at line 1/u);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
