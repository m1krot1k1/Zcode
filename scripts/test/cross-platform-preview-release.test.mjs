import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import YAML from "yaml";

const workflowPath = new URL("../../.github/workflows/cross-platform-preview-release.yml", import.meta.url);

test("tagged Preview workflow builds and publishes Desktop and CLI for all requested targets", async () => {
  const workflow = YAML.parse(await readFile(workflowPath, "utf8"));
  assert.deepEqual(workflow.on.push.tags, ["v[0-9]+.[0-9]+.[0-9]+"]);
  assert.equal(workflow.on.push.branches, undefined);
  assert.deepEqual(workflow.permissions, { contents: "read" });

  const desktop = workflow.jobs.desktop.strategy.matrix.include;
  assert.deepEqual(
    desktop.map(({ os, arch }) => `${os}-${arch}`),
    ["mac-arm64", "win-x64", "linux-x64"],
  );
  const cli = workflow.jobs.cli.strategy.matrix.include;
  assert.deepEqual(
    cli.map(({ target }) => target),
    ["darwin-arm64", "win-x64", "linux-x64"],
  );

  const publish = workflow.jobs.publish;
  assert.deepEqual(publish.needs, ["desktop", "cli"]);
  assert.equal(publish.permissions.contents, "write");
  assert.match(publish.steps.find(({ name }) => name === "Validate complete release asset set").run, /-ge 10/);
  assert.match(publish.steps.find(({ name }) => name === "Create prerelease").run, /--prerelease/);
});
