/**
 * Ad-hoc подпись unsigned macOS Preview.
 *
 * electron-builder сам не подписывает bundle, когда `mac.identity` равен `null`
 * (текущая Preview-конфигурация без Developer ID). DMG/ZIP собираются из готового
 * `.app` в `packageInDistributableFormat`, поэтому подпись ставится в `afterPack`:
 * после всех правок bundle (app.asar, sourcemaps, runtime modules) и строго до
 * упаковки DMG/ZIP.
 *
 * Production Developer ID не затрагивается: при включённой подписи, `forceCodeSigning`
 * или наличии signing-credentials модуль ничего не делает и пишет причину в лог.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { runCommand } from "../../../scripts/spawn-command.mjs";

// Переменные, означающие настроенную Developer ID подпись или сертификат.
// CSC_IDENTITY_AUTO_DISCOVERY сюда не входит: Preview выставляет его в "false",
// это переключатель автопоиска, а не credential.
const MAC_SIGNING_CREDENTIAL_ENV_NAMES = [
  "APPLE_SIGNING_IDENTITY",
  "CSC_NAME",
  "CSC_LINK",
  "CSC_KEYCHAIN",
];

function hasNonEmptyValue(env, name) {
  return typeof env[name] === "string" && env[name].trim().length > 0;
}

/**
 * Единое явное решение для afterPack hook.
 * ad-hoc включается только для unsigned Preview на macOS; причина возвращается
 * для логирования и для отладки конфигурации.
 */
export function resolveMacAdHocSigningDecision({
  electronPlatformName,
  productFlavor,
  signingEnabled,
  forceCodeSigning = false,
  env = process.env,
}) {
  if (electronPlatformName !== "darwin") {
    return { enabled: false, reason: "not-macos" };
  }
  if (productFlavor !== "preview") {
    return { enabled: false, reason: "not-preview" };
  }
  if (signingEnabled || forceCodeSigning) {
    return { enabled: false, reason: "developer-id-signing-enabled" };
  }
  const credentialName = MAC_SIGNING_CREDENTIAL_ENV_NAMES.find((name) =>
    hasNonEmptyValue(env, name),
  );
  if (credentialName) {
    return { enabled: false, reason: `signing-credentials-present:${credentialName}` };
  }
  return { enabled: true, reason: "unsigned-preview" };
}

export function buildMacAdHocCodesignArgs(appPath) {
  return ["--force", "--deep", "--sign", "-", appPath];
}

export function resolveMacAdHocAppBundlePath({ appOutDir, productFilename }) {
  if (!productFilename) {
    throw new Error("Ad-hoc подпись macOS Preview: electron-builder не передал productFilename");
  }
  return resolve(appOutDir, `${productFilename}.app`);
}

