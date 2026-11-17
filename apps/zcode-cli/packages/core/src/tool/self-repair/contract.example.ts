/**
 * cli-tool-self-repair 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { IToolCallSelfRepair } from "./contract.js";

export function exampleCliToolSelfRepair(repair: IToolCallSelfRepair): unknown {
  const outcome = repair.repairToolInput({
    toolName: "Read",
    rawInput: { file_path: "src/index.ts", offset: "10", limit: "50" },
    inputJsonSchema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        offset: { type: "integer" },
        limit: { type: "integer" },
      },
      required: ["file_path"],
    },
    finishReason: "tool-calls",
  });
  return outcome.repairedInput;
}
