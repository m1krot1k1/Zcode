/**
 * subagents 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { SubagentsContract } from "./contract.js";

export async function exampleSubagents(
  contract: SubagentsContract,
  workspacePath: string,
): Promise<void> {
  const result = await contract.list({ workspacePath });
  for (const agent of result.agents) {
    if (!agent.enabled) continue;
    // 调用方只展示返回的摘要；profile 文件和持久化状态由服务负责。
    void agent.name;
  }
}
