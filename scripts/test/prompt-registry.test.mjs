import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { checkRegistry, parseRegistry } from "../prompt-registry.mjs";

async function withRegistry(files, registry, run) {
  const root = await mkdtemp(path.join(tmpdir(), "prompt-registry-"));
  try {
    for (const [file, content] of Object.entries(files)) {
      await writeFile(path.join(root, file), content, "utf8");
    }
    return await run(await checkRegistry({ version: 1, entries: registry }, root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("accepts entries within budget with required markers", async () => {
  const result = await withRegistry(
    {
      "a.md": "# A\nrequired marker\n",
      "b.md": "# B\nanother marker\n",
    },
    [
      { id: "a", path: "a.md", maxChars: 100, required: ["required marker"] },
      { id: "b", path: "b.md", maxChars: 100, required: ["another marker"] },
    ],
    (checked) => checked,
  );

  assert.deepEqual(result.failures, []);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].overBudget, false);
  assert.equal(result.entries[0].estimatedTokens, 5);
});

test("fails over budget and missing required markers", async () => {
  const result = await withRegistry(
    { "a.md": "x".repeat(101) },
    [{ id: "a", path: "a.md", maxChars: 100, required: ["missing"] }],
    (checked) => checked,
  );

  assert.equal(result.failures.length, 2);
  assert.match(result.failures[0], /101 chars > budget 100/);
  assert.match(result.failures[1], /missing required marker "missing"/);
});

test("reports duplicate long rules across layers as warnings", async () => {
  const rule =
    "This is a long duplicated instruction that must not live in two prompt layers at once.";
  const result = await withRegistry(
    { "a.md": rule, "b.md": rule },
    [
      { id: "a", path: "a.md", maxChars: 200 },
      { id: "b", path: "b.md", maxChars: 200 },
    ],
    (checked) => checked,
  );

  assert.equal(result.failures.length, 0);
  assert.equal(result.duplicateLines.length, 1);
  assert.deepEqual(result.duplicateLines[0].owners, ["a", "b"]);
  assert.match(result.warnings[0], /duplicate rule/);
});

test("rejects duplicate ids and invalid budgets", () => {
  assert.throws(
    () =>
      parseRegistry({
        version: 1,
        entries: [
          { id: "a", path: "a.md", maxChars: 10 },
          { id: "a", path: "b.md", maxChars: 10 },
        ],
      }),
    /duplicate registry id/,
  );
  assert.throws(
    () => parseRegistry({ version: 1, entries: [{ id: "a", path: "a.md", maxChars: 0 }] }),
    /maxChars/,
  );
});
