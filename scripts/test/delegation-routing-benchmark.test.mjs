import assert from "node:assert/strict";
import test from "node:test";
import {
  compareBenchmarkRecords,
  evaluateBenchmark,
  parseBenchmarkRecords,
  summarizeArm,
} from "../delegation-routing-benchmark.mjs";

function record(taskId, arm, patch = {}) {
  return {
    taskId,
    arm,
    success: true,
    durationMs: 1000,
    tokens: 1000,
    duplicateClaims: 0,
    criticalRegressions: 0,
    ...patch,
  };
}

test("parses JSONL and pairs baseline with candidate", () => {
  const records = parseBenchmarkRecords(
    [
      JSON.stringify(record("task-a", "baseline")),
      JSON.stringify(record("task-a", "candidate", { durationMs: 800, tokens: 700 })),
      "",
      JSON.stringify(record("task-b", "baseline")),
      JSON.stringify(record("task-b", "candidate", { durationMs: 900, tokens: 800 })),
    ].join("\n"),
  );

  const pairs = compareBenchmarkRecords(records);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].baseline.arm, "baseline");
  assert.equal(pairs[0].candidate.arm, "candidate");
});

test("summarizes arms with medians and totals", () => {
  const pairs = compareBenchmarkRecords([
    record("a", "baseline", { durationMs: 100, tokens: 10 }),
    record("a", "candidate", { durationMs: 80, tokens: 8 }),
    record("b", "baseline", { durationMs: 300, tokens: 30 }),
    record("b", "candidate", { durationMs: 120, tokens: 12 }),
  ]);

  assert.deepEqual(summarizeArm(pairs, "baseline"), {
    tasks: 2,
    successRate: 1,
    medianDurationMs: 200,
    totalTokens: 40,
    duplicateClaims: 0,
    criticalRegressions: 0,
  });
  assert.equal(summarizeArm(pairs, "candidate").medianDurationMs, 100);
});

test("accepts a faster candidate without success loss", () => {
  const pairs = compareBenchmarkRecords([
    record("a", "baseline", { durationMs: 1000, tokens: 1000 }),
    record("a", "candidate", { durationMs: 600, tokens: 700 }),
  ]);

  assert.deepEqual(evaluateBenchmark(pairs).verdict, "candidate");
});

test("rejects a candidate with critical regressions", () => {
  const pairs = compareBenchmarkRecords([
    record("a", "baseline"),
    record("a", "candidate", { durationMs: 500, criticalRegressions: 1 }),
  ]);

  assert.equal(evaluateBenchmark(pairs).verdict, "reject");
});

test("rejects a candidate that lowers success", () => {
  const pairs = compareBenchmarkRecords([
    record("a", "baseline"),
    record("a", "candidate", { success: false }),
  ]);

  assert.equal(evaluateBenchmark(pairs).verdict, "reject");
});

test("requires both arms for every task", () => {
  assert.throws(
    () => compareBenchmarkRecords([record("a", "baseline")]),
    /both baseline and candidate/,
  );
});

test("rejects duplicate arm records", () => {
  assert.throws(
    () =>
      compareBenchmarkRecords([
        record("a", "baseline"),
        record("a", "baseline"),
        record("a", "candidate"),
      ]),
    /duplicate baseline/,
  );
});

test("rejects malformed records", () => {
  assert.throws(() => parseBenchmarkRecords("{"), /invalid JSON/);
  assert.throws(
    () => parseBenchmarkRecords(JSON.stringify({ ...record("a", "baseline"), durationMs: -1 })),
    /durationMs/,
  );
});
