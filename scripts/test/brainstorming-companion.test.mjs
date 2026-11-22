import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = fileURLToPath(
  new URL(
    "../../apps/zcode-cli/packages/superpowers-plugin/skills/brainstorming/scripts/",
    import.meta.url,
  ),
);
const RESOLVER = path.join(SCRIPT_DIRECTORY, "resolve-system-temp-dir.sh");
const START = path.join(SCRIPT_DIRECTORY, "start-server.sh");
const STOP = path.join(SCRIPT_DIRECTORY, "stop-server.sh");
const SERVER = path.join(SCRIPT_DIRECTORY, "server.cjs");

function runBash(script, args = [], env = process.env) {
  return spawnSync("bash", [script, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env,
  });
}

async function createCommandMocks(t, { nodeTemp, convertedTemp } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zcode-brainstorm-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const nodePath = path.join(directory, "node");
  await writeFile(nodePath, '#!/bin/sh\nprintf "%s" "$TEST_NODE_TMP"\n');
  await chmod(nodePath, 0o755);
  const env = {
    ...process.env,
    PATH: `${directory}${path.delimiter}${process.env.PATH ?? ""}`,
    TEST_NODE_TMP: nodeTemp ?? os.tmpdir(),
  };
  if (convertedTemp !== undefined) {
    const cygpathPath = path.join(directory, "cygpath");
    await writeFile(cygpathPath, '#!/bin/sh\nprintf "%s" "$TEST_CONVERTED_TMP"\n');
    await chmod(cygpathPath, 0o755);
    env.TEST_CONVERTED_TMP = convertedTemp;
  }
  return env;
}

test("OS temp resolver uses Node's temp path and converts native Windows paths for Git Bash", async (t) => {
  const nativeTemp = os.tmpdir();
  const canonicalTemp = await realpath(nativeTemp);
  const posixEnvironment = await createCommandMocks(t, { nodeTemp: nativeTemp });
  const posix = runBash(RESOLVER, [], posixEnvironment);
  assert.equal(posix.status, 0, posix.stderr);
  assert.equal(posix.stdout.trim(), canonicalTemp);

  const windowsEnvironment = await createCommandMocks(t, {
    nodeTemp: "C:\\Users\\test\\AppData\\Local\\Temp",
    convertedTemp: nativeTemp,
  });
  const windows = runBash(RESOLVER, [], windowsEnvironment);
  assert.equal(windows.status, 0, windows.stderr);
  assert.equal(windows.stdout.trim(), canonicalTemp);
});

test("OS temp resolver fails closed when Windows conversion is unavailable", async (t) => {
  const env = await createCommandMocks(t, {
    nodeTemp: "C:\\Users\\test\\AppData\\Local\\Temp",
  });
  const result = runBash(RESOLVER, [], env);
  assert.notEqual(result.status, 0);
});

test("direct server fallback uses the platform temp directory", async () => {
  const source = await readFile(SERVER, "utf8");
  assert.match(source, /require\(['"]os['"]\)/u);
  assert.match(source, /path\.join\(os\.tmpdir\(\),\s*['"]brainstorm['"]\)/u);
  assert.doesNotMatch(source, /['"]\/tmp\//u);
});

test("stop removes only marked ephemeral sessions under the OS temp root", async (t) => {
  const ephemeral = await mkdtemp(path.join(os.tmpdir(), "brainstorm-test-"));
  const ephemeralState = path.join(ephemeral, "state");
  await mkdir(ephemeralState);
  await writeFile(path.join(ephemeral, ".brainstorm-ephemeral"), "");
  await writeFile(path.join(ephemeralState, "server.pid"), "2147483647\n");
  const stopped = runBash(STOP, [ephemeral]);
  assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
  await assert.rejects(() => stat(ephemeral));

  const unmarked = await mkdtemp(path.join(os.tmpdir(), "brainstorm-unmarked-"));
  t.after(() => rm(unmarked, { recursive: true, force: true }));
  const unmarkedState = path.join(unmarked, "state");
  await mkdir(unmarkedState);
  await writeFile(path.join(unmarkedState, "server.pid"), "2147483647\n");
  const unmarkedResult = runBash(STOP, [unmarked]);
  assert.equal(unmarkedResult.status, 0, unmarkedResult.stderr || unmarkedResult.stdout);
  assert.equal((await stat(unmarkedState)).isDirectory(), true);

  const project = await mkdtemp(path.join(os.tmpdir(), "zcode-brainstorm-project-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const projectSession = path.join(project, ".superpowers", "brainstorm", "session");
  const projectState = path.join(projectSession, "state");
  await mkdir(projectState, { recursive: true });
  await writeFile(path.join(projectState, "server.pid"), "2147483647\n");
  const projectResult = runBash(STOP, [projectSession]);
  assert.equal(projectResult.status, 0, projectResult.stderr || projectResult.stdout);
  assert.equal((await stat(projectState)).isDirectory(), true);

  const linkedMarker = await mkdtemp(path.join(os.tmpdir(), "brainstorm-linked-marker-"));
  t.after(() => rm(linkedMarker, { recursive: true, force: true }));
  const linkedState = path.join(linkedMarker, "state");
  await mkdir(linkedState);
  await symlink(
    path.join(os.tmpdir(), "nonexistent-brainstorm-marker-target"),
    path.join(linkedMarker, ".brainstorm-ephemeral"),
  );
  await writeFile(path.join(linkedState, "server.pid"), "2147483647\n");
  const linkedResult = runBash(STOP, [linkedMarker]);
  assert.equal(linkedResult.status, 0, linkedResult.stderr || linkedResult.stdout);
  assert.equal((await stat(linkedState)).isDirectory(), true);
});

test("launcher creates its session under the OS temp root and stop cleans it", async (t) => {
  const commandDirectory = await mkdtemp(path.join(os.tmpdir(), "zcode-brainstorm-launcher-test-"));
  t.after(() => rm(commandDirectory, { recursive: true, force: true }));
  const recordedDirectory = path.join(commandDirectory, "session-path.txt");
  const nodePath = path.join(commandDirectory, "node");
  await writeFile(
    nodePath,
    '#!/bin/sh\nif [ "$1" = "-e" ]; then printf "%s" "$TEST_NODE_TMP"; else printf "%s" "$BRAINSTORM_DIR" > "$TEST_SESSION_PATH_FILE"; printf "server-started\\n"; fi\n',
  );
  await chmod(nodePath, 0o755);
  const result = runBash(START, ["--foreground"], {
    ...process.env,
    PATH: `${commandDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
    TEST_NODE_TMP: os.tmpdir(),
    TEST_SESSION_PATH_FILE: recordedDirectory,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const sessionDirectory = (await readFile(recordedDirectory, "utf8")).trim();
  const tempRoot = await realpath(os.tmpdir());
  const actualSessionDirectory = await realpath(sessionDirectory);
  assert.equal(path.dirname(actualSessionDirectory), tempRoot);
  assert.match(path.basename(actualSessionDirectory), /^brainstorm-/u);
  await stat(path.join(actualSessionDirectory, ".brainstorm-ephemeral"));

  const stopped = runBash(STOP, [sessionDirectory]);
  assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
  await assert.rejects(() => stat(actualSessionDirectory));
});

test("launcher no longer encodes a platform-specific temporary directory", async () => {
  const source = await readFile(START, "utf8");
  assert.match(source, /resolve_system_temp_dir/u);
  assert.match(source, /mktemp -d/u);
  assert.match(source, /\.brainstorm-ephemeral/u);
  assert.doesNotMatch(source, /SESSION_DIR="\/tmp\//u);
});
