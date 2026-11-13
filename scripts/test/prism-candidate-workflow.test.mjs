import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import YAML from "yaml";

const workflowsDirectory = new URL("../../.github/workflows/", import.meta.url);

test("hosted runners are manual-only while Actions billing is unavailable", async () => {
  const entries = await readdir(workflowsDirectory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const workflowFiles = entries.filter((entry) => /\.ya?ml$/iu.test(entry)).sort();
  // Политика: ни один workflow не должен запускаться на hosted runners автоматически
  // (push/pull_request/тег) — иначе при недоступном Actions billing копятся упавшие раны.
  for (const file of workflowFiles) {
    const parsed = YAML.parse(await readFile(new URL(file, workflowsDirectory), "utf8"));
    assert.deepEqual(
      Object.keys(parsed.on ?? {}).sort(),
      ["workflow_dispatch"],
      `${file} должен запускаться только вручную`,
    );
  }
  assert.ok(workflowFiles.includes("cross-platform-preview-release.yml"));
  const workflow = YAML.parse(
    await readFile(
      new URL("../../.github/workflows/cross-platform-preview-release.yml", import.meta.url),
      "utf8",
    ),
  );
  // Local macOS Preview releases create tags. A tag-triggered workflow would spawn failing
  // hosted runs while billing is unavailable, so cross-platform builds are manual-only.
  assert.equal(workflow.on.push, undefined);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.release_tag, {
    description: "Existing version tag to build and attach platform assets to",
    required: true,
    type: "string",
  });
  assert.deepEqual(Object.keys(workflow.on).sort(), ["workflow_dispatch"]);
  assert.equal(workflow.jobs.publish.permissions.contents, "write");
});
