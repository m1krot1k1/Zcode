import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOT = path.join(REPOSITORY_ROOT, "docs/vendor/prism10");
const PROFILE_COMPILER_PATH = fileURLToPath(import.meta.url);
const EXPERIMENT_GATE_PATH = path.join(REPOSITORY_ROOT, "scripts/prism10-experiment-gate.mjs");
const IDENTITY_PATH = path.join(
  REPOSITORY_ROOT,
  "apps/zcode-cli/packages/core/src/context/sections/identity.ts",
);
const ADAPTER_VERSION = "zcode-prism10-adapter-v1";

const ACTIVATION_REPLACEMENT = [
  "## 0. Активация",
  "",
  "Если сообщение содержит задачу, сразу выполняй её; не отвечай ритуалом активации. Если задачи нет, ответь коротко на языке пользователя.",
].join("\n");

const GATE_COMMAND_REPLACEMENT =
  "В ZCode доступен локальный Node gate: `node scripts/prism10-experiment-gate.mjs --input <jsonl> --objective success`. Он сравнивает только предъявленные записи и не запускает LLM.";
const GATE_AVAILABILITY_REPLACEMENT =
  "Локальный PRISM gate принимает заранее записанные пары baseline/candidate, требует одинаковые protected_holdout, environment и grader, проверяет парные результаты, safety, критические регрессии, стоимость и latency. Он не запускает LLM, не проверяет подлинность receipts, не доказывает улучшение и не разрешает выпуск; его рекомендация требует ручной независимой проверки.";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function replaceExactlyOnce(input, target, replacement, label) {
  const first = input.indexOf(target);
  if (first < 0 || input.indexOf(target, first + target.length) >= 0) {
    throw new Error(`PRISM adapter target must occur exactly once: ${label}`);
  }
  return `${input.slice(0, first)}${replacement}${input.slice(first + target.length)}`;
}

async function readSource(relativePath) {
  const absolutePath = path.resolve(SOURCE_ROOT, relativePath);
  if (!absolutePath.startsWith(`${SOURCE_ROOT}${path.sep}`)) {
    throw new Error(`PRISM source path escapes vendor directory: ${relativePath}`);
  }
  return readFile(absolutePath, "utf8");
}

async function verifySourceChecksums() {
  const lock = await readSource("checksums.sha256");
  const checked = [];
  for (const [index, line] of lock.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    const match = /^([a-f0-9]{64})\s+(.+)$/u.exec(line);
    if (!match) throw new Error(`Invalid PRISM checksum record at line ${index + 1}`);
    const [, expected, relativePath] = match;
    const actual = sha256(await readSource(relativePath));
    if (actual !== expected) throw new Error(`PRISM source checksum mismatch: ${relativePath}`);
    checked.push(relativePath);
  }
  if (checked.length === 0) throw new Error("PRISM source checksum lock is empty");
  return checked;
}

async function compileOfficialProfile(profile) {
  const manifest = JSON.parse(await readSource("manifest.json"));
  if (!Array.isArray(manifest.profiles?.[profile])) {
    throw new Error(`Unknown PRISM source profile: ${profile}`);
  }
  const core = (await readSource(manifest.core)).trimEnd();
  const modules = await Promise.all(
    manifest.profiles[profile].map(async (name) => {
      const modulePath = manifest.modules?.[name]?.path;
      if (!modulePath) throw new Error(`PRISM profile references unknown module: ${name}`);
      return (await readSource(modulePath)).trimEnd();
    }),
  );
  const header = modules.length
    ? `\n\n---\n\n## Подключённые профильные инструкции: ${profile.toUpperCase()}\n\n`
    : "";
  const compiled = `${core}${header}${modules.join("\n\n---\n\n")}\n`;
  const officialArtifact = await readSource(`generated/${profile}.md`);
  if (compiled !== officialArtifact) {
    throw new Error(`Vendored PRISM compiler output differs from generated/${profile}.md`);
  }
  return {
    compiled,
    modulePaths: manifest.profiles[profile].map((name) => manifest.modules[name].path),
  };
}

