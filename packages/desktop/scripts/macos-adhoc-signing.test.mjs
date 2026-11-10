import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyMacAdHocSignature,
  assertMacAdHocNestedSignatures,
  assertMacAdHocSignature,
  buildMacAdHocCodesignArgs,
  findNestedMacAppBundles,
  hasSealedAdHocSignature,
  isMacAdHocSigned,
  resolveMacAdHocAppBundlePath,
  resolveMacAdHocSigningDecision,
} from "./macos-adhoc-signing.mjs";
import { preflightMacRelease } from "../../../scripts/release-macos-local.mjs";

const previewDecisionBase = {
  electronPlatformName: "darwin",
  productFlavor: "preview",
  signingEnabled: false,
};

test("ad-hoc подпись включается только для unsigned macOS Preview", () => {
  assert.deepEqual(resolveMacAdHocSigningDecision({ ...previewDecisionBase, env: {} }), {
    enabled: true,
    reason: "unsigned-preview",
  });
  assert.deepEqual(
    resolveMacAdHocSigningDecision({
      ...previewDecisionBase,
      electronPlatformName: "win32",
      env: {},
    }),
    { enabled: false, reason: "not-macos" },
  );
  assert.deepEqual(
    resolveMacAdHocSigningDecision({
      ...previewDecisionBase,
      productFlavor: "production",
      env: {},
    }),
    { enabled: false, reason: "not-preview" },
  );
});

test("Developer ID путь и signing-credentials отключают ad-hoc подпись", () => {
  assert.deepEqual(
    resolveMacAdHocSigningDecision({ ...previewDecisionBase, signingEnabled: true, env: {} }),
    { enabled: false, reason: "developer-id-signing-enabled" },
  );
  assert.deepEqual(
    resolveMacAdHocSigningDecision({ ...previewDecisionBase, forceCodeSigning: true, env: {} }),
    { enabled: false, reason: "developer-id-signing-enabled" },
  );
  for (const name of ["APPLE_SIGNING_IDENTITY", "CSC_NAME", "CSC_LINK", "CSC_KEYCHAIN"]) {
    assert.deepEqual(
      resolveMacAdHocSigningDecision({ ...previewDecisionBase, env: { [name]: "value" } }),
      { enabled: false, reason: `signing-credentials-present:${name}` },
    );
  }
  // Переключатель автопоиска не является credential: Preview выставляет его в "false".
  assert.equal(
    resolveMacAdHocSigningDecision({
      ...previewDecisionBase,
      env: { CSC_IDENTITY_AUTO_DISCOVERY: "false" },
    }).enabled,
    true,
  );
});

test("аргументы codesign и путь bundle фиксированы", () => {
  assert.deepEqual(buildMacAdHocCodesignArgs("/tmp/ZCode Preview.app"), [
    "--force",
    "--deep",
    "--sign",
    "-",
    "/tmp/ZCode Preview.app",
  ]);
  assert.equal(
    resolveMacAdHocAppBundlePath({ appOutDir: "/dist/mac-arm64", productFilename: "ZCodePreview" }),
    path.resolve("/dist/mac-arm64", "ZCodePreview.app"),
  );
  assert.throws(
    () => resolveMacAdHocAppBundlePath({ appOutDir: "/dist/mac-arm64" }),
    /productFilename/u,
  );
});

test("linker-signed executable без Sealed Resources не считается bundle-подписью", () => {
  const linkerSigned = [
    "Executable=/tmp/ZCodePreview.app/Contents/MacOS/ZCodePreview",
    "Identifier=Electron",
    "Signature=adhoc",
    "Sealed Resources=none",
  ].join("\n");
  assert.equal(hasSealedAdHocSignature(linkerSigned), false);
  assert.equal(
    hasSealedAdHocSignature(
      [
        "Executable=/tmp/ZCodePreview.app/Contents/MacOS/ZCodePreview",
        "Identifier=dev.zcode.app.preview",
        "Signature=adhoc",
        "Sealed Resources version=2 rules=13 files=1900",
      ].join("\n"),
    ),
    true,
  );
  // Подпись identity другого типа не должна приниматься как ad-hoc.
  assert.equal(
    hasSealedAdHocSignature(
      [
        "Identifier=dev.zcode.app",
        "Authority=Developer ID Application: Example (TEAMID1234)",
        "Sealed Resources version=2 rules=13 files=1900",
      ].join("\n"),
    ),
    false,
  );
});

