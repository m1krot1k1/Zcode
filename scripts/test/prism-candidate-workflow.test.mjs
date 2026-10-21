import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../../.github/workflows/prism-candidate.yml", import.meta.url),
  "utf8",
);

test("PRISM candidate workflow verifies pull requests and direct dev pushes", () => {
  assert.match(workflow, /pull_request_target:\s*\n\s+branches: \[dev\]/u);
  assert.match(workflow, /push:\s*\n\s+branches: \[dev\]/u);
});

test("PR and push contexts resolve exact head and comparison base SHAs", () => {
  assert.match(
    workflow,
    /PR_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/u,
  );
  assert.match(
    workflow,
    /PR_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.event\.before \}\}/u,
  );
  assert.match(
    workflow,
    /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/u,
  );
  assert.match(
    workflow,
    /repository: \$\{\{ github\.event\.pull_request\.head\.repo\.full_name \|\| github\.repository \}\}/u,
  );
});

test("CI concurrency and evidence artifact have values for push events", () => {
  assert.match(
    workflow,
    /group: prism-candidate-\$\{\{ github\.event\.pull_request\.number \|\| github\.sha \}\}/u,
  );
  assert.match(
    workflow,
    /name: prism-candidate-\$\{\{ github\.event\.pull_request\.number \|\| 'push' \}\}-\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/u,
  );
});

test("job-level evidence directory uses an allowed GitHub Actions context", () => {
  assert.match(
    workflow,
    /EVIDENCE_DIR: \$\{\{ github\.workspace \}\}\/prism-candidate-evidence/u,
  );
  assert.doesNotMatch(workflow, /EVIDENCE_DIR: \$\{\{ runner\.temp \}\}/u);
});
