/**
 * ui-uncensored-takeover 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 *
 * 调用方是 Chat 行分发：`SubagentRowView` 只在 `row.takeover` 存在时渲染卡片，
 * 不另建并行行类型，也不把数据复制到其它 store。
 */
import type { UncensoredTakeover, UncensoredTakeoverCardProps } from "./contract.js";

export const takeoverExample: UncensoredTakeover = {
  taskId: "session-1",
  itemIndex: 3,
  itemText: "Add the missing regression test",
  modelId: "fallback-model-a",
  status: "done",
  output: "Added the regression test and ran the focused UI suite.",
};

export const cardExample: UncensoredTakeoverCardProps = {
  takeover: takeoverExample,
};

export const noEnabledModelsExample: UncensoredTakeoverCardProps = {
  takeover: {
    ...takeoverExample,
    modelId: null,
    status: "no-enabled-models",
    output: "",
    reason: "refusal",
  },
};
