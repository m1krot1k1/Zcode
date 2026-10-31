import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import YAML from "yaml";

const workflowsDirectory = new URL("../../.github/workflows/", import.meta.url);

test("hosted runners are used only for explicitly tagged cross-platform releases", async () => {
  const entries = await readdir(workflowsDirectory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const workflowFiles = entries.filter((entry) => /\.ya?ml$/iu.test(entry));
  assert.deepEqual(workflowFiles, ["cross-platform-preview-release.yml"]);
  const workflow = YAML.parse(
    await readFile(new URL("../../.github/workflows/cross-platform-preview-release.yml", import.meta.url), "utf8"),
  );
  assert.deepEqual(workflow.on.push, { tags: ["v[0-9]+.[0-9]+.[0-9]+"] });
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.release_tag, {
    description: "Existing version tag to build and attach platform assets to",
    required: true,
    type: "string",
  });
  assert.deepEqual(Object.keys(workflow.on).sort(), ["push", "workflow_dispatch"]);
  assert.equal(workflow.jobs.publish.permissions.contents, "write");
});
