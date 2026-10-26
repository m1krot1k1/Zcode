import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPreviewReleaseBaseSha,
  assertPreviewReleasePreconditions,
  assertPreviewReleaseTagAvailable,
  assertPreviewResumeCandidate,
  assertPreviewResumeTagTarget,
  buildPreviewReleaseCreateArgs,
  createPreviewBuildEnvironment,
  createPreviewReleasePlan,
  isMissingGitHubRelease,
  replaceRootPackageLockVersion,
  runPreviewReleaseLocalGates,
  OFFLINE_PREVIEW_ZCODE_ENDPOINT,
} from "../release-macos-preview.mjs";

const commitSha = "a".repeat(40);
const assetPaths = [
  "/tmp/ZCode Preview-3.17.1-mac-arm64_TEST.dmg",
  "/tmp/ZCode Preview-3.17.1-mac-arm64_TEST.zip",
];

test("offline Preview needs no ZCode backend and pins every endpoint alias to loopback", () => {
  const env = createPreviewBuildEnvironment({
    ZCODE_BASE_URL: "https://zcode.z.ai/api/v1",
    ZCODE_ENDPOINT_ORIGIN: "https://production.example.invalid",
    ZCODE_TEST_BASE_URL: "https://other-test.example.invalid",
    ZCODE_PRODUCTION_BASE_URL: "https://zcode.z.ai",
    VITE_ZCODE_BASE_URL: "https://production.example.invalid",
    VITE_ZCODE_ENDPOINT_ORIGIN: "https://production.example.invalid",
    ZCODE_ARMS_RUM_ENDPOINT: "https://rum.example.invalid/collect",
    ZCODE_TELEMETRY_REPORT_ENDPOINT: "https://telemetry.example.invalid/report",
    ZCODE_AUTO_UPDATE: "1",
    ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT: "https://otel.example.invalid/v1/logs",
    ZCODE_PACKAGED_AGENT_OTEL_HEADERS: "Authorization=secret",
    APPLE_ID: "must-not-be-forwarded",
    CSC_LINK: "must-not-be-forwarded",
    GH_TOKEN: "must-not-be-forwarded",
  });
  assert.equal(env.ZCODE_ENV, "test");
  assert.equal(env.ZCODE_OFFLINE_PREVIEW, "1");
  assert.equal(env.ZCODE_ARMS_RUM_ENDPOINT, "");
  assert.equal(env.ZCODE_TELEMETRY_REPORT_ENDPOINT, "");
  assert.equal(env.ZCODE_AUTO_UPDATE, "0");
  assert.equal("ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT" in env, false);
  assert.equal("ZCODE_PACKAGED_AGENT_OTEL_HEADERS" in env, false);
  for (const name of [
    "ZCODE_BASE_URL",
    "ZCODE_ENDPOINT_ORIGIN",
    "ZCODE_TEST_BASE_URL",
    "ZCODE_PRODUCTION_BASE_URL",
    "VITE_ZCODE_BASE_URL",
    "VITE_ZCODE_ENDPOINT_ORIGIN",
  ]) {
    assert.equal(env[name], OFFLINE_PREVIEW_ZCODE_ENDPOINT);
  }
  for (const name of ["APPLE_ID", "CSC_LINK", "GH_TOKEN"]) assert.equal(name in env, false);
});

test("Preview release is an unsigned-labeled prerelease pinned to the exact pushed commit", async () => {
  const plan = await createPreviewReleasePlan({
    version: "3.17.1",
    targetArch: "arm64",
    assetPaths,
    commitSha,
  });
  assert.equal(plan.tag, "v3.17.1");
  assert.deepEqual(plan.expectedAssetNames, [
    "ZCode Preview-3.17.1-mac-arm64_TEST.dmg",
    "ZCode Preview-3.17.1-mac-arm64_TEST.zip",
  ]);
  assert.equal(plan.args[0], "gh");
  assert.equal(plan.args[1], "release");
  assert.equal(plan.args[2], "create");
  assert.equal(plan.args[3], "v3.17.1");
  assert.equal(plan.args[plan.args.indexOf("--target") + 1], commitSha);
  assert.ok(plan.args.includes("--prerelease"));
  assert.ok(
    plan.args.some(
      (arg) =>
        (arg.includes("аккаунт и backend ZCode недоступны") && arg.includes("loopback")) ||
        (arg.includes("без Apple-подписи") && arg.includes("_TEST")),
    ),
  );
});

test("Preview release refuses malformed commit, architecture, and mixed/stable assets", async () => {
  assert.throws(
    () =>
      buildPreviewReleaseCreateArgs({
        tag: "v3.17.1",
        commitSha: "not-a-sha",
        targetArch: "arm64",
        assetPaths,
      }),
    /SHA/u,
  );
  assert.throws(
    () =>
      buildPreviewReleaseCreateArgs({
        tag: "v3.17.1",
        commitSha,
        targetArch: "unknown",
        assetPaths,
      }),
    /архитектура/u,
  );
  assert.throws(
    () =>
      buildPreviewReleaseCreateArgs({
        tag: "v3.17.1",
        commitSha,
        targetArch: "arm64",
        assetPaths: ["/tmp/ZCode Preview-3.17.1-mac-arm64.dmg", assetPaths[1]],
      }),
    /точную пару/u,
  );
});