export async function buildPrismRuntimeProfile() {
  const checkedSourcePaths = await verifySourceChecksums();
  const { compiled, modulePaths } = await compileOfficialProfile("all");
  let prompt = compiled;
  const activationTarget = prompt.match(
    /## 0\. Активация\n\n[\s\S]*?(?=\n\n## 1\. Неизменяемое ядро)/u,
  )?.[0];
  if (!activationTarget) throw new Error("PRISM activation section was not found");
  prompt = replaceExactlyOnce(
    prompt,
    activationTarget,
    ACTIVATION_REPLACEMENT,
    "activation section",
  );
  prompt = replaceExactlyOnce(
    prompt,
    "Для тестового гейта: `python scripts/experiment_gate.py --input fixtures/...jsonl --objective success`.",
    GATE_COMMAND_REPLACEMENT,
    "external gate command",
  );
  prompt = replaceExactlyOnce(
    prompt,
    "Реальный набор утилит `experiment_gate.py` может проверять **предоставленные** парные результаты и выдавать техническую рекомендацию; сам он не вызывает LLM и не проверяет подлинность receipts.",
    GATE_AVAILABILITY_REPLACEMENT,
    "optional package gate availability",
  );
  prompt = prompt.trimEnd();

  const provenancePaths = [
    "checksums.sha256",
    "manifest.json",
    "PRISM_10.0_CORE_RU.md",
    "scripts/compile_prompt.py",
    "generated/all.md",
    ...modulePaths,
  ];
  const provenance = await Promise.all(
    [...new Set(provenancePaths)].sort().map(async (relativePath) => {
      const contents = await readSource(relativePath);
      return `${relativePath}\0${sha256(contents)}\n`;
    }),
  );
  provenance.push(
    `zcode/scripts/prism10-runtime-profile.mjs\0${sha256(await readFile(PROFILE_COMPILER_PATH))}\n`,
  );
  provenance.push(
    `zcode/scripts/prism10-experiment-gate.mjs\0${sha256(await readFile(EXPERIMENT_GATE_PATH))}\n`,
  );
  const sourceDigest = sha256(
    `${ADAPTER_VERSION}\n${provenance.join("")}\n${ACTIVATION_REPLACEMENT}\n${GATE_COMMAND_REPLACEMENT}\n${GATE_AVAILABILITY_REPLACEMENT}`,
  );
  const profileDigest = sha256(prompt);
  const identitySource = await readFile(IDENTITY_PATH, "utf8");
  const generatedIdentitySource = renderIdentitySource(
    identitySource,
    prompt,
    sourceDigest,
    profileDigest,
  );

  return {
    checkedSourcePaths,
    compiledProfile: compiled,
    prompt,
    sourceDigest,
    profileDigest,
    identitySource: generatedIdentitySource,
  };
}

function renderIdentitySource(identitySource, prompt, sourceDigest, profileDigest) {
  const declaration = /^const PRISM_OMEGA_SYSTEM_PROMPT = .*;$/mu;
  if (!declaration.test(identitySource))
    throw new Error("PRISM identity prompt declaration was not found");
  let output = identitySource.replace(
    declaration,
    `const PRISM_OMEGA_SYSTEM_PROMPT = ${JSON.stringify(prompt)};`,
  );

  const commentBlock = `// PRISM 10.0 all profile: generated from the vendored, checksum-verified source.\n// PRISM_SOURCE_SHA256: ${sourceDigest}\n// PRISM_PROFILE_SHA256: ${profileDigest}`;
  const lines = output.split("\n");
  const commentIndex = lines.findIndex((line) => line.startsWith("// PRISM 10.0"));
  if (commentIndex < 0) throw new Error("PRISM profile comment block was not found");
  let commentEnd = commentIndex + 1;
  if (lines[commentEnd]?.startsWith("// Ритуал проверки патчей")) commentEnd += 1;
  if (
    lines[commentEnd]?.startsWith("// PRISM_SOURCE_SHA256:") &&
    lines[commentEnd + 1]?.startsWith("// PRISM_PROFILE_SHA256:")
  ) {
    commentEnd += 2;
  }
  lines.splice(commentIndex, commentEnd - commentIndex, ...commentBlock.split("\n"));
  return lines.join("\n");
}

async function main() {
  const mode = process.argv[2] ?? "--check";
  if (mode !== "--check" && mode !== "--write") {
    throw new Error("Usage: node scripts/prism10-runtime-profile.mjs [--check|--write]");
  }
  const generated = await buildPrismRuntimeProfile();
  const current = await readFile(IDENTITY_PATH, "utf8");
  if (mode === "--write") {
    await writeFile(IDENTITY_PATH, generated.identitySource);
    process.stdout.write(
      `PRISM runtime profile written: source=${generated.sourceDigest} profile=${generated.profileDigest}\n`,
    );
    return;
  }
  if (current !== generated.identitySource) {
    throw new Error(
      `PRISM runtime profile is stale. Run: node scripts/prism10-runtime-profile.mjs --write`,
    );
  }
  process.stdout.write(
    `PRISM runtime profile current: ${generated.checkedSourcePaths.length} source checksums; source=${generated.sourceDigest}; profile=${generated.profileDigest}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
