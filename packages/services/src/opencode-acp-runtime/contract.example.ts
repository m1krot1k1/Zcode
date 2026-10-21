/**
 * opencode-acp-runtime 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { IOpenCodeAcpRuntime } from "./contract.js";

export async function exampleOpenCodeAcpSession(
  runtime: IOpenCodeAcpRuntime,
  localWorkspacePath: string,
): Promise<void> {
  const status = await runtime.getCliStatus();
  if (status.status !== "available") return;

  // A durable OpenCode session exists only after this explicit call.
  const session = await runtime.startSession({ cwd: localWorkspacePath });
  const modelOption = session.configOptions.find(
    (option) => option.category === "model" && option.type === "select",
  );
  if (!modelOption) {
    // The ACP agent did not publish a selectable model; OpenCode's own default remains in force.
    return;
  }

  await runtime.setConfigOption({
    sessionId: session.sessionId,
    configId: modelOption.id,
    value: modelOption.currentValue,
  });
}