test("Preview publication refuses non-macOS, non-dev, dirty, stale, or already-tagged candidates", () => {
  assert.throws(
    () => assertPreviewReleasePreconditions({ platform: "linux", branchName: "dev", dirty: false }),
    /must be built on macOS/u,
  );
  assert.throws(
    () =>
      assertPreviewReleasePreconditions({ platform: "darwin", branchName: "main", dirty: false }),
    /только из dev/u,
  );
  assert.throws(
    () => assertPreviewReleasePreconditions({ platform: "darwin", branchName: "dev", dirty: true }),
    /не чистое/u,
  );
  assert.throws(() => assertPreviewReleaseBaseSha(commitSha, "b".repeat(40)), /не совпадает/u);
  assert.throws(
    () => assertPreviewReleaseTagAvailable("v3.17.1", "f".repeat(40)),
    /уже существует/u,
  );
  assert.doesNotThrow(() => assertPreviewReleaseTagAvailable("v3.17.1", ""));
});

test("Preview release runs its local verification gates in the required order", async () => {
  const commands = [];
  await runPreviewReleaseLocalGates(async (command) => {
    commands.push(command);
  });
  assert.deepEqual(commands, [
    ["pnpm", "verify:pre-push"],
    ["pnpm", "typecheck"],
  ]);
});

test("Preview release stops before typecheck when its local pre-push gate fails", async () => {
  const commands = [];
  await assert.rejects(
    runPreviewReleaseLocalGates(async (command) => {
      commands.push(command);
      throw new Error("local verification failed");
    }),
    /local verification failed/u,
  );
  assert.deepEqual(commands, [["pnpm", "verify:pre-push"]]);
});

test("Preview resume requires the exact pushed version commit and permits only its tag target", () => {
  assert.doesNotThrow(() =>
    assertPreviewResumeCandidate({
      version: "3.17.1",
      branchName: "dev",
      dirty: false,
      headSha: commitSha,
      originDevSha: commitSha,
      commitMessage: "Выпустить macOS Preview 3.17.1.",
      changedPaths: ["package.json", "package-lock.json"],
      packageJsonVersion: "3.17.1",
      packageLock: { version: "3.17.1", packages: { "": { version: "3.17.1" } } },
    }),
  );
  assert.throws(
    () =>
      assertPreviewResumeCandidate({
        version: "3.17.1",
        branchName: "dev",
        dirty: false,
        headSha: commitSha,
        originDevSha: commitSha,
        commitMessage: "some other commit",
        changedPaths: ["package.json", "package-lock.json"],
        packageJsonVersion: "3.17.1",
        packageLock: { version: "3.17.1", packages: { "": { version: "3.17.1" } } },
      }),
    /не является version commit/u,
  );
  assert.throws(
    () =>
      assertPreviewResumeCandidate({
        version: "3.17.1",
        branchName: "dev",
        dirty: false,
        headSha: commitSha,
        originDevSha: commitSha,
        commitMessage: "Выпустить macOS Preview 3.17.1.",
        changedPaths: ["package.json", "packages/desktop/main.mjs"],
        packageJsonVersion: "3.17.1",
        packageLock: { version: "3.17.1", packages: { "": { version: "3.17.1" } } },
      }),
    /должен менять только/u,
  );
  assert.throws(
    () =>
      assertPreviewResumeCandidate({
        version: "3.17.1",
        branchName: "dev",
        dirty: false,
        headSha: commitSha,
        originDevSha: commitSha,
        commitMessage: "Выпустить macOS Preview 3.17.1.",
        changedPaths: ["package.json", "package-lock.json"],
        packageJsonVersion: "3.17.1",
        packageLock: { version: "3.17.0", packages: { "": { version: "3.17.0" } } },
      }),
    /не совпадают/u,
  );
  assert.throws(
    () => assertPreviewResumeTagTarget("v3.17.1", "b".repeat(40), commitSha),
    /не совпадает/u,
  );
  assert.equal(assertPreviewResumeTagTarget("v3.17.1", commitSha, commitSha), "v3.17.1");
});

test("Preview resume treats only GitHub 404 as an absent release", () => {
  assert.equal(isMissingGitHubRelease(new Error("gh: HTTP 404: Not Found")), true);
  assert.equal(
    isMissingGitHubRelease(new Error("gh завершился с кодом 1: release not found")),
    true,
  );
  assert.equal(isMissingGitHubRelease(new Error("gh: HTTP 403: Forbidden")), false);
  assert.equal(
    isMissingGitHubRelease(new Error("gh завершился с кодом 1: authentication failed")),
    false,
  );
  assert.equal(isMissingGitHubRelease(new Error("network timeout")), false);
});

test("Preview version commit synchronizes both root package-lock version fields", () => {
  const lockfile = {
    name: "zcode",
    version: "3.17.0",
    lockfileVersion: 3,
    packages: { "": { name: "zcode", version: "3.17.0" } },
  };
  const updated = JSON.parse(
    replaceRootPackageLockVersion(JSON.stringify(lockfile, null, 2), "3.17.1"),
  );
  assert.equal(updated.version, "3.17.1");
  assert.equal(updated.packages[""].version, "3.17.1");
  assert.throws(() => replaceRootPackageLockVersion("{}", "3.17.1"), /корневого пакета/u);
});
