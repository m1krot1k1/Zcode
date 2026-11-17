import { configDefaults, defineConfig } from "vitest/config";

// 这些目录里的测试文件使用 node:test（`import test from "node:test"`），由各包
// package.json 的 `test` 脚本通过 Node 原生 test runner（tsx --test）执行。
// Vitest 收集到它们时只会报 "No test suite found in file ..."：断言不执行，
// 结果却以失败文件计入，制造假红并吞掉真实覆盖。这里让 Vitest 不再收集它们。
// 例外：packages/cli/tests/mode-menu.test.ts 用的是 vitest API，必须继续收集。
const nodeTestRunnerFiles = [
  // `enhance-command.test.ts` also uses the Vitest API (mocked AgentRuntime), like mode-menu.
  "packages/cli/tests/**/!(mode-menu|enhance-command).test.ts",
  "packages/tui/tests/**/*.test.ts",
];

export default defineConfig({
  test: {
    // Bugfix: 外部 zcode-cli 历史里同时存在 test/ 和 tests/ 目录；合入 apps 后需要同时保留两种约定，避免新增包测试被根 include 规则过滤掉。
    include: [
      "test/**/*.test.ts",
      "tests/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "packages/*/tests/**/*.test.ts",
      // R06: регрессии редакции секретов лежат рядом с исходниками в `src/**/__tests__`
      // и раньше не собирались ни этим конфигом, ни корневым (он не покрывает apps/).
      // Перечисляем точные пути, чтобы не подключать чужие src-тесты оптом.
      "packages/adapters/src/model/__tests__/provider-finish-business-error.redaction.test.ts",
      "packages/adapters/src/model/cache-control/contract.test.ts",
      "packages/core/src/runtime/helpers/__tests__/turn-errors.redaction.test.ts",
      "packages/core/src/tool/handlers/__tests__/bash-sandbox-honesty.test.ts",
      "packages/core/src/tool/self-repair/contract.test.ts",
      "packages/core/src/tool/file-transaction/contract.test.ts",
      // 4.5b: цикл самовосстановления — managed-модуль рядом с исходниками.
      "packages/core/src/runtime/auto-repair-loop/contract.test.ts",
      "packages/core/src/runtime/auto-repair-loop/loop.test.ts",
      "packages/core/src/runtime/auto-repair-loop/runtime-factory.test.ts",
      // 4.5b: stateful Playwright-телеметрия — managed-модуль рядом с исходниками.
      "packages/adapters/src/browser/telemetry/contract.test.ts",
    ],
    // Bugfix: 排除由 Node 原生 test runner 覆盖的文件，保留 Vitest 默认忽略项。
    exclude: [...configDefaults.exclude, ...nodeTestRunnerFiles],
  },
});
