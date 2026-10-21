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
  validatePreviewTestEndpoint,
} from "../release-macos-preview.mjs";

const commitSha = "a".repeat(40);
const assetPaths = [
  "/tmp/ZCode Preview-3.17.1-mac-arm64_TEST.dmg",
  "/tmp/ZCode Preview-3.17.1-mac-arm64_TEST.zip",
];

test("Preview build requires a separate HTTPS endpoint and pins every ZCode URL alias", () => {
  assert.throws(() => validatePreviewTestEndpoint(undefined), /ZCODE_PREVIEW_TEST_BASE_URL/u);
  assert.throws(() => validatePreviewTestEndpoint("http://test.example.invalid/api/v1"), /HTTPS/u);
  assert.throws(
    () => validatePreviewTestEndpoint("https://zcode.z.ai/api/v1"),
    /отличаться от production endpoint/u,
  );
  assert.throws(
    () => validatePreviewTestEndpoint("https://zcode.z.ai/api/v1/?tenant=test"),
    /отличаться от production endpoint/u,
  );
  assert.throws(
    () => validatePreviewTestEndpoint("https://zcode.z.ai/api/v1/"),
    /отличаться от production endpoint/u,
  );
  assert.equal(
    validatePreviewTestEndpoint("https://preview.example.invalid/api/v1/"),
    "https://preview.example.invalid/api/v1",
  );
  assert.equal(
    validatePreviewTestEndpoint("https://zcode.z.ai/test/api/v1"),
    "https://zcode.z.ai/test/api/v1",
  );

  const env = createPreviewBuildEnvironment({
    ZCODE_PREVIEW_TEST_BASE_URL: "https://preview.example.invalid/api/v1",
    ZCODE_BASE_URL: "https://zcode.z.ai/api/v1",
    ZCODE_ENDPOINT_ORIGIN: "https://production.example.invalid",
    ZCODE_TEST_BASE_URL: "https://other-test.example.invalid",
    ZCODE_PRODUCTION_BASE_URL: "https://zcode.z.ai",
    APPLE_ID: "must-not-be-forwarded",
    CSC_LINK: "must-not-be-forwarded",
    GH_TOKEN: "must-not-be-forwarded",
  });
  assert.equal(env.ZCODE_ENV, "test");
  for (const name of [
    "ZCODE_BASE_URL",
    "ZCODE_ENDPOINT_ORIGIN",
    "ZCODE_TEST_BASE_URL",
    "ZCODE_PRODUCTION_BASE_URL",
  ]) {
    assert.equal(env[name], "https://preview.example.invalid/api/v1");
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
        (arg.includes("тестовому backend") && arg.includes("не к production endpoints")) ||
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

test("Preview resume requires the exact pushed version commit and permits only its tag target", () => {
  assert.doesNotThrow(() =>
    assertPreviewResumeCandidate({
      version: "3.17.1",
      branchName: "dev",
      dirty: false,
      headSha: commitSha,
      originDevSha: commitSha,
      commitMessage: "Выпустить macOS Preview 3.17.1.",
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
      }),
    /не является version commit/u,
  );
  assert.throws(
    () => assertPreviewResumeTagTarget("v3.17.1", "b".repeat(40), commitSha),
    /не совпадает/u,
  );
  assert.equal(assertPreviewResumeTagTarget("v3.17.1", commitSha, commitSha), "v3.17.1");
});

test("Preview resume treats only GitHub 404 as an absent release", () => {
  assert.equal(isMissingGitHubRelease(new Error("gh: HTTP 404: Not Found")), true);
  assert.equal(isMissingGitHubRelease(new Error("gh: HTTP 403: Forbidden")), false);
  assert.equal(isMissingGitHubRelease(new Error("network timeout")), false);
});
