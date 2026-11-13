import { lazy } from "react";

// Recharts 会在模块初始化阶段触发 decimal.js-light 的 LN10 校验，
// 在 Electron Linux 容器里会阻断整个 renderer 启动。图表按需加载后，
// 普通启动和 e2e 首页不会被 Usage 页图表依赖影响，打开 Usage 时也由局部边界隔离。
export const CodingPlanUsageLineChart = lazy(() =>
  import("@/settings/usage-stats/CodingPlanUsageLineChart.js").then(
    (module) => ({
      default: module.CodingPlanUsageLineChart,
    }),
  ),
);
export const CodingPlanUsageBarChart = lazy(() =>
  import("@/settings/usage-stats/CodingPlanUsageBarChart.js").then(
    (module) => ({
      default: module.CodingPlanUsageBarChart,
    }),
  ),
);

export const CODING_PLAN_DETAIL_SERIES_COLORS = [
  "var(--color-usage-chart-1)",
  "var(--color-usage-chart-2)",
  "var(--color-usage-chart-3)",
  "var(--color-usage-chart-4)",
  "var(--color-usage-chart-5)",
  "var(--color-usage-chart-6)",
] as const;

export const MAX_SELECTED_CODING_PLAN_DETAIL_SERIES = 3;
