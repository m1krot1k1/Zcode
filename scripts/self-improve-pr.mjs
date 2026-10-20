#!/usr/bin/env node
/**
 * Открывает ветку и pull request для самоулучшения.
 * Токен не печатается. Слияние и push в main не выполняются.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function readTokenFromEnv(env) {
  return (env.GITHUB_TOKEN || env.GH_TOKEN || "").trim();
}

export function readTokenFromEnvFile(text) {
  for (const line of text.split(/\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?GITHUB_TOKEN\s*=\s*(.*)$/u.exec(trimmed);
    if (!match) continue;
    let value = match[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value.trim();
  }
  return "";
}

export function resolveGithubToken({ env, envFileText }) {
  const fromEnv = readTokenFromEnv(env);
  if (fromEnv) return fromEnv;
  if (typeof envFileText === "string") return readTokenFromEnvFile(envFileText);
  return "";
}

export function buildSelfImprovePlan({ branch, base, title, body }) {
  if (branch === "main" || branch === "master" || base === branch) {
    throw new Error("Ветка самоулучшения не может быть main или совпадать с базой");
  }
  return {
    branch,
    base,
    title,
    body,
    commands: [
      ["git", "checkout", "-b", branch],
      ["git", "push", "-u", "origin", branch],
      ["gh", "pr", "create", "--base", base, "--head", branch, "--title", title, "--body", body],
    ],
  };
}

function loadLocalToken() {
  const fromEnv = readTokenFromEnv(process.env);
  if (fromEnv) return fromEnv;
  try {
    const text = readFileSync(path.join(root, ".env.local"), "utf8");
    return readTokenFromEnvFile(text);
  } catch {
    return "";
  }
}

function run(command, token) {
  const [file, ...args] = command;
  const result = spawnSync(file, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token },
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").replace(token, "[redacted]");
    throw new Error(`${file} завершился с кодом ${result.status}: ${detail.trim()}`);
  }
}

function main() {
  const apply = process.argv.includes("--apply");
  const token = loadLocalToken();
  if (!token) {
    throw new Error("Нет GITHUB_TOKEN. Положи его в окружение или в .env.local");
  }
  const stamp = new Date().toISOString().slice(0, 10);
  const plan = buildSelfImprovePlan({
    branch: `self-improve/${stamp}`,
    base: "dev",
    title: "Самоулучшение",
    body: "Ветка для проверки второй машиной. Слияние не выполняется этим скриптом.",
  });
  if (!apply) {
    console.log(plan.commands.map((command) => command.join(" ")).join("\n"));
    return;
  }
  for (const command of plan.commands) {
    run(command, token);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
