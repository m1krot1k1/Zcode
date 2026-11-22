import assert from "node:assert/strict";
import test from "node:test";

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  approveCandidate,
  generateApprovedSkills,
  mineSkillCandidates,
  renderMinedSkill,
} from "../skills-mining.mjs";

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

test("renders and generates only approved candidates", async () => {
  const candidate = mineSkillCandidates([...rows("baseline", 1000), ...rows("candidate", 800)])[0];
  assert.ok(candidate);
  const rendered = renderMinedSkill(candidate);
  assert.ok(rendered.includes("name: mined-task-a"));
  assert.ok(rendered.includes("## Evidence"));
  assert.ok(rendered.includes("Token delta: -20%"));

  const root = await mkdtemp(path.join(tmpdir(), "skills-mining-"));
  try {
    const approved = approveCandidate([candidate], "task-a");
    const generated = await generateApprovedSkills([approved], root);
    assert.deepEqual(generated, [".agents/skills/mined-task-a/SKILL.md"]);
    assert.ok((await readFile(path.join(root, generated[0]), "utf8")).includes("# task-a"));
    assert.deepEqual(await generateApprovedSkills([approved], root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
