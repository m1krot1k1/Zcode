/**
 * cli-uncensored-takeover 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 *
 * Turn loop keeps ownership of events/durable rows; this module only derives the item,
 * shapes the request and runs enabled models in order.
 */
import type { CliUncensoredTakeoverContract, UncensoredConfigPort } from "./contract.js";

export async function exampleCliUncensoredTakeover(
  contract: CliUncensoredTakeoverContract,
  configPort: UncensoredConfigPort,
): Promise<void> {
  const reason = contract.detectRefusal({
    finishReason: "stop",
    rawFinishReason: "content_filter",
  });
  if (!reason) return;
  const item = contract.attributeItem([
    { content: "finish the migration", priority: "high", status: "in_progress" },
  ]);
  if (!item) return;
  const fragments = contract.selectFragments({ itemText: item.itemText, results: [] });
  const terminal = await contract.run({
    configPort,
    workspace: { workspacePath: "/workspace" },
    taskId: "session-1",
    itemIndex: item.itemIndex,
    itemText: item.itemText,
    fragments,
  });
  const agentId = contract.agentId("session-1", item.itemIndex, item.itemText);
  contract.buildEntry({
    sessionId: "session-1",
    taskId: "session-1",
    itemIndex: item.itemIndex,
    itemText: item.itemText,
    agentId,
    terminal,
    createdAt: 1,
    updatedAt: 2,
  });
  contract.buildReminder({ itemIndex: item.itemIndex, terminal });
}