async function createProbeApp(
  appPath,
  { version = "1.0.0", bundleId = "dev.zcode.preview.probe" } = {},
) {
  await mkdir(path.join(appPath, "Contents", "MacOS"), { recursive: true });
  await writeFile(
    path.join(appPath, "Contents", "Info.plist"),
    `CFBundleShortVersionString=${version}\nCFBundleIdentifier=${bundleId}\nCFBundleExecutable=ZCodePreview\n`,
  );
  await writeFile(path.join(appPath, "Contents", "MacOS", "ZCodePreview"), "probe executable\n");
  return appPath;
}

test(
  "реальная ad-hoc подпись bundle идемпотентна и различима от linker-signed",
  { skip: process.platform !== "darwin" ? "codesign доступен только на macOS" : false },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zcode-adhoc-probe-"));
    try {
      const appPath = await createProbeApp(path.join(root, "ZCodePreview.app"));
      // Для codesign содержимое Mach-O не важно: подписывается структура bundle.
      assert.equal(isMacAdHocSigned(appPath), false);
      applyMacAdHocSignature(appPath);
      assert.equal(isMacAdHocSigned(appPath), true);
      assert.equal(applyMacAdHocSignature(appPath), appPath);
      const verify = spawnSync("codesign", ["--verify", "--deep", "--strict", appPath], {
        encoding: "utf8",
      });
      assert.equal(verify.status, 0, `${verify.stdout}${verify.stderr}`);
      assert.equal(assertMacAdHocSignature(appPath), appPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "linker-signed app отклоняется до bundle-подписи и исправляется applyMacAdHocSignature",
  { skip: process.platform !== "darwin" ? "codesign доступен только на macOS" : false },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zcode-adhoc-linker-probe-"));
    try {
      const appPath = await createProbeApp(path.join(root, "ZCodePreview.app"));
      const executablePath = path.join(appPath, "Contents", "MacOS", "ZCodePreview");
      // Реалистичный аналог Electron: executable подписан ad-hoc отдельно, ресурсы bundle
      // не запечатаны, поэтому `codesign -dv` даёт Sealed Resources=none.
      // Подпись ставится вне bundle: иначе codesign сам оформит bundle-подпись.
      const stagedExecutablePath = path.join(root, "ZCodePreview");
      await copyFile("/bin/echo", stagedExecutablePath);
      const executableSign = spawnSync(
        "codesign",
        ["--force", "--sign", "-", stagedExecutablePath],
        { encoding: "utf8" },
      );
      assert.equal(executableSign.status, 0, `${executableSign.stdout}${executableSign.stderr}`);
      await rm(executablePath, { force: true });
      await rename(stagedExecutablePath, executablePath);
      const details = spawnSync("codesign", ["-dv", "--verbose=2", appPath], {
        encoding: "utf8",
      });
      assert.match(`${details.stdout}${details.stderr}`, /Signature=adhoc/u);
      assert.match(`${details.stdout}${details.stderr}`, /Sealed Resources=none/u);
      assert.equal(isMacAdHocSigned(appPath), false);
      // Fail-closed на любой стадии: codesign --verify отвергает bundle без запечатанных
      // ресурсов, либо assert отвергает неполную подпись. Тихий fallback недопустим.
      assert.throws(
        () => assertMacAdHocSignature(appPath),
        /Ad-hoc подпись macOS Preview|ad-hoc подписи bundle/u,
      );
      applyMacAdHocSignature(appPath);
      assert.equal(isMacAdHocSigned(appPath), true);
      assert.equal(assertMacAdHocSignature(appPath), appPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "вложенный неподписанный .app обнаруживается и подписывается до запечатывания корня",
  { skip: process.platform !== "darwin" ? "codesign доступен только на macOS" : false },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zcode-adhoc-nested-probe-"));
    try {
      const appPath = await createProbeApp(path.join(root, "ZCodePreview.app"));
      // Helper app внутри Contents/Resources — реальный класс дефекта: `codesign --deep`
      // не запечатывает такой bundle, но корневой `--verify --deep --strict` возвращает 0.
      const nestedAppPath = await createProbeApp(
        path.join(appPath, "Contents", "Resources", "Helper.app"),
        { bundleId: "dev.zcode.preview.helper" },
      );
      const deepSign = spawnSync("codesign", buildMacAdHocCodesignArgs(appPath), {
        encoding: "utf8",
      });
      assert.equal(deepSign.status, 0, `${deepSign.stdout}${deepSign.stderr}`);

      // Фиксируем именно ту слепую зону, которую закрывает новая проверка.
      const rootVerify = spawnSync("codesign", ["--verify", "--deep", "--strict", appPath], {
        encoding: "utf8",
      });
      assert.equal(rootVerify.status, 0, `${rootVerify.stdout}${rootVerify.stderr}`);
      const nestedVerify = spawnSync("codesign", ["--verify", "--strict", nestedAppPath], {
        encoding: "utf8",
      });
      assert.notEqual(nestedVerify.status, 0);
      assert.match(
        `${nestedVerify.stdout}${nestedVerify.stderr}`,
        /not signed at all|не подписан/u,
      );

      // assert обязан упасть с указанием конкретного вложенного bundle.
      assert.throws(
        () => assertMacAdHocSignature(appPath),
        (error) =>
          error instanceof Error &&
          error.message.includes(nestedAppPath) &&
          /вложенный app bundle не подписан/u.test(error.message),
      );
      assert.equal(isMacAdHocSigned(appPath), false);

      // apply подписывает вложенный bundle явно, затем корень, и проверка проходит.
      assert.equal(applyMacAdHocSignature(appPath), appPath);
      assert.equal(isMacAdHocSigned(appPath), true);
      assert.equal(assertMacAdHocNestedSignatures(appPath), appPath);
      const repairedNestedVerify = spawnSync("codesign", ["--verify", "--strict", nestedAppPath], {
        encoding: "utf8",
      });
      assert.equal(
        repairedNestedVerify.status,
        0,
        `${repairedNestedVerify.stdout}${repairedNestedVerify.stderr}`,
      );
      // Повторный вызов не пересобирает подпись.
      assert.equal(applyMacAdHocSignature(appPath), appPath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "обход вложенных bundle не следует по symlink'ам Electron framework и не зацикливается",
  { skip: process.platform !== "darwin" ? "codesign доступен только на macOS" : false },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zcode-adhoc-symlink-probe-"));
    try {
      const appPath = await createProbeApp(path.join(root, "ZCodePreview.app"));
      const frameworkVersions = path.join(
        appPath,
        "Contents",
        "Frameworks",
        "Electron Framework.framework",
        "Versions",
      );
      await mkdir(path.join(frameworkVersions, "A"), { recursive: true });
      await symlink("A", path.join(frameworkVersions, "Current"));
      // Циклическая ссылка не должна приводить к бесконечному обходу.
      await symlink("..", path.join(frameworkVersions, "A", "Loop"));
      const nestedAppPath = await createProbeApp(
        path.join(appPath, "Contents", "Resources", "Helper.app"),
        { bundleId: "dev.zcode.preview.helper" },
      );
      const found = findNestedMacAppBundles(appPath);
      assert.deepEqual(found, [nestedAppPath]);
      assert.equal(found.includes(appPath), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "нечитаемый вложенный каталог не обходится молча: assert бросает с путём",
  {
    skip:
      process.platform === "win32"
        ? "chmod 000 не создаёт EACCES на Windows"
        : process.getuid?.() === 0
          ? "chmod 000 не ограничивает доступ root; проверка требует непривилегированного пользователя"
          : false,
  },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zcode-adhoc-unreadable-probe-"));
    const hiddenDir = path.join(root, "ZCodePreview.app", "Contents", "Resources", "Hidden");
    let hiddenDirCreated = false;
    let permissionsRestored = false;
    try {
      const appPath = await createProbeApp(path.join(root, "ZCodePreview.app"));
      await mkdir(hiddenDir, { recursive: true });
      hiddenDirCreated = true;
      await chmod(hiddenDir, 0o000);
      // Fail-closed: нечитаемый подкаталог обязан прервать обход, иначе вложенный
      // неподписанный `.app` внутри него остался бы вне release gate.
      assert.throws(
        () => findNestedMacAppBundles(appPath),
        (error) =>
          error instanceof Error &&
          error.message.includes(hiddenDir) &&
          /не удалось прочитать каталог/u.test(error.message),
      );
      assert.throws(
        () => assertMacAdHocNestedSignatures(appPath),
        (error) => error instanceof Error && error.message.includes(hiddenDir),
      );
    } finally {
      // Права восстанавливаются до удаления, чтобы rm не оставил нечитаемый мусор в /tmp.
      if (hiddenDirCreated) {
        await chmod(hiddenDir, 0o755).then(
          () => {
            permissionsRestored = true;
          },
          () => {},
        );
      }
      await rm(root, { recursive: true, force: true });
    }
    assert.equal(permissionsRestored, hiddenDirCreated);
  },
);

test(
  "symlink вместо Contents бросает и не подписывает bundle вне целевого .app",
  { skip: process.platform === "win32" ? "symlink на каталог требует прав Windows" : false },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zcode-adhoc-contents-symlink-probe-"));
    try {
      const appPath = path.join(root, "ZCodePreview.app");
      await mkdir(appPath, { recursive: true });
      const outsideRoot = path.join(root, "Outside");
      const outsideContents = path.join(outsideRoot, "Contents");
      await createProbeApp(outsideRoot);
      // Реальный класс дефекта: корневой `Contents` — ссылка на каталог вне `.app`.
      await symlink(outsideContents, path.join(appPath, "Contents"));
      assert.throws(
        () => findNestedMacAppBundles(appPath),
        (error) =>
          error instanceof Error &&
          error.message.includes("Contents") &&
          /вне app bundle/u.test(error.message),
      );
      assert.throws(
        () => assertMacAdHocNestedSignatures(appPath),
        (error) => error instanceof Error && /вне app bundle/u.test(error.message),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "сломанный symlink вместо Contents бросает, а не считается отсутствующим каталогом",
  { skip: process.platform === "win32" ? "symlink на каталог требует прав Windows" : false },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zcode-adhoc-broken-contents-probe-"));
    try {
      const appPath = await createProbeApp(path.join(root, "ZCodePreview.app"));
      const contentsPath = path.join(appPath, "Contents");
      await rm(contentsPath, { recursive: true, force: true });
      await symlink(path.join(root, "MissingContents"), contentsPath);
      // Старый existsSync-путь считал сломанную ссылку отсутствием Contents и
      // возвращал успех; теперь неразрешимый путь обязан бросить с путём.
      assert.throws(
        () => findNestedMacAppBundles(appPath),
        (error) =>
          error instanceof Error &&
          error.message.includes(contentsPath) &&
          /не удалось разрешить Contents/u.test(error.message),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "нормальный bundle без ссылок перечисляет вложенные .app от глубокого к внешнему",
  {
    skip: process.platform === "win32" ? "пути и symlink-семантика различаются на Windows" : false,
  },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zcode-adhoc-normal-probe-"));
    try {
      const appPath = await createProbeApp(path.join(root, "ZCodePreview.app"));
      const outerAppPath = await createProbeApp(
        path.join(appPath, "Contents", "Resources", "Outer.app"),
        { bundleId: "dev.zcode.preview.outer" },
      );
      const innerAppPath = await createProbeApp(
        path.join(outerAppPath, "Contents", "Resources", "Inner.app"),
        { bundleId: "dev.zcode.preview.inner" },
      );
      assert.deepEqual(findNestedMacAppBundles(appPath), [innerAppPath, outerAppPath]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

// Мини-фикстура release-каталога: preflight реально читает dist, Info.plist, ZIP и DMG.
async function createPreviewReleaseFixture(root, { sign = false, targetArch = "arm64" } = {}) {
  const distDir = path.join(root, "dist");
  const appName = "ZCodePreview.app";
  // electron-builder defaultArch=x64: appOutDir для x64 — dist/mac, для arm64 — dist/mac-arm64.
  const sourceAppPath = path.join(distDir, targetArch === "arm64" ? "mac-arm64" : "mac", appName);
  const zipAppPath = path.join(root, "zip-payload", appName);
  const dmgAppPath = path.join(root, "dmg-payload", appName);
  for (const appPath of [sourceAppPath, zipAppPath, dmgAppPath]) {
    await createProbeApp(appPath, { version: "3.17.1", bundleId: "dev.zcode.app.preview" });
    if (sign) applyMacAdHocSignature(appPath);
  }
  const zipPath = path.join(distDir, `ZCode Preview-3.17.1-mac-${targetArch}_TEST.zip`);
  const dmgPath = path.join(distDir, `ZCode Preview-3.17.1-mac-${targetArch}_TEST.dmg`);
  await writeFile(zipPath, "fake zip bytes");
  await writeFile(dmgPath, "fake dmg bytes");
  const captureCommand = async (command) => {
    if (command[0] === "unzip" && command[1] === "-Z1") {
      return [
        `${appName}/`,
        `${appName}/Contents/`,
        `${appName}/Contents/Info.plist`,
        `${appName}/Contents/MacOS/`,
        `${appName}/Contents/MacOS/ZCodePreview`,
      ].join("\n");
    }
    if (command[0] === "/usr/libexec/PlistBuddy") {
      const plist = await readFile(command[3], "utf8");
      const field = command[2].replace("Print :", "");
      const match = new RegExp(`^${field}=(.*)$`, "mu").exec(plist);
      if (!match) throw new Error(`missing fixture plist field ${field}`);
      return match[1];
    }
    if (command[0] === "lipo" && command[1] === "-archs") {
      return targetArch === "x64" ? "x86_64" : "arm64";
    }
    throw new Error(`unexpected fake capture command: ${command[0]}`);
  };
  const runCommand = async (command) => {
    if (command[0] === "ditto") {
      await cp(zipAppPath, path.join(command[4], appName), { recursive: true });
      return;
    }
    if (command[0] === "hdiutil" && command[1] === "attach") {
      await cp(dmgAppPath, path.join(command[6], appName), { recursive: true });
      return;
    }
    if (command[0] === "hdiutil" && command[1] === "detach") return;
    throw new Error(`unexpected fake command: ${command[0]}`);
  };
  return { distDir, captureCommand, runCommand };
}

const pinnedNodeOptions = { nodeVersion: "24.14.0", pinnedNodeVersion: "24.14.0" };
const previewPreflightOptions = {
  ...pinnedNodeOptions,
  version: "3.17.1",
  targetArch: "arm64",
  productName: "ZCode Preview",
  appBundleName: "ZCodePreview.app",
  artifactSuffix: "_TEST",
  expectedBundleId: "dev.zcode.app.preview",
  requireStaple: false,
  hashDirectory: async () => "preview-app-tree",
};

test(
  "Preview preflight принимает ad-hoc подписанные source app, ZIP и DMG",
  { skip: process.platform !== "darwin" ? "codesign доступен только на macOS" : false },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zcode-adhoc-preflight-"));
    try {
      const fixture = await createPreviewReleaseFixture(root, { sign: true });
      const preflight = await preflightMacRelease({
        ...previewPreflightOptions,
        distDir: fixture.distDir,
        requireAdHocSignature: true,
        runCommand: fixture.runCommand,
        captureCommand: fixture.captureCommand,
      });
      assert.deepEqual(preflight.assetNames, [
        "ZCode Preview-3.17.1-mac-arm64_TEST.dmg",
        "ZCode Preview-3.17.1-mac-arm64_TEST.zip",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "Preview preflight находит x64 bundle в electron-builder каталоге dist/mac",
  { skip: process.platform !== "darwin" ? "codesign доступен только на macOS" : false },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zcode-adhoc-preflight-x64-"));
    try {
      // electron-builder defaultArch=x64: appOutDir для x64 — dist/mac, не dist/mac-x64.
      const fixture = await createPreviewReleaseFixture(root, { sign: true, targetArch: "x64" });
      const preflight = await preflightMacRelease({
        ...previewPreflightOptions,
        targetArch: "x64",
        distDir: fixture.distDir,
        requireAdHocSignature: true,
        runCommand: fixture.runCommand,
        captureCommand: fixture.captureCommand,
      });
      assert.equal(preflight.appPath, path.join(fixture.distDir, "mac", "ZCodePreview.app"));
      assert.deepEqual(preflight.assetNames, [
        "ZCode Preview-3.17.1-mac-x64_TEST.dmg",
        "ZCode Preview-3.17.1-mac-x64_TEST.zip",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "Preview preflight отклоняет unsigned source app при requireAdHocSignature",
  { skip: process.platform !== "darwin" ? "codesign доступен только на macOS" : false },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zcode-adhoc-preflight-unsigned-"));
    try {
      const fixture = await createPreviewReleaseFixture(root);
      await assert.rejects(
        preflightMacRelease({
          ...previewPreflightOptions,
          distDir: fixture.distDir,
          requireAdHocSignature: true,
          runCommand: fixture.runCommand,
          captureCommand: fixture.captureCommand,
        }),
        /ad-hoc подписи|не прошла codesign/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
