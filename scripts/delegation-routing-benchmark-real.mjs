#!/usr/bin/env node
/**
 * Real paired benchmark harness for delegation routing.
 *
 * Unlike `delegation-routing-benchmark.mjs`, this script actually runs the built
 * ZCode CLI. It creates isolated fixture workspaces, runs baseline (root inline,
 * Task/Agent denied) and candidate (routing-gated delegation, Task allowed), verifies
 * hidden acceptance checks, and writes aggregated JSONL records plus a gate report.
 *
 * It does not fabricate records: a timeout, failed acceptance, or a routing-policy
 * violation is recorded as `success:false` / `criticalRegressions>0`.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(root, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
const gatePath = path.join(root, "scripts/delegation-routing-benchmark.mjs");
const DEFAULT_OUT = path.join(root, "docs/research/delegation-benchmark/2026-11-21");
const ARMS = ["baseline", "candidate"];
const MAX_STREAM_BYTES = 32 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function writeFixture(workspace, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(workspace, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function parseStream(stdout) {
  const result = {
    summary: null,
    taskSpawns: [],
    claimConflicts: 0,
    turnStarts: 0,
    toolScheduled: new Set(),
    modelSelection: null,
    exitError: null,
  };
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "turn.started") result.turnStarts += 1;
    if (event.type === "result") result.summary = event;
    if (
      result.modelSelection === null &&
      event.type === "session.updated" &&
      event.payload?.modelSelection
    ) {
      result.modelSelection = event.payload.modelSelection;
    }
    if (event.type === "tool.updated" && event.payload) {
      const payload = event.payload;
      if (
        (payload.toolName === "Task" || payload.toolName === "Agent") &&
        payload.kind === "scheduled" &&
        typeof payload.toolCallId === "string"
      ) {
        if (!result.toolScheduled.has(payload.toolCallId)) {
          result.toolScheduled.add(payload.toolCallId);
          result.taskSpawns.push({
            toolCallId: payload.toolCallId,
            agentType:
              typeof payload.input?.subagent_type === "string"
                ? payload.input.subagent_type
                : typeof payload.input?.agent_type === "string"
                  ? payload.input.agent_type
                  : null,
          });
        }
      }
      const serialized = JSON.stringify(payload);
      if (serialized.includes("write_claim_conflict")) result.claimConflicts += 1;
    }
  }
  return result;
}

function runProcess(command, args, options) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // process already gone
        }
      }
      settle(-1);
    }, options.timeoutMs);
    const settle = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    };
    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_STREAM_BYTES) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_STREAM_BYTES) stderr += chunk.toString();
    });
    child.on("error", (error) => {
      stderr += `\nspawn error: ${error.message}`;
      settle(-1);
    });
    child.on("close", (code) => settle(code ?? -1));
  });
}

function taskPrompt(task, arm) {
  const routeLine = `Routing decision: ${task.route} (${task.routeReason}).`;
  const acceptance = `Acceptance: ${task.acceptance}`;
  if (arm === "baseline") {
    return [
      "Work inline in the current workspace. Task and Agent are unavailable; do not try to delegate.",
      "Read the repository first, make the smallest coherent change, and verify the result yourself.",
      routeLine,
      acceptance,
      "",
      task.task,
    ].join("\n");
  }
  if (task.route === "integrate_inline") {
    return [
      "This task is serial or caller-owned integration. Do the work inline; do not call Task.",
      "Read the repository first, make the smallest coherent change, and verify the result yourself.",
      routeLine,
      acceptance,
      "",
      task.task,
    ].join("\n");
  }
  if (task.route === "orchestrate") {
    return [
      "Follow the routing gate. Do not implement both workstreams inline.",
      routeLine,
      'Call Task(with subagent_type "orchestrator") once, with a self-contained envelope that lists the independent branches, their non-overlapping file scopes, and the acceptance checks. Let the orchestrator delegate workers, then verify the integrated result.',
      task.duplicateProbe
        ? "The branches intentionally touch the same file. If the runtime rejects an overlapping write claim, serialize the branches and keep both changes; do not drop either fix."
        : "Use separate branches with disjoint write paths.",
      acceptance,
      "",
      task.task,
    ].join("\n");
  }
  return [
    "Follow the routing gate. Do not implement this task inline.",
    routeLine,
    `Call Task(with subagent_type "${task.role}") exactly once with a self-contained envelope: goal, scope, file boundaries, constraints, and acceptance checks. Then verify the child's result and report the observed evidence.`,
    acceptance,
    "",
    task.task,
  ].join("\n");
}

function policyCritical(task, arm, run) {
  const spawnCount = run.parsed.taskSpawns.length;
  if (arm === "baseline")
    return spawnCount > 0 ? ["baseline delegated despite Task/Agent being denied"] : [];
  if (task.route === "integrate_inline") {
    return spawnCount > 0 ? ["candidate delegated on an integrate_inline route"] : [];
  }
  if (spawnCount === 0) return [`candidate did not delegate on a ${task.route} route`];
  if (task.route === "orchestrate") {
    const agents = run.parsed.taskSpawns.map((spawn) => spawn.agentType);
    if (!agents.includes("orchestrator") && agents.filter(Boolean).length < 2) {
      return ["orchestrate route produced neither orchestrator nor two child branches"];
    }
  }
  return [];
}

async function runAcceptance(task, workspace, outDir) {
  const acceptPath = path.join(outDir, "accept", `${task.id}.mjs`);
  const result = await runProcess(process.execPath, [acceptPath, workspace], {
    cwd: workspace,
    timeoutMs: 30_000,
  });
  return {
    ok: result.code === 0,
    detail: `${result.stdout}${result.stderr}`.trim().slice(0, 2_000),
    durationMs: result.durationMs,
    timedOut: result.timedOut,
  };
}

async function runOne({ task, arm, repeat, outDir, timeoutMs }) {
  const runDir = path.join(outDir, "workspaces", `${task.id}-${arm}-${repeat}`);
  await rm(runDir, { recursive: true, force: true });
  await mkdir(runDir, { recursive: true });
  await writeFixture(runDir, task.files);
  const args = [
    cliPath,
    "--prompt",
    taskPrompt(task, arm),
    "--output-format",
    "stream-json",
    "--mode",
    "yolo",
    "--cwd",
    runDir,
    "--no-color",
  ];
  if (arm === "baseline") args.push("--disallowed-tools", "Task,Agent");
  const startedAt = new Date().toISOString();
  const processResult = await runProcess(process.execPath, args, {
    cwd: runDir,
    timeoutMs,
  });
  const parsed = parseStream(processResult.stdout);
  const acceptance = await runAcceptance(task, runDir, outDir);
  const policy = policyCritical(task, arm, { parsed });
  const criticalRegressions = [
    ...(processResult.code !== 0 || processResult.timedOut ? ["cli failed or timed out"] : []),
    ...(acceptance.ok ? [] : ["acceptance check failed"]),
    ...policy,
  ];
  const usage = parsed.summary?.usage ?? null;
  const tokens =
    typeof usage?.totalTokens === "number"
      ? usage.totalTokens
      : typeof parsed.summary?.projection?.totalTokenCount === "number"
        ? parsed.summary.projection.totalTokenCount
        : 0;
  const run = {
    taskId: task.id,
    family: task.family,
    arm,
    repeat,
    startedAt,
    durationMs: processResult.durationMs,
    tokens,
    success: criticalRegressions.length === 0 && acceptance.ok,
    criticalRegressions: criticalRegressions.length,
    criticalReasons: criticalRegressions,
    acceptance: acceptance.ok,
    acceptanceDetail: acceptance.detail,
    claimConflicts: parsed.claimConflicts,
    taskSpawns: parsed.taskSpawns,
    modelSelection: parsed.modelSelection,
    turnStarts: parsed.turnStarts,
    exitCode: processResult.code,
    timedOut: processResult.timedOut,
    responsePreview: String(parsed.summary?.response ?? "").slice(0, 1_000),
    stderrPreview: processResult.stderr.slice(-2_000),
  };
  await writeFile(
    path.join(outDir, "runs", `${task.id}-${arm}-${repeat}.json`),
    `${JSON.stringify(run, null, 2)}\n`,
    "utf8",
  );
  await rm(runDir, { recursive: true, force: true });
  return run;
}

function aggregate(task, arm, runs) {
  return {
    taskId: task.id,
    arm,
    success: runs.every((run) => run.success),
    durationMs: Math.round(median(runs.map((run) => run.durationMs))),
    tokens: runs.reduce((sum, run) => sum + run.tokens, 0),
    duplicateClaims: 0,
    criticalRegressions: runs.reduce((sum, run) => sum + run.criticalRegressions, 0),
    repeats: runs.length,
    synthetic: false,
    holdout: true,
    route: task.route,
    family: task.family,
    claimConflicts: runs.reduce((sum, run) => sum + run.claimConflicts, 0),
    modelSelection: runs.find((run) => run.modelSelection)?.modelSelection ?? null,
  };
}

async function writeAcceptance(task, outDir) {
  const acceptPath = path.join(outDir, "accept", `${task.id}.mjs`);
  await mkdir(path.dirname(acceptPath), { recursive: true });
  await writeFile(acceptPath, task.accept, "utf8");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(options.outDir);
  await mkdir(path.join(outDir, "runs"), { recursive: true });
  await mkdir(path.join(outDir, "accept"), { recursive: true });
  const tasks =
    options.tasks.length > 0 ? TASKS.filter((task) => options.tasks.includes(task.id)) : TASKS;
  if (tasks.length === 0) fail(`No tasks matched: ${options.tasks.join(",")}`);
  for (const task of tasks) await writeAcceptance(task, outDir);

  const meta = {
    version: 1,
    kind: "real-delegation-routing-benchmark",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    cli: "apps/zcode-cli/packages/cli/dist/zcode.cjs",
    gitHead: await gitHead(),
    repeats: options.repeats,
    timeoutMs: options.timeoutMs,
    tasks: tasks.map((task) => ({
      id: task.id,
      family: task.family,
      route: task.route,
      routeReason: task.routeReason,
      fixtureHash: sha256(JSON.stringify(task.files)),
    })),
    note: "Records are produced by executing the built ZCode CLI. Raw streams are not committed; per-run parsed evidence is in runs/.",
  };
  await writeFile(path.join(outDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");

  const records = [];
  for (const task of tasks) {
    for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
      for (const arm of ARMS) {
        process.stdout.write(`[bench] ${task.id} ${arm} repeat ${repeat}/${options.repeats}\n`);
        const run = await runOne({
          task,
          arm,
          repeat,
          outDir,
          timeoutMs: options.timeoutMs,
        });
        records.push(run);
        process.stdout.write(
          `[bench]   success=${run.success} acceptance=${run.acceptance} durationMs=${run.durationMs} tokens=${run.tokens} spawns=${run.taskSpawns.length} critical=${run.criticalRegressions}\n`,
        );
      }
    }
  }

  const baseline = [];
  const candidate = [];
  for (const task of tasks) {
    const taskRuns = records.filter((run) => run.taskId === task.id);
    baseline.push(
      aggregate(
        task,
        "baseline",
        taskRuns.filter((run) => run.arm === "baseline"),
      ),
    );
    candidate.push(
      aggregate(
        task,
        "candidate",
        taskRuns.filter((run) => run.arm === "candidate"),
      ),
    );
  }
  const baselinePath = path.join(outDir, "baseline.jsonl");
  const candidatePath = path.join(outDir, "candidate.jsonl");
  const allRunsPath = path.join(outDir, "runs.jsonl");
  await writeFile(
    baselinePath,
    `${baseline.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
  await writeFile(
    candidatePath,
    `${candidate.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
  await writeFile(
    allRunsPath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );

  const gate = await runProcess(
    process.execPath,
    [gatePath, "--baseline", baselinePath, "--candidate", candidatePath],
    {
      cwd: root,
      timeoutMs: 60_000,
    },
  );
  const reportText = `${gate.stdout}${gate.stderr}`.trim();
  await writeFile(path.join(outDir, "report.json"), `${gate.stdout}`, "utf8");
  await writeFile(path.join(outDir, "report.txt"), `${reportText}\n`, "utf8");
  process.stdout.write(`${reportText}\n`);

  meta.finishedAt = new Date().toISOString();
  meta.modelSelection = records.find((run) => run.modelSelection)?.modelSelection ?? null;
  await writeFile(path.join(outDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  if (gate.code !== 0 && !reportText.includes('"verdict": "reject"')) {
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const options = {
    tasks: [],
    repeats: 3,
    timeoutMs: 360_000,
    outDir: DEFAULT_OUT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--tasks") {
      options.tasks = String(argv[++index] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      continue;
    }
    if (arg === "--repeats") {
      options.repeats = Number(argv[++index]);
      if (!Number.isInteger(options.repeats) || options.repeats < 1) fail("--repeats must be >= 1");
      continue;
    }
    if (arg === "--timeout-ms") {
      options.timeoutMs = Number(argv[++index]);
      if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 10_000) {
        fail("--timeout-ms must be >= 10000");
      }
      continue;
    }
    if (arg === "--out") {
      options.outDir = String(argv[++index] ?? "");
      if (!options.outDir) fail("--out requires a path");
      continue;
    }
    fail(`unknown argument: ${arg}`);
  }
  return options;
}

async function gitHead() {
  const result = await runProcess("git", ["rev-parse", "HEAD"], { cwd: root, timeoutMs: 10_000 });
  return result.stdout.trim();
}

const TASKS = [
  {
    id: "holdout-single-file-bugfix",
    family: "single-file-bugfix",
    route: "delegate_single",
    routeReason: "one bounded fix in one file",
    role: "implementer",
    task: "Fix src/slugify.mjs. It must lowercase the input, replace every run of non-alphanumeric characters with one hyphen, and trim leading/trailing hyphens. Only edit src/slugify.mjs.",
    acceptance:
      "slugify('Hello, World!') === 'hello-world'; slugify('  A  B  ') === 'a-b'; slugify('C++ & Rust') === 'c-rust'; only src/slugify.mjs changed.",
    files: {
      "src/slugify.mjs":
        'export function slugify(input) {\n  return String(input).toLowerCase().replace(/\\s+/g, "-");\n}\n',
      "package.json": '{"name":"bench-slug","version":"1.0.0","type":"module"}\n',
    },
    accept: `import { readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const workspace = process.argv[2];
const { slugify } = await import(pathToFileURL(join(workspace, "src/slugify.mjs")).href);
const cases = [
  ["Hello, World!", "hello-world"],
  ["  A  B  ", "a-b"],
  ["C++ & Rust", "c-rust"],
  ["Hello---World", "hello-world"],
];
for (const [input, expected] of cases) {
  const actual = slugify(input);
  if (actual !== expected) {
    console.error(JSON.stringify({ input, expected, actual }));
    process.exit(1);
  }
}
const entries = await readdir(join(workspace, "src"));
if (entries.some((entry) => entry !== "slugify.mjs")) {
  console.error("unexpected files in src: " + entries.join(","));
  process.exit(1);
}
console.log("slugify acceptance ok");
`,
  },
  {
    id: "holdout-multi-file-refactor",
    family: "multi-file-refactor",
    route: "delegate_single",
    routeReason: "one coherent refactor with a shared module",
    role: "implementer",
    task: "Remove the duplicated clamp helper. Create src/clamp.mjs exporting clamp(n, min, max), then update src/a.mjs and src/b.mjs to import it. Do not change behavior.",
    acceptance:
      "src/clamp.mjs exports clamp; src/a.mjs and src/b.mjs import from ./clamp.mjs and no longer declare a local clamp; percent(120)='100%', percent(-5)='0%', volume(12)=11, volume(-1)=0.",
    files: {
      "src/a.mjs":
        "export function clamp(n, min, max) {\n  return Math.min(max, Math.max(min, n));\n}\nexport function percent(n) {\n  return `${clamp(n, 0, 100)}%`;\n}\n",
      "src/b.mjs":
        "function clamp(n, min, max) {\n  return Math.min(max, Math.max(min, n));\n}\nexport function volume(n) {\n  return clamp(n, 0, 11);\n}\n",
      "package.json": '{"name":"bench-clamp","version":"1.0.0","type":"module"}\n',
    },
    accept: `import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const workspace = process.argv[2];
const a = await import(pathToFileURL(join(workspace, "src/a.mjs")).href);
const b = await import(pathToFileURL(join(workspace, "src/b.mjs")).href);
const clampSource = await readFile(join(workspace, "src/clamp.mjs"), "utf8");
const aSource = await readFile(join(workspace, "src/a.mjs"), "utf8");
const bSource = await readFile(join(workspace, "src/b.mjs"), "utf8");
if (!/export function clamp|export const clamp/.test(clampSource)) {
  console.error("clamp module does not export clamp");
  process.exit(1);
}
if (!/from\\s+["']\\.\\/clamp\\.mjs["']/.test(aSource) || !/from\\s+["']\\.\\/clamp\\.mjs["']/.test(bSource)) {
  console.error("a/b do not import ./clamp.mjs");
  process.exit(1);
}
if (/function clamp|const clamp/.test(aSource.replace(/import[^;]+;/g, "")) || /function clamp|const clamp/.test(bSource.replace(/import[^;]+;/g, ""))) {
  console.error("a/b still declare a local clamp");
  process.exit(1);
}
if (a.percent(120) !== "100%" || a.percent(-5) !== "0%" || b.volume(12) !== 11 || b.volume(-1) !== 0) {
  console.error("behavior changed");
  process.exit(1);
}
console.log("clamp refactor acceptance ok");
`,
  },
  {
    id: "holdout-independent-research-implementation",
    family: "independent-research-implementation",
    route: "orchestrate",
    routeReason: "two independent workstreams: docs and code",
    role: "orchestrator",
    task: "Two independent workstreams. (1) Create docs/api.md documenting add(a,b) and subtract(a,b) with signatures and one example each. (2) Add multiply(a,b) and divide(a,b) to src/calculator.mjs; divide must throw RangeError on zero. Do not change add or subtract.",
    acceptance:
      "docs/api.md documents add and subtract; calculator exports multiply and divide; multiply(6,7)=42; divide(8,2)=4; divide(1,0) throws RangeError.",
    files: {
      "src/calculator.mjs":
        "export function add(a, b) {\n  return a + b;\n}\nexport function subtract(a, b) {\n  return a - b;\n}\n",
      "package.json": '{"name":"bench-calc","version":"1.0.0","type":"module"}\n',
    },
    accept: `import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const workspace = process.argv[2];
const docs = await readFile(join(workspace, "docs/api.md"), "utf8");
if (!/add\\s*\\(/i.test(docs) || !/subtract\\s*\\(/i.test(docs) || !/\\x60\\x60\\x60|\\x60[^\\x60]+\\x60/.test(docs)) {
  console.error("docs/api.md is missing signatures or examples");
  process.exit(1);
}
const calc = await import(pathToFileURL(join(workspace, "src/calculator.mjs")).href);
if (calc.multiply(6, 7) !== 42 || calc.divide(8, 2) !== 4) {
  console.error("multiply/divide are wrong");
  process.exit(1);
}
let threw = false;
try { calc.divide(1, 0); } catch (error) { threw = error instanceof RangeError; }
if (!threw) {
  console.error("divide(1,0) did not throw RangeError");
  process.exit(1);
}
console.log("calculator + docs acceptance ok");
`,
  },
  {
    id: "holdout-serial-migration",
    family: "serial-migration",
    route: "integrate_inline",
    routeReason: "each step depends on the previous config",
    role: "implementer",
    task: 'Migrate config.v1.json to config.v2.json serially: read v1, write v2, verify v2. Keep config.v1.json unchanged. v2 must be {"version":2,"server":{"host":"localhost","port":8080},"logging":{"level":"debug"}}. Write migration.log with exactly the lines: read v1, write v2, verify v2.',
    acceptance:
      "config.v2.json deep-equals the target; config.v1.json is unchanged; migration.log has exactly read v1 / write v2 / verify v2.",
    files: {
      "config.v1.json": '{"version":1,"host":"localhost","port":8080,"debug":true}\n',
      "package.json": '{"name":"bench-migration","version":"1.0.0","type":"module"}\n',
    },
    accept: `import { readFile } from "node:fs/promises";
import { join } from "node:path";
const workspace = process.argv[2];
const v1 = JSON.parse(await readFile(join(workspace, "config.v1.json"), "utf8"));
const v2 = JSON.parse(await readFile(join(workspace, "config.v2.json"), "utf8"));
const expected = { version: 2, server: { host: "localhost", port: 8080 }, logging: { level: "debug" } };
if (JSON.stringify(v1) !== JSON.stringify({ version: 1, host: "localhost", port: 8080, debug: true })) {
  console.error("config.v1.json changed");
  process.exit(1);
}
if (JSON.stringify(v2) !== JSON.stringify(expected)) {
  console.error("config.v2.json mismatch: " + JSON.stringify(v2));
  process.exit(1);
}
const log = (await readFile(join(workspace, "migration.log"), "utf8")).trim().split(/\\r?\\n/);
if (JSON.stringify(log) !== JSON.stringify(["read v1", "write v2", "verify v2"])) {
  console.error("migration.log mismatch: " + JSON.stringify(log));
  process.exit(1);
}
console.log("migration acceptance ok");
`,
  },
  {
    id: "holdout-release-pipeline",
    family: "release-pipeline",
    route: "integrate_inline",
    routeReason: "version, changelog, build and verification are serial",
    role: "infra-coder",
    task: "Release version 1.1.0. Bump package.json version to 1.1.0, add a CHANGELOG.md section '## 1.1.0', run the existing build, and ensure dist/app.txt contains v1.1.0. Do not change build.mjs.",
    acceptance:
      "package.json version is 1.1.0; CHANGELOG.md has ## 1.1.0; dist/app.txt contains v1.1.0; build.mjs is unchanged.",
    files: {
      "package.json":
        '{"name":"bench-release","version":"1.0.0","type":"module","scripts":{"build":"node build.mjs"}}\n',
      "build.mjs":
        'import { mkdir, readFile, writeFile } from "node:fs/promises";\nconst pkg = JSON.parse(await readFile("package.json", "utf8"));\nawait mkdir("dist", { recursive: true });\nawait writeFile("dist/app.txt", `v${pkg.version}\\n`);\n',
      "CHANGELOG.md": "# Changelog\n\n## 1.0.0\n\n- Initial release.\n",
    },
    accept: `import { readFile } from "node:fs/promises";
import { join } from "node:path";
const workspace = process.argv[2];
const pkg = JSON.parse(await readFile(join(workspace, "package.json"), "utf8"));
const changelog = await readFile(join(workspace, "CHANGELOG.md"), "utf8");
const dist = (await readFile(join(workspace, "dist/app.txt"), "utf8")).trim();
const build = await readFile(join(workspace, "build.mjs"), "utf8");
if (pkg.version !== "1.1.0") { console.error("version mismatch"); process.exit(1); }
if (!/^## 1\\.1\\.0/m.test(changelog)) { console.error("changelog missing 1.1.0"); process.exit(1); }
if (!dist.includes("v1.1.0")) { console.error("dist mismatch: " + dist); process.exit(1); }
if (!build.includes("pkg.version") || build.includes("1.1.0")) { console.error("build.mjs changed"); process.exit(1); }
console.log("release acceptance ok");
`,
  },
  {
    id: "holdout-duplicate-work-probe",
    family: "duplicate-work-probe",
    route: "orchestrate",
    routeReason: "two independent fixes that share one file",
    role: "orchestrator",
    duplicateProbe: true,
    task: "Fix both functions in src/shared.mjs. formatName('  ada lovelace ') must return 'Ada Lovelace'. formatDate(new Date('2026-11-21T00:00:00Z')) must return '2026-11-21'. Keep exactly one formatName and one formatDate definition.",
    acceptance:
      "formatName title-cases each word and trims; formatDate returns YYYY-MM-DD; src/shared.mjs has exactly one definition of each function.",
    files: {
      "src/shared.mjs":
        "export function formatName(name) {\n  return name.trim();\n}\nexport function formatDate(value) {\n  return String(value);\n}\n",
      "package.json": '{"name":"bench-duplicate","version":"1.0.0","type":"module"}\n',
    },
    accept: `import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const workspace = process.argv[2];
const source = await readFile(join(workspace, "src/shared.mjs"), "utf8");
if ((source.match(/function formatName/g) ?? []).length !== 1 || (source.match(/function formatDate/g) ?? []).length !== 1) {
  console.error("duplicate function definitions");
  process.exit(1);
}
const shared = await import(pathToFileURL(join(workspace, "src/shared.mjs")).href);
if (shared.formatName("  ada lovelace ") !== "Ada Lovelace") {
  console.error("formatName mismatch: " + shared.formatName("  ada lovelace "));
  process.exit(1);
}
if (shared.formatDate(new Date("2026-11-21T00:00:00Z")) !== "2026-11-21") {
  console.error("formatDate mismatch");
  process.exit(1);
}
console.log("duplicate probe acceptance ok");
`,
  },
];

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
