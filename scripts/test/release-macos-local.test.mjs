import assert from "node:assert/strict";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertMacReleaseAssetPair,
  assertZipContainsOnlyReleaseApp,
  assertAssetHashes,
  assertReleaseBranch,
  assertReleaseMetadata,
  assertReleaseTargetSha,
  assertUnsignedMacApp,
  bumpSemver,
  buildReleaseCreateArgs,
  clearExpectedMacReleaseAssets,
  macTargetArch,
  preflightMacRelease,
  replacePackageVersion,
  resolveTagCommitSha,
  selectMacReleaseAppBundle,
  selectMacReleaseAssets,
  sha256,
} from "../release-macos-local.mjs";
import {
  assertPreviewReleaseMetadata,
  createPreviewBuildEnvironment,
} from "../release-macos-preview.mjs";

async function createAppBundle(
  appPath,
  {
    version = "3.17.1",
    architecture = "arm64",
    signature = "signed-stapled",
    ticket = "stapled-ticket",
    bundleId = "dev.zcode.app",
    unsigned = false,
  } = {},
) {
  await mkdir(path.join(appPath, "Contents", "MacOS"), { recursive: true });
  if (!unsigned) await mkdir(path.join(appPath, "Contents", "_CodeSignature"), { recursive: true });
  await writeFile(
    path.join(appPath, "Contents", "Info.plist"),
    `CFBundleShortVersionString=${version}\nCFBundleIdentifier=${bundleId}\nCFBundleExecutable=ZCode\n`,
  );
  await writeFile(path.join(appPath, "Contents", "MacOS", "ZCode"), architecture);
  if (!unsigned) {
    await writeFile(path.join(appPath, "Contents", "_CodeSignature", "CodeResources"), signature);
    await writeFile(path.join(appPath, "Contents", "ticket"), ticket);
  }
}

async function createReleaseFixture(
  root,
  {
    zipVersion = "3.17.1",
    zipArch = "arm64",
    zipSignature = "signed-stapled",
    zipTicket = "stapled-ticket",
    dmgVersion = "3.17.1",
    dmgArch = "arm64",
    dmgSignature = "signed-stapled",
    dmgTicket = "stapled-ticket",
    zipEntries,
    doctorRejectAt,
    productName = "ZCode",
    appBundleName = `${productName}.app`,
    bundleId = "dev.zcode.app",
    unsigned = false,
    artifactSuffix = "",
  } = {},
) {
  const distDir = path.join(root, "dist");
  const appName = appBundleName;
  const sourceAppPath = path.join(distDir, "mac-arm64", appName);
  const zipAppPath = path.join(root, "zip-payload", appName);
  const dmgAppPath = path.join(root, "dmg-payload", appName);
  await createAppBundle(sourceAppPath, { bundleId, unsigned });
  await createAppBundle(zipAppPath, {
    version: zipVersion,
    architecture: zipArch,
    signature: zipSignature,
    ticket: zipTicket,
    bundleId,
    unsigned,
  });
  await createAppBundle(dmgAppPath, {
    version: dmgVersion,
    architecture: dmgArch,
    signature: dmgSignature,
    ticket: dmgTicket,
    bundleId,
    unsigned,
  });
  const zipPath = path.join(distDir, `${productName}-3.17.1-mac-arm64${artifactSuffix}.zip`);
  const dmgPath = path.join(distDir, `${productName}-3.17.1-mac-arm64${artifactSuffix}.dmg`);
  await writeFile(zipPath, "fake zip bytes");
  await writeFile(dmgPath, "fake dmg bytes");
  const commands = [];
  const doctorCalls = [];
  const entries = zipEntries ?? [
    `${appName}/`,
    `${appName}/Contents/`,
    `${appName}/Contents/Info.plist`,
    `${appName}/Contents/MacOS/`,
    `${appName}/Contents/MacOS/ZCode`,
    ...(unsigned
      ? []
      : [`${appName}/Contents/_CodeSignature/CodeResources`, `${appName}/Contents/ticket`]),
  ];
  const captureCommand = async (command) => {
    commands.push(command);
    if (command[0] === "unzip" && command[1] === "-Z1") return entries.join("\n");
    if (command[0] === "/usr/libexec/PlistBuddy") {
      const plist = await readFile(command[3], "utf8");
      const field = command[2].replace("Print :", "");
      const match = new RegExp(`^${field}=(.*)$`, "mu").exec(plist);
      if (!match) throw new Error(`missing fixture plist field ${field}`);
      return match[1];
    }
    if (command[0] === "lipo" && command[1] === "-archs") {
      return readFile(command[2], "utf8");
    }
    throw new Error(`unexpected fake capture command: ${command[0]}`);
  };
  const runCommand = async (command, options) => {
    commands.push(command);
    if (command[0] === "bash") {
      doctorCalls.push({ appPath: command[2], options });
      if (doctorCalls.length === doctorRejectAt) {
        throw new Error("fake signature/Gatekeeper/staple rejection");
      }
      return;
    }
    if (command[0] === "ditto") {
      await cp(zipAppPath, path.join(command[4], appName), { recursive: true });
      return;
    }
    if (command[0] === "hdiutil" && command[1] === "attach") {
      const mountPoint = command[6];
      await cp(dmgAppPath, path.join(mountPoint, appName), { recursive: true });
      return;
    }
    if (command[0] === "hdiutil" && command[1] === "detach") return;
    throw new Error(`unexpected fake command: ${command[0]}`);
  };
  return {
    distDir,
    sourceAppPath,
    zipPath,
    dmgPath,
    commands,
    doctorCalls,
    captureCommand,
    runCommand,
  };
}

