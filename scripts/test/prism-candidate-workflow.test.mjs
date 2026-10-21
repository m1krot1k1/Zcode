import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../../.github/workflows/prism-candidate.yml", import.meta.url),
  "utf8",
);

test("PRISM candidate workflow runs trusted dev pushes without executing PR-controlled workflow policy", () => {
  assert.doesNotMatch(workflow, /^\s*pull_request(?:_target)?:\s*$/mu);
  assert.match(workflow, /push:\s*\n\s+branches: \[dev\]/u);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/u);
  assert.doesNotMatch(workflow, /secrets\./u);
});

test("push context resolves exact commit and comparison base SHAs", () => {
  assert.match(
    workflow,
    /PR_HEAD_SHA: \$\{\{ github\.sha \}\}/u,
  );
  assert.match(
    workflow,
    /PR_BASE_SHA: \$\{\{ github\.event\.before \}\}/u,
  );
  assert.match(
    workflow,
    /ref: \$\{\{ github\.sha \}\}/u,
  );
});

test("CI concurrency and evidence artifact identify the pushed commit", () => {
  assert.match(
    workflow,
    /group: prism-candidate-\$\{\{ github\.ref \}\}/u,
  );
  assert.match(
    workflow,
    /name: prism-candidate-push-\$\{\{ github\.sha \}\}/u,
  );
});

test("job-level evidence directory uses an allowed GitHub Actions context", () => {
  assert.match(
    workflow,
    /EVIDENCE_DIR: \$\{\{ github\.workspace \}\}\/prism-candidate-evidence/u,
  );
  assert.doesNotMatch(workflow, /EVIDENCE_DIR: \$\{\{ runner\.temp \}\}/u);
});
