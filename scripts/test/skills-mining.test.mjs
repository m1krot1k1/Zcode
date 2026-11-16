import assert from "node:assert/strict";
import test from "node:test";

import { mineSkillCandidates } from "../skills-mining.mjs";

function rows(arm, tokens, success = true) {
  return [1, 2, 3].map((run) => ({
    taskId: "task-a",
    arm,
    run,
    success,
    tokens,
    durationMs: tokens * 2,
  }));
}

test("mines only successful tasks with a measured improvement", () => {
  const result = mineSkillCandidates([...rows("baseline", 1000), ...rows("candidate", 800)]);
  assert.equal(result.length, 1);
  assert.equal(result[0].taskId, "task-a");
  assert.equal(result[0].tokenDeltaPct, -20);
  assert.equal(result[0].approval, "required");
});

test("does not mine regressions, failures, or insufficient repeats", () => {
  assert.equal(
    mineSkillCandidates([...rows("baseline", 1000), ...rows("candidate", 1200)]).length,
    0,
  );
  assert.equal(
    mineSkillCandidates([...rows("baseline", 1000), ...rows("candidate", 800, false)]).length,
    0,
  );
  assert.equal(
    mineSkillCandidates([rows("baseline", 1000)[0], rows("candidate", 800)[0]]).length,
    0,
  );
});
