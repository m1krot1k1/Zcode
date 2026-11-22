import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const FAMILIES = [
  "single-file-bugfix",
  "multi-file-refactor",
  "independent-research-implementation",
  "serial-migration",
  "release-pipeline",
  "duplicate-work-probe",
];
const plan = JSON.parse(
  await readFile(
    path.resolve(import.meta.dirname, "../delegation-routing-benchmark-plan.json"),
    "utf8",
  ),
);

test("benchmark plan allocates a real budget and a protected holdout", () => {
  assert.equal(plan.version, 1);
  assert.equal(plan.status, "planned");
  assert.deepEqual(plan.families, FAMILIES);
  assert.equal(plan.budget.arms, 2);
  assert.ok(plan.budget.repeatsPerArm >= 3);
  assert.equal(plan.budget.tasks, FAMILIES.length * 2);
  assert.ok(
    plan.budget.maxTotalRuns >= plan.budget.tasks * plan.budget.repeatsPerArm * plan.budget.arms,
  );
  assert.ok(plan.budget.maxTokensPerRun > 0);
  assert.ok(plan.budget.maxWallClockMinutes > 0);
});

test("every task family has exactly one protected-holdout task", () => {
  assert.equal(plan.holdout.length, FAMILIES.length);
  const holdoutFamilies = plan.holdout.map((task) => task.family).sort();
  assert.deepEqual(holdoutFamilies, [...FAMILIES].sort());
  for (const task of plan.holdout) {
    assert.ok(task.taskId.startsWith("holdout-"));
    assert.ok(task.acceptance.length > 0);
    assert.ok(["delegate_single", "orchestrate", "integrate_inline"].includes(task.expectedRoute));
  }
});

test("plan is an allocation, not benchmark evidence", () => {
  assert.match(plan.note, /not benchmark evidence/);
});