test("major и minor сбрасывают младшие разряды", () => {
  assert.equal(bumpSemver("3.16.2", "patch"), "3.16.3");
  assert.equal(bumpSemver("3.16.2", "minor"), "3.17.0");
  assert.equal(bumpSemver("3.16.2", "major"), "4.0.0");
});

test("Preview identity использует тестовый backend и не наследует секреты подписи или GitHub", () => {
  const env = createPreviewBuildEnvironment({
    PATH: "/usr/bin",
    ZCODE_PREVIEW_TEST_BASE_URL: "https://preview.example.invalid/api/v1",
    APPLE_API_KEY: "must-not-be-forwarded",
    APPLE_ID: "must-not-be-forwarded",
    CSC_LINK: "must-not-be-forwarded",
    CSC_NAME: "must-not-be-forwarded",
    GH_TOKEN: "must-not-be-forwarded",
    GITHUB_TOKEN: "must-not-be-forwarded",
    ZCODE_ENV: "test",
    ZCODE_PREVIEW_IDENTITY: "0",
    ZCODE_ENABLE_MAC_SIGN: "1",
    ZCODE_ENABLE_MAC_NOTARIZE: "1",
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.ZCODE_ENV, "test");
  assert.equal(env.ZCODE_PREVIEW_IDENTITY, "1");
  assert.equal(env.ZCODE_ENABLE_MAC_SIGN, "0");
  assert.equal(env.ZCODE_ENABLE_MAC_NOTARIZE, "0");
  assert.equal(env.CSC_IDENTITY_AUTO_DISCOVERY, "false");
  assert.equal("APPLE_API_KEY" in env, false);
  assert.equal("APPLE_ID" in env, false);
  assert.equal("CSC_LINK" in env, false);
  assert.equal("CSC_NAME" in env, false);
  assert.equal("GH_TOKEN" in env, false);
  assert.equal("GITHUB_TOKEN" in env, false);
});

test("Preview release требует опубликованный prerelease", () => {
  const metadata = {
    tagName: "v3.17.1",
    isDraft: false,
    isPrerelease: true,
    assets: [{ name: "ZCode.Preview-3.17.1-mac-arm64_TEST.dmg" }],
  };
  assert.doesNotThrow(() =>
    assertPreviewReleaseMetadata(metadata, "v3.17.1", ["ZCode Preview-3.17.1-mac-arm64_TEST.dmg"]),
  );
  assert.throws(
    () =>
      assertPreviewReleaseMetadata({ ...metadata, isPrerelease: false }, "v3.17.1", [
        "ZCode Preview-3.17.1-mac-arm64_TEST.dmg",
      ]),
    /prerelease/u,
  );
});

test("unsigned Preview отклоняет app bundle с подписью", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-preview-unsigned-"));
  try {
    const contents = path.join(root, "Contents");
    await mkdir(contents, { recursive: true });
    await assertUnsignedMacApp(root);
    await mkdir(path.join(contents, "_CodeSignature"));
    await assert.rejects(assertUnsignedMacApp(root), /ожидается unsigned/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("неизвестный уровень не молча становится patch", () => {
  assert.throws(() => bumpSemver("3.16.2", "beta"), /major, minor или patch/);
});

test("версия в package.json меняется на месте", () => {
  const source = '{\n  "name": "zcode",\n  "version": "3.16.2",\n  "private": true\n}\n';
  assert.equal(
    replacePackageVersion(source, "3.17.0"),
    '{\n  "name": "zcode",\n  "version": "3.17.0",\n  "private": true\n}\n',
  );
});

test("в релиз попадает точная пара dmg и zip этой версии и архитектуры", () => {
  const selected = selectMacReleaseAssets(
    [
      "ZCode-3.17.0-mac-arm64.dmg",
      "ZCode-3.17.0-mac-arm64.dmg.blockmap",
      "ZCode-3.17.0-mac-arm64.zip",
      "ZCode-3.17.0-mac-x64.dmg",
      "ZCode-3.17.0-mac-x64.zip",
      "ZCode-3.17.0-mac-arm64_TEST.dmg",
      "ZCode Preview-3.17.0-mac-arm64.dmg",
      "ZCode-3.16.2-mac-arm64.dmg",
      "ZCode-3.17.0-win-arm64.exe",
    ],
    "3.17.0",
    "arm64",
  );
  assert.deepEqual(selected, ["ZCode-3.17.0-mac-arm64.dmg", "ZCode-3.17.0-mac-arm64.zip"]);
  assert.throws(() => selectMacReleaseAssets([], "3.17.0"), /точная архитектура/);
});

test("Preview assets используют тестовый backend suffix и отделены от stable assets", () => {
  assert.deepEqual(
    selectMacReleaseAssets(
      [
        "ZCode Preview-3.17.0-mac-arm64_TEST.dmg",
        "ZCode Preview-3.17.0-mac-arm64_TEST.zip",
        "ZCode-3.17.0-mac-arm64.dmg",
        "ZCode Preview-3.17.0-mac-arm64.dmg",
      ],
      "3.17.0",
      "arm64",
      "ZCode Preview",
      "_TEST",
    ),
    ["ZCode Preview-3.17.0-mac-arm64_TEST.dmg", "ZCode Preview-3.17.0-mac-arm64_TEST.zip"],
  );
});

test("перед сборкой удаляются только точные DMG/ZIP текущей версии и архитектуры", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-release-clean-output-"));
  try {
    const distDir = path.join(root, "dist");
    await mkdir(distDir, { recursive: true });
    const files = [
      "ZCode-3.17.1-mac-arm64.dmg",
      "ZCode-3.17.1-mac-arm64.zip",
      "ZCode-3.17.1-mac-arm64.dmg.blockmap",
      "ZCode-3.17.1-mac-x64.dmg",
      "ZCode-3.17.0-mac-arm64.zip",
    ];
    for (const name of files) await writeFile(path.join(distDir, name), name);
    const removed = [];
    const paths = await clearExpectedMacReleaseAssets({
      distDir,
      version: "3.17.1",
      targetArch: "arm64",
      removeFile: async (filePath) => {
        removed.push(path.basename(filePath));
        await rm(filePath, { force: true });
      },
    });
    assert.deepEqual(removed, ["ZCode-3.17.1-mac-arm64.dmg", "ZCode-3.17.1-mac-arm64.zip"]);
    assert.deepEqual(
      paths.map((filePath) => path.basename(filePath)),
      removed,
    );
    assert.deepEqual((await readdir(distDir)).sort(), files.slice(2).sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ZIP listing rejects entries outside app bundle and path traversal", () => {
  assert.doesNotThrow(() =>
    assertZipContainsOnlyReleaseApp(["ZCode.app/", "ZCode.app/Contents/Info.plist"]),
  );
  assert.throws(
    () => assertZipContainsOnlyReleaseApp(["ZCode.app/Contents/Info.plist", "README.txt"]),
    /только ZCode\.app/u,
  );
  assert.throws(
    () => assertZipContainsOnlyReleaseApp(["ZCode.app/../../outside"]),
    /только ZCode\.app/u,
  );
});

test("архитектура сборки совпадает с машиной", () => {
  assert.equal(macTargetArch("arm64"), "arm64");
  assert.equal(macTargetArch("x64"), "x64");
  assert.throws(() => macTargetArch("ia32"), /не поддерживает/);
});

test("релиз возможен только из dev", () => {
  assert.doesNotThrow(() => assertReleaseBranch("dev"));
  assert.throws(() => assertReleaseBranch("main"), /только из dev/);
});

test("production app bundle и exact asset pair обязательны", () => {
  assert.equal(
    selectMacReleaseAppBundle([
      { name: "ZCode.app", isDirectory: () => true },
      { name: "ZCode Helper.app", isDirectory: () => false },
    ]),
    "ZCode.app",
  );
  assert.throws(
    () => selectMacReleaseAppBundle([{ name: "ZCode Preview.app", isDirectory: () => true }]),
    /production-сборка ZCode\.app/u,
  );
  assert.doesNotThrow(() =>
    assertMacReleaseAssetPair(
      ["ZCode-3.17.1-mac-arm64.dmg", "ZCode-3.17.1-mac-arm64.zip"],
      "3.17.1",
      "arm64",
    ),
  );
  assert.throws(
    () =>
      assertMacReleaseAssetPair(
        ["ZCode-3.17.1-mac-arm64_TEST.dmg", "ZCode-3.17.1-mac-arm64.zip"],
        "3.17.1",
        "arm64",
      ),
    /Нужна ровно пара/u,
  );
});

test("release target обязан быть SHA собранного commit", () => {
  const expected = "a".repeat(40);
  assert.doesNotThrow(() => assertReleaseTargetSha(expected, expected));
  assert.throws(() => assertReleaseTargetSha("b".repeat(40), expected), /не совпадает/u);
  assert.throws(() => assertReleaseTargetSha("dev", expected), /не совпадает/u);
});

test("annotated tag разрешается до commit SHA, lightweight tag принимается напрямую", async () => {
  const expectedCommit = "a".repeat(40);
  const firstTag = "b".repeat(40);
  const secondTag = "c".repeat(40);
  const calls = [];
  const commit = await resolveTagCommitSha("v3.17.1", async (route) => {
    calls.push(route);
    if (route.endsWith("/git/ref/tags/v3.17.1")) {
      return { object: { type: "tag", sha: firstTag } };
    }
    if (route.endsWith(`/git/tags/${firstTag}`)) {
      return { object: { type: "tag", sha: secondTag } };
    }
    return { object: { type: "commit", sha: expectedCommit } };
  });
  assert.equal(commit, expectedCommit);
  assert.equal(calls.length, 3);

  assert.equal(
    await resolveTagCommitSha("v3.17.1", async () => ({
      object: { type: "commit", sha: expectedCommit },
    })),
    expectedCommit,
  );
});

test("локальный release preflight проходит без публикации, проверяя app staple и обе локальные пары", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-release-preflight-"));
  try {
    const fixture = await createReleaseFixture(root);
    const preflight = await preflightMacRelease({
      version: "3.17.1",
      targetArch: "arm64",
      distDir: fixture.distDir,
      runCommand: fixture.runCommand,
      captureCommand: fixture.captureCommand,
    });

    assert.equal(preflight.appPath, fixture.sourceAppPath);
    assert.deepEqual(preflight.assetNames, [
      path.basename(fixture.dmgPath),
      path.basename(fixture.zipPath),
    ]);
    assert.equal(fixture.doctorCalls.length, 3, "source app, ZIP app, DMG app each pass doctor");
    assert.deepEqual(
      fixture.doctorCalls.map(({ options }) => options.env.ZCODE_MACOS_REQUIRE_APP_STAPLE),
      ["1", "1", "1"],
    );
    assert.equal(fixture.doctorCalls[0].appPath, await realpath(fixture.sourceAppPath));
    assert.ok(fixture.commands.some((command) => command[0] === "ditto"));
    assert.ok(
      fixture.commands.some((command) => command[0] === "hdiutil" && command[1] === "attach"),
    );
    assert.ok(
      fixture.commands.some((command) => command[0] === "hdiutil" && command[1] === "detach"),
    );
    assert.deepEqual(
      new Map(
        await Promise.all(
          [fixture.dmgPath, fixture.zipPath].map(async (assetPath) => [
            path.basename(assetPath),
            sha256(await readFile(assetPath)),
          ]),
        ),
      ),
      preflight.assetHashes,
    );

    const releaseCommitSha = "d".repeat(40);
    assertReleaseTargetSha(releaseCommitSha, releaseCommitSha);
    const assetNames = preflight.assetNames;
    const createArgs = buildReleaseCreateArgs({
      tag: "v3.17.1",
      commitSha: releaseCommitSha,
      targetArch: "arm64",
      assetPaths: preflight.assetPaths,
    });
    assert.equal(createArgs[0], "gh");
    assert.equal(createArgs[1], "release");
    assert.equal(createArgs[2], "create");
    assert.equal(createArgs[createArgs.indexOf("--target") + 1], releaseCommitSha);
    assert.deepEqual(createArgs.slice(-2), preflight.assetPaths);
    assert.doesNotThrow(() =>
      assertReleaseMetadata(
        {
          tagName: "v3.17.1",
          isDraft: false,
          assets: assetNames.map((name) => ({ name })),
        },
        "v3.17.1",
        assetNames,
      ),
    );
    const downloadedHashes = new Map(preflight.assetHashes);
    assert.doesNotThrow(() => assertAssetHashes(preflight.assetHashes, downloadedHashes));
    assert.equal(
      fixture.commands.some((command) => command.includes("push") || command.includes("create")),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Preview preflight validates preview identity, architecture and unsigned archive payloads", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-preview-preflight-"));
  try {
    const fixture = await createReleaseFixture(root, {
      productName: "ZCode Preview",
      appBundleName: "ZCodePreview.app",
      bundleId: "dev.zcode.app.preview",
      unsigned: true,
      artifactSuffix: "_TEST",
    });
    const result = await preflightMacRelease({
      version: "3.17.1",
      targetArch: "arm64",
      distDir: fixture.distDir,
      productName: "ZCode Preview",
      appBundleName: "ZCodePreview.app",
      artifactSuffix: "_TEST",
      expectedBundleId: "dev.zcode.app.preview",
      requireStaple: false,
      requireUnsigned: true,
      runCommand: fixture.runCommand,
      captureCommand: fixture.captureCommand,
      hashDirectory: async () => "preview-app-tree",
    });
    assert.equal(path.basename(result.appPath), "ZCodePreview.app");
    assert.deepEqual(result.assetNames, [
      "ZCode Preview-3.17.1-mac-arm64_TEST.dmg",
      "ZCode Preview-3.17.1-mac-arm64_TEST.zip",
    ]);
    assert.equal(fixture.doctorCalls.length, 0);
    assert.equal(
      fixture.commands.some((command) => command[0] === "bash"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("отказ local signing/notarization gate прерывает preflight до release actions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-release-preflight-fail-"));
  try {
    const fixture = await createReleaseFixture(root, { doctorRejectAt: 2 });
    await assert.rejects(
      preflightMacRelease({
        version: "3.17.1",
        targetArch: "arm64",
        distDir: fixture.distDir,
        runCommand: fixture.runCommand,
        captureCommand: fixture.captureCommand,
      }),
      /Gatekeeper\/staple rejection/u,
    );
    assert.equal(fixture.doctorCalls.length, 2, "ZIP payload reruns the fail-closed doctor gate");
    assert.equal(
      fixture.commands.some((command) => command.includes("push") || command.includes("create")),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("устаревшее приложение в ZIP отклоняется по версии до публикации", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-release-stale-zip-"));
  try {
    const fixture = await createReleaseFixture(root, { zipVersion: "3.17.0" });
    await assert.rejects(
      preflightMacRelease({
        version: "3.17.1",
        targetArch: "arm64",
        distDir: fixture.distDir,
        runCommand: fixture.runCommand,
        captureCommand: fixture.captureCommand,
      }),
      /version 3\.17\.0 не совпадает/u,
    );
    assert.equal(
      fixture.doctorCalls.length,
      1,
      "source bundle passed; stale ZIP failed before doctor",
    );
    assert.equal(
      fixture.commands.some((command) => command.includes("push") || command.includes("create")),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("подменённая подпись в ZIP отклоняется сравнением extracted app tree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-release-substituted-zip-"));
  try {
    const fixture = await createReleaseFixture(root, { zipSignature: "different-signature" });
    await assert.rejects(
      preflightMacRelease({
        version: "3.17.1",
        targetArch: "arm64",
        distDir: fixture.distDir,
        runCommand: fixture.runCommand,
        captureCommand: fixture.captureCommand,
      }),
      /ZIP app payload\/signature\/staple отличается/u,
    );
    assert.equal(
      fixture.doctorCalls.length,
      2,
      "ZIP app still passes the same doctor checks before identity comparison",
    );
    assert.equal(
      fixture.commands.some((command) => command.includes("push") || command.includes("create")),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("подменённый notarization ticket в DMG отклоняется и образ всегда отсоединяется", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-release-substituted-dmg-"));
  try {
    const fixture = await createReleaseFixture(root, { dmgTicket: "different-ticket" });
    await assert.rejects(
      preflightMacRelease({
        version: "3.17.1",
        targetArch: "arm64",
        distDir: fixture.distDir,
        runCommand: fixture.runCommand,
        captureCommand: fixture.captureCommand,
      }),
      /DMG app payload\/signature\/staple отличается/u,
    );
    assert.equal(
      fixture.doctorCalls.length,
      3,
      "the DMG payload passed the same doctor checks first",
    );
    assert.ok(
      fixture.commands.some((command) => command[0] === "hdiutil" && command[1] === "detach"),
    );
    assert.equal(
      fixture.commands.some((command) => command.includes("push") || command.includes("create")),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DMG с приложением другой архитектуры отклоняется и образ отсоединяется", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-release-dmg-arch-"));
  try {
    const fixture = await createReleaseFixture(root, { dmgArch: "x86_64" });
    await assert.rejects(
      preflightMacRelease({
        version: "3.17.1",
        targetArch: "arm64",
        distDir: fixture.distDir,
        runCommand: fixture.runCommand,
        captureCommand: fixture.captureCommand,
      }),
      /architecture x86_64 не совпадает с arm64/u,
    );
    assert.equal(
      fixture.doctorCalls.length,
      2,
      "DMG architecture check fails before its doctor run",
    );
    assert.ok(
      fixture.commands.some((command) => command[0] === "hdiutil" && command[1] === "detach"),
    );
    assert.equal(
      fixture.commands.some((command) => command.includes("push") || command.includes("create")),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ZIP app symlink вместо bundle отклоняется", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-release-zip-symlink-"));
  try {
    const fixture = await createReleaseFixture(root);
    const extractionOutside = path.join(root, "zip-payload", "ZCode.app");
    const extractor = fixture.runCommand;
    fixture.runCommand = async (command, options) => {
      if (command[0] === "ditto") {
        await symlink(extractionOutside, path.join(command[4], "ZCode.app"));
        return;
      }
      return extractor(command, options);
    };
    await assert.rejects(
      preflightMacRelease({
        version: "3.17.1",
        targetArch: "arm64",
        distDir: fixture.distDir,
        runCommand: fixture.runCommand,
        captureCommand: fixture.captureCommand,
      }),
      /(обычной директорией|находится вне app bundle)/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("опубликованные файлы и их SHA-256 совпадают с локальной сборкой", () => {
  const assetNames = ["ZCode-3.17.1-mac-arm64.dmg", "ZCode-3.17.1-mac-arm64.zip"];
  const release = {
    tagName: "v3.17.1",
    isDraft: false,
    assets: assetNames.map((name) => ({ name })),
  };
  assert.doesNotThrow(() => assertReleaseMetadata(release, "v3.17.1", assetNames));
  assert.throws(
    () => assertReleaseMetadata({ ...release, isDraft: true }, "v3.17.1", assetNames),
    /не подтвердил/,
  );
  assert.throws(
    () =>
      assertReleaseMetadata(
        { ...release, assets: [{ name: assetNames[0] }] },
        "v3.17.1",
        assetNames,
      ),
    /неверный набор файлов/,
  );
  assert.doesNotThrow(() =>
    assertAssetHashes(
      new Map([
        [assetNames[0], sha256("dmg")],
        [assetNames[1], sha256("zip")],
      ]),
      new Map([
        [assetNames[0], sha256("dmg")],
        [assetNames[1], sha256("zip")],
      ]),
    ),
  );
  assert.throws(
    () =>
      assertAssetHashes(
        new Map([[assetNames[0], sha256("dmg")]]),
        new Map([[assetNames[0], sha256("other")]]),
      ),
    /не совпадает/,
  );

  const previewAssetNames = [
    "ZCode Preview-3.17.2-mac-arm64_TEST.dmg",
    "ZCode Preview-3.17.2-mac-arm64_TEST.zip",
  ];
  const githubPreviewNames = previewAssetNames.map((name) => name.replaceAll(" ", "."));
  assert.doesNotThrow(() =>
    assertReleaseMetadata(
      {
        tagName: "v3.17.2",
        isDraft: false,
        assets: githubPreviewNames.map((name) => ({ name })),
      },
      "v3.17.2",
      previewAssetNames,
    ),
  );
  assert.doesNotThrow(() =>
    assertAssetHashes(
      new Map([
        [previewAssetNames[0], sha256("preview dmg")],
        [previewAssetNames[1], sha256("preview zip")],
      ]),
      new Map([
        [githubPreviewNames[0], sha256("preview dmg")],
        [githubPreviewNames[1], sha256("preview zip")],
      ]),
    ),
  );
});
