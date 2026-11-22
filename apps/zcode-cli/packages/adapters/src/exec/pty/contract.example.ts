/**
 * Канонический сценарий `AgentPtyManager`: запустить интерактивный shell,
 * отправить команду, инкрементально прочитать вывод и снять дерево.
 */
import type { AgentPtyManagerContract } from "./contract.js";

export async function runInteractiveCommand(
  manager: AgentPtyManagerContract,
  workspacePath: string,
): Promise<{ output: string; exitCode?: number; sandboxMode: string }> {
  const session = await manager.create({
    cwd: workspacePath,
    workspacePath,
    sandbox: { profile: "workspace-write", networkAccess: "allow" },
  });

  await manager.write(session.sessionId, "echo hello-from-pty\r");

  // Ждём приглашение или стабилизацию вывода, а не фиксированный sleep.
  const waited = await manager.waitFor(session.sessionId, {
    pattern: "hello-from-pty",
    timeoutMs: 10_000,
  });

  // Инкрементальное чтение: продолжаем ровно с последнего увиденного seq.
  const firstRead = await manager.read(session.sessionId, { sinceSeq: 0 });
  const secondRead = await manager.read(session.sessionId, {
    sinceSeq: firstRead.session.lastSeq,
  });

  await manager.write(session.sessionId, "exit 7\r");
  const exited = await manager.waitFor(session.sessionId, {
    exitCode: 7,
    timeoutMs: 10_000,
  });

  await manager.kill(session.sessionId, { graceMs: 500 });

  return {
    output: `${waited.chunks.map((chunk) => chunk.text).join("")}${secondRead.chunks
      .map((chunk) => chunk.text)
      .join("")}`,
    ...(exited.session.exitCode !== undefined ? { exitCode: exited.session.exitCode } : {}),
    sandboxMode: session.sandboxMode,
  };
}
