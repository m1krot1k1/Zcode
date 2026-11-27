import type { CliCoreTakeoverToolsContract } from "./contract.js";

/** Пример формы контракта: путь вызова из gate. */
export const takeoverToolsContractExample: CliCoreTakeoverToolsContract = {
  contracts: () => [],
  execute: async () => ({ toolCallId: "call-1", toolName: "Bash", content: "", isError: false }),
  commitRound: () => {},
  roundMessages: () => [],
};
