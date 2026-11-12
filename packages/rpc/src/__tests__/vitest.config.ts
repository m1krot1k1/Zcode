// 该目录不在根 vitest.config.ts 的 include 中（根配置只收 packages/*/test 与少数列出的
// src 测试），因此保留一个可独立执行的配置。运行（cwd = packages/rpc）：
//   pnpm --dir packages/rpc exec vitest run --config src/__tests__/vitest.config.ts
// 纯对象配置，不 import vitest/config：本文件位于 rpc tsconfig 的 src include 内，
// 这样不会把测试工具类型带进包构建。
export default {
  test: {
    include: ["src/__tests__/**/*.test.ts"],
  },
};
