#!/usr/bin/env node
/**
 * Детерминированный replay ранее падавшей траектории
 * `session_dee7732e677519c63e3dd10d5eeeaaff`.
 *
 * Каждый кейс — отдельный прогон настоящего runtime со скриптованным
 * провайдером. Набор пригоден для CI: без сети, без ключей, без дисплея.
 *
 * Использование:
 *   node apps/zcode-cli/e2e/session-forensic-replay/run.mjs
 *   node .../run.mjs --case=truncated-tool-args,pty-session
 *   node .../run.mjs --artifacts-dir=/tmp/replay --keep-tmp
 */
import { mkdir, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scriptDir, writeJson } from "./support.mjs";
import { bashSandboxCase } from "./case-bash-sandbox.mjs";
import { enhanceCommandCase } from "./case-enhance.mjs";
import { promptCacheApplyPatchCase } from "./case-prompt-cache-apply-patch.mjs";
import { codeIndexCase } from "./case-code-index.mjs";
import { autoRepairLoopCase } from "./case-auto-repair-loop.mjs";
import { multiEditTransactionCase } from "./case-multiedit-transaction.mjs";
import { ptySessionCase } from "./case-pty-session.mjs";
import { swarmFileLocksCase } from "./case-swarm-file-locks.mjs";
import { truncatedToolArgsCase } from "./case-truncated-tool-args.mjs";

const ALL_CASES = [
  truncatedToolArgsCase,
  enhanceCommandCase,
  promptCacheApplyPatchCase,
  codeIndexCase,
  autoRepairLoopCase,
  multiEditTransactionCase,
  ptySessionCase,
  bashSandboxCase,
  swarmFileLocksCase,
];

function parseArgs(argv) {
  const options = { artifactsDir: undefined, cases: undefined, keepTmp: false };
  for (const arg of argv) {
    if (arg === "--keep-tmp") {
      options.keepTmp = true;
      continue;
    }
    if (arg.startsWith("--artifacts-dir=")) {
      options.artifactsDir = arg.slice("--artifacts-dir=".length).trim();
      continue;
    }
    if (arg.startsWith("--case=")) {
      options.cases = arg
        .slice("--case=".length)
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
      continue;
    }
    throw new Error(`Неизвестный аргумент: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const selected = options.cases
    ? options.cases.map((name) => {
        const found = ALL_CASES.find((caseDef) => caseDef.name === name);
        if (!found) {
          throw new Error(
            `Неизвестный кейс: ${name}. Доступны: ${ALL_CASES.map((item) => item.name).join(", ")}`,
          );
        }
        return found;
      })
    : ALL_CASES;

  const root = options.artifactsDir
    ? resolve(options.artifactsDir)
    : await mkdtemp(join(tmpdir(), "zcode-forensic-artifacts-"));
  await mkdir(root, { recursive: true });

  const results = [];
  for (const caseDef of selected) {
    const startedAt = Date.now();
    try {
      const payload = await caseDef.run({ artifactsRoot: root });
      results.push({ ...payload, durationMs: Date.now() - startedAt, status: "passed" });
      console.log(JSON.stringify({ case: caseDef.name, status: "passed" }));
    } catch (error) {
      const failure = {
        case: caseDef.name,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? `${error.message}` : String(error),
        status: "failed",
      };
      results.push(failure);
      console.error(JSON.stringify(failure, null, 2));
    }
  }

  const failed = results.filter((result) => result.status !== "passed");
  const summary = {
    artifactsRoot: root,
    caseCount: results.length,
    cases: results.map((result) => ({
      assertions: result.assertions,
      case: result.case,
      durationMs: result.durationMs,
      status: result.status,
    })),
    failedCaseCount: failed.length,
    generatedAt: new Date().toISOString(),
    status: failed.length === 0 ? "passed" : "failed",
    suite: "session-forensic-replay",
  };
  await writeJson(join(root, "result.json"), summary);
  console.log(JSON.stringify(summary, null, 2));

  if (!options.keepTmp && !options.artifactsDir) {
    await rm(root, { force: true, recursive: true });
  } else {
    console.error(`Артефакты сохранены: ${root}`);
  }
  if (failed.length > 0) process.exitCode = 1;
  void scriptDir;
}

await main();
