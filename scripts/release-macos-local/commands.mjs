import { spawn } from "node:child_process";
import { repoRoot } from "./repo-root.mjs";

export function run(command, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: repoRoot,
      stdio: "inherit",
      env: { ...process.env, ...options.env },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command[0]} завершился с кодом ${code}`));
    });
  });
}

export function capture(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command[0]} завершился с кодом ${code}: ${stderr.trim()}`));
    });
  });
}
