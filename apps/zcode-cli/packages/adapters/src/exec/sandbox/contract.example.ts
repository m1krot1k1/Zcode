/**
 * Канонический вызов `ExecutionSandbox`: агент копирует именно этот сценарий.
 * Показывает и обёртку команды, и гарантированное снятие дерева процессов.
 */
import { spawn } from "node:child_process";

import type { ExecutionSandboxContract } from "./contract.js";

export async function runSandboxedCommand(
  sandbox: ExecutionSandboxContract,
  input: { workspacePath: string; command: string },
): Promise<{ sandboxMode: string; exitCode: number | null; output: string }> {
  const wrapped = await sandbox.wrap(
    { file: "/bin/sh", args: ["-c", input.command] },
    {
      profile: "workspace-write",
      cwd: input.workspacePath,
      workspacePath: input.workspacePath,
      networkAccess: "deny",
      env: { CI: "1" },
      limits: { cpuSeconds: 30, memoryBytes: 512 * 1024 * 1024 },
    },
  );

  const child = spawn(wrapped.file, wrapped.args, {
    cwd: wrapped.cwd,
    env: wrapped.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("close", (code) => resolve(code));
  });

  // Обязательно: корень запускается лидером группы, поэтому снимается всё дерево.
  await sandbox.killTree(child.pid ?? -1, { signal: "SIGTERM", graceMs: 1_000 });

  return { sandboxMode: wrapped.sandboxMode, exitCode, output };
}
