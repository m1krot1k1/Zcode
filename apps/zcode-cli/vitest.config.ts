import { configDefaults, defineConfig } from "vitest/config";

// 这些目录里的测试文件使用 node:test（`import test from "node:test"`），由各包
// package.json 的 `test` 脚本通过 Node 原生 test runner（tsx --test）执行。
// Vitest 收集到它们时只会报 "No test suite found in file ..."：断言不执行，
// 结果却以失败文件计入，制造假红并吞掉真实覆盖。这里让 Vitest 不再收集它们。
// 例外：packages/cli/tests/mode-menu.test.ts 用的是 vitest API，必须继续收集。
const nodeTestRunnerFiles = [
  "packages/cli/tests/**/!(mode-menu).test.ts",
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
    ],
    // Bugfix: 排除由 Node 原生 test runner 覆盖的文件，保留 Vitest 默认忽略项。
    exclude: [...configDefaults.exclude, ...nodeTestRunnerFiles],
  },
});
