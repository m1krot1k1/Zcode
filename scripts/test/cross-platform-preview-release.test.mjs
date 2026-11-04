import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import YAML from "yaml";

const workflowPath = new URL(
  "../../.github/workflows/cross-platform-preview-release.yml",
  import.meta.url,
);

test("tagged Preview workflow builds and publishes Desktop and CLI for all requested targets", async () => {
  const workflow = YAML.parse(await readFile(workflowPath, "utf8"));
  assert.deepEqual(workflow.on.push.tags, ["v[0-9]+.[0-9]+.[0-9]+"]);
  assert.equal(workflow.on.push.branches, undefined);
  assert.equal(workflow.on.workflow_dispatch.inputs.release_tag.required, true);
  assert.equal(workflow.on.workflow_dispatch.inputs.release_tag.type, "string");
  assert.match(workflow.env.RELEASE_TAG, /github\.event\.inputs\.release_tag/);
  assert.deepEqual(workflow.permissions, { contents: "read" });

  const desktop = workflow.jobs.desktop.strategy.matrix.include;
  assert.deepEqual(
    desktop.map(({ os, arch }) => `${os}-${arch}`),
    ["mac-arm64", "win-x64", "linux-x64"],
  );
  assert.match(
    workflow.jobs.desktop.steps.find(({ name }) => name === "Checkout tagged source").with.ref,
    /github\.event\.inputs\.release_tag/,
  );
  const cli = workflow.jobs.cli.strategy.matrix.include;
  assert.deepEqual(
    cli.map(({ target }) => target),
    ["darwin-arm64", "win-x64", "linux-x64"],
  );
  assert.match(
    workflow.jobs.cli.steps.find(({ name }) => name === "Checkout tagged source").with.ref,
    /github\.event\.inputs\.release_tag/,
  );

  const publish = workflow.jobs.publish;
  assert.deepEqual(publish.needs, ["desktop", "cli"]);
  assert.equal(publish.permissions.contents, "write");
  assert.match(
    publish.steps.find(({ name }) => name === "Validate complete release asset set").run,
    /-ge 10/,
  );
  assert.match(
    publish.steps.find(({ name }) => name === "Verify release tag matches package version").run,
    /process\.env\.RELEASE_TAG/,
  );
  const publishScript = publish.steps.find(
    ({ name }) => name === "Create or update Preview prerelease",
  ).run;
  assert.match(publishScript, /gh release view/);
  assert.match(publishScript, /gh release upload[\s\S]*--clobber/);
  assert.match(publishScript, /gh release edit[\s\S]*--prerelease[\s\S]*--verify-tag/);
  assert.match(publishScript, /release-assets\/\*/);
  assert.doesNotMatch(publishScript, /release-assets\/\*\/\*/);
  assert.match(publishScript, /Refusing to modify a stable release/);
  assert.match(publishScript, /Existing prerelease points to another commit/);
  assert.match(publishScript, /gh release create[\s\S]*--target/);
});
