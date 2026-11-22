/**
 * cli-file-transaction 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { IFileLockRegistry } from "./contract.js";

export async function exampleCliFileTransaction(registry: IFileLockRegistry): Promise<void> {
  await registry.withLocks(
    [
      { path: "src/b.ts", mode: "exclusive-write" },
      { path: "src/a.ts", mode: "exclusive-write" },
    ],
    { workspaceRoot: "/workspace/demo" },
    async () => {
      // Мутация выполняется под защитой лексикографически упорядоченных блокировок.
    },
  );
}
