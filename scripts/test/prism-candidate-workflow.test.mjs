import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";

const workflowsDirectory = new URL("../../.github/workflows/", import.meta.url);

test("repository has no GitHub Actions workflows that consume hosted runner minutes", async () => {
  const entries = await readdir(workflowsDirectory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  assert.deepEqual(
    entries.filter((entry) => /\.ya?ml$/iu.test(entry)),
    [],
    "run CI locally; do not spend GitHub Actions runner minutes",
  );
});
