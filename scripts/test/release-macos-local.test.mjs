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

async function createAppBundle(
  appPath,
  {
    version = "3.17.1",
    architecture = "arm64",
    signature = "signed-stapled",
    ticket = "stapled-ticket",
  } = {},
) {
  await mkdir(path.join(appPath, "Contents", "MacOS"), { recursive: true });
  await mkdir(path.join(appPath, "Contents", "_CodeSignature"), { recursive: true });
  await writeFile(
    path.join(appPath, "Contents", "Info.plist"),
    `CFBundleShortVersionString=${version}\nCFBundleExecutable=ZCode\n`,
  );
  await writeFile(path.join(appPath, "Contents", "MacOS", "ZCode"), architecture);
  await writeFile(path.join(appPath, "Contents", "_CodeSignature", "CodeResources"), signature);
  await writeFile(path.join(appPath, "Contents", "ticket"), ticket);
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
  } = {},
) {
  const distDir = path.join(root, "dist");
  const sourceAppPath = path.join(distDir, "mac-arm64", "ZCode.app");
  const zipAppPath = path.join(root, "zip-payload", "ZCode.app");
  const dmgAppPath = path.join(root, "dmg-payload", "ZCode.app");
  await createAppBundle(sourceAppPath);
  await createAppBundle(zipAppPath, {
    version: zipVersion,
    architecture: zipArch,
    signature: zipSignature,
    ticket: zipTicket,
  });
  await createAppBundle(dmgAppPath, {
    version: dmgVersion,
    architecture: dmgArch,
    signature: dmgSignature,
    ticket: dmgTicket,
  });
  const zipPath = path.join(distDir, "ZCode-3.17.1-mac-arm64.zip");
  const dmgPath = path.join(distDir, "ZCode-3.17.1-mac-arm64.dmg");
  await writeFile(zipPath, "fake zip bytes");
  await writeFile(dmgPath, "fake dmg bytes");
  const commands = [];
  const doctorCalls = [];
  const entries = zipEntries ?? [
    "ZCode.app/",
    "ZCode.app/Contents/",
    "ZCode.app/Contents/Info.plist",
    "ZCode.app/Contents/MacOS/",
    "ZCode.app/Contents/MacOS/ZCode",
    "ZCode.app/Contents/_CodeSignature/CodeResources",
    "ZCode.app/Contents/ticket",
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
      await cp(zipAppPath, path.join(command[4], "ZCode.app"), { recursive: true });
      return;
    }
    if (command[0] === "hdiutil" && command[1] === "attach") {
      const mountPoint = command[6];
      await cp(dmgAppPath, path.join(mountPoint, "ZCode.app"), { recursive: true });
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
});