function runCodeSignCapture(args) {
  const result = spawnSync("codesign", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

const MAC_APP_BUNDLE_SUFFIX = ".app";

function pathDepth(filePath) {
  return filePath.split(sep).length;
}

/**
 * Путь должен лежать строго внутри real root после разрешения всех symlink'ов.
 * Проверка по realpath, а не по лексическому пути: иначе `Contents -> /tmp/Outside`
 * выводит обход за пределы целевого `.app` и подписывает чужой bundle.
 */
function assertRealPathWithinAppRoot(realAppRoot, candidateRealPath, label) {
  const relativePath = relative(realAppRoot, candidateRealPath);
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(
      `Ad-hoc подпись macOS Preview: ${label} находится вне app bundle: ${candidateRealPath} (корень: ${realAppRoot})`,
    );
  }
}

function realpathOrThrow(filePath, label) {
  try {
    return realpathSync(filePath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Ad-hoc подпись macOS Preview: не удалось разрешить ${label}: ${filePath} (${reason})`,
    );
  }
}

function readdirOrThrow(dirPath) {
  try {
    return readdirSync(dirPath, { withFileTypes: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Ad-hoc подпись macOS Preview: не удалось прочитать каталог: ${dirPath} (${reason})`,
    );
  }
}

/**
 * Все вложенные `.app` внутри `Contents/` корневого bundle.
 *
 * `codesign --deep` не запечатывает `.app`, лежащие в `Contents/Resources`:
 * на macOS корневой `codesign --verify --deep --strict` возвращает 0, а вложенный
 * bundle остаётся "not signed at all". Поэтому такие bundle нужно находить и
 * подписывать явно, а затем проверять отдельно.
 *
 * Symlink'и не обходятся: Electron framework содержит ссылки `Versions/Current`,
 * `Resources` и циклические ссылки, а реальные каталоги всегда доступны напрямую.
 * Глубокие bundle возвращаются первыми: подпись внутреннего меняет содержимое
 * внешнего, поэтому внешний подписывается последним.
 *
 * Fail-closed: нечитаемый каталог или неразрешимый путь бросает ошибку с путём.
 * Молчаливый пропуск подкаталога позволил бы assert'у подтвердить успех, не увидев
 * вложенный `.app` — то есть обойти release gate.
 *
 * Containment: `Contents` и каждый пройденный real-каталог должны лежать строго
 * внутри realpath корневого `.app`; symlink `Contents` наружу или выход за корень
 * бросает ошибку, чтобы подпись не ставилась на bundle вне цели.
 */
export function findNestedMacAppBundles(appPath) {
  const contentsPath = resolve(appPath, "Contents");
  try {
    // lstat, а не existsSync: сломанный symlink `Contents` не должен выглядеть
    // как отсутствующий каталог и молча завершать обход успехом.
    lstatSync(contentsPath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return [];
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Ad-hoc подпись macOS Preview: не удалось прочитать Contents: ${contentsPath} (${reason})`,
    );
  }
  const realAppRoot = realpathOrThrow(appPath, "app bundle");
  const realContentsPath = realpathOrThrow(contentsPath, "Contents");
  assertRealPathWithinAppRoot(realAppRoot, realContentsPath, "Contents");
  const nested = [];
  const visited = new Set([realContentsPath]);
  const pending = [contentsPath];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirOrThrow(current)) {
      // Dirent для symlink не считается каталогом, но проверяем явно, чтобы
      // намеренно не следовать по ссылкам вроде Frameworks/Electron Framework.framework/Versions/Current.
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const entryPath = resolve(current, entry.name);
      const realEntryPath = realpathOrThrow(entryPath, "вложенный каталог");
      assertRealPathWithinAppRoot(realAppRoot, realEntryPath, `вложенный каталог ${entryPath}`);
      if (entry.name.endsWith(MAC_APP_BUNDLE_SUFFIX)) nested.push(entryPath);
      if (visited.has(realEntryPath)) continue;
      visited.add(realEntryPath);
      pending.push(entryPath);
    }
  }
  return nested.sort(
    (left, right) => pathDepth(right) - pathDepth(left) || left.localeCompare(right),
  );
}

function hasValidNestedMacAdHocSignatures(appPath) {
  return findNestedMacAppBundles(appPath).every(
    (nestedAppPath) => runCodeSignCapture(["--verify", "--strict", nestedAppPath]).status === 0,
  );
}

/**
 * Проверка подписи вложенных `.app` через `codesign --verify --strict`.
 * `--deep` у корня не доказывает их подпись, поэтому без этой проверки
 * неподписанный helper bundle внутри Preview прошёл бы release gate.
 */
export function assertMacAdHocNestedSignatures(appPath) {
  for (const nestedAppPath of findNestedMacAppBundles(appPath)) {
    const verify = runCodeSignCapture(["--verify", "--strict", nestedAppPath]);
    if (verify.status !== 0) {
      throw new Error(
        `Ad-hoc подпись macOS Preview: вложенный app bundle не подписан или подпись недействительна: ${nestedAppPath} (${verify.output || "без вывода"})`,
      );
    }
  }
  return appPath;
}

/**
 * Проверка именно bundle-подписи по выводу `codesign -dv`.
 * `Signature=adhoc` у linker-signed executable тоже есть, поэтому без
 * `Sealed Resources version=` bundle считать подписанным нельзя.
 */
export function hasSealedAdHocSignature(codesignDetailsOutput) {
  return (
    /(?:^|\n)Signature=adhoc(?:\r?\n|$)/u.test(codesignDetailsOutput) &&
    /(?:^|\n)Sealed Resources version=/u.test(codesignDetailsOutput)
  );
}

/**
 * `codesign -dv` печатает диагностику в stderr, поэтому stdout/stderr склеиваются.
 * Проверка фиксирует именно ad-hoc подпись, а не любую подпись.
 */
export function assertMacAdHocSignature(appPath) {
  if (!existsSync(appPath)) {
    throw new Error(`Ad-hoc подпись macOS Preview: app bundle не найден: ${appPath}`);
  }
  const verify = runCodeSignCapture(["--verify", "--deep", "--strict", appPath]);
  if (verify.status !== 0) {
    throw new Error(
      `Ad-hoc подпись macOS Preview не прошла codesign --verify: ${verify.output || "без вывода"}`,
    );
  }
  const details = runCodeSignCapture(["-dv", "--verbose=2", appPath]);
  if (details.status !== 0) {
    throw new Error(
      `Не удалось прочитать подпись macOS Preview: ${details.output || "без вывода"}`,
    );
  }
  if (!hasSealedAdHocSignature(details.output)) {
    throw new Error(
      `macOS Preview app не имеет полноценной ad-hoc подписи bundle (${details.output || "без вывода"})`,
    );
  }
  // Корневой `--deep --verify` не проверяет `.app` внутри `Contents/Resources`,
  // поэтому подпись вложенных bundle подтверждается отдельно.
  assertMacAdHocNestedSignatures(appPath);
  return appPath;
}

/**
 * Идемпотентность шага подписи: послеPack может выполняться повторно (resume,
 * universal-сборка вызывает hook для каждой архитектуры и для объединённого bundle).
 * Достаточно только полноценной bundle-подписи: у штатного Electron executable есть
 * linker-signed ad-hoc флаг, но `Sealed Resources=none`, то есть ресурсы bundle не запечатаны.
 * Такой app нельзя считать подписанным и нужно пересобрать подпись.
 */
export function isMacAdHocSigned(appPath) {
  if (!existsSync(appPath)) return false;
  const verify = runCodeSignCapture(["--verify", "--deep", "--strict", appPath]);
  if (verify.status !== 0) return false;
  const details = runCodeSignCapture(["-dv", "--verbose=2", appPath]);
  if (details.status !== 0) return false;
  if (!hasSealedAdHocSignature(details.output)) return false;
  // Иначе bundle с запечатанным корнем и неподписанным вложенным `.app` был бы
  // признан готовым, а release gate отверг бы его без попытки исправления.
  return hasValidNestedMacAdHocSignatures(appPath);
}

export function applyMacAdHocSignature(appPath) {
  if (!existsSync(appPath)) {
    throw new Error(`Ad-hoc подпись macOS Preview: app bundle не найден: ${appPath}`);
  }
  if (isMacAdHocSigned(appPath)) {
    console.log(
      `[macos-adhoc-signing] bundle уже подписан ad-hoc, повторная подпись не нужна: ${appPath}`,
    );
    return assertMacAdHocSignature(appPath);
  }
  // `--deep` не подписывает `.app` внутри `Contents/Resources`, поэтому вложенные
  // bundle подписываются явно до корня: подпись внутреннего меняет содержимое внешнего.
  for (const nestedAppPath of findNestedMacAppBundles(appPath)) {
    runCommand("codesign", buildMacAdHocCodesignArgs(nestedAppPath));
  }
  runCommand("codesign", buildMacAdHocCodesignArgs(appPath));
  return assertMacAdHocSignature(appPath);
}
