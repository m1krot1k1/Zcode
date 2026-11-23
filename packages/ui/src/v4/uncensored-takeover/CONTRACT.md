# ui-uncensored-takeover

在既有 subagent 行内渲染一次「回退模型接管」的事实卡片。卡片是纯展示组件：只读
`subagentRowSchema.takeover`，不请求服务、不写 store、不引入第二份状态；数据所有者仍是
Chat 投影写出的 subagent 行。

不变量：

- 只有 `row.takeover` 存在时 `SubagentRowView` 才渲染卡片；没有 `takeover` 时保留原有
  单行兜底摘要，不新增并行行类型或第二套分发。
- `itemIndex` 在数据里是 0-based，展示为 1-based；长 `itemText` 用行数裁剪，并通过
  `title` 暴露完整文本。
- 模型为空显示 `—`；`output` 全量渲染、不截断，放在 `max-h-*` + `overflow-auto`、
  `tabIndex={0}` 的可键盘滚动区域；`no-enabled-models` 显示显式提示而不渲染空输出块。
- 无障碍：卡片标题与输出区域通过 `aria-labelledby` 关联；`running` 用 `role="status"`，
  `refused`/`error` 用 `role="alert"`，状态始终有文字，不只靠颜色。
- 文案只用 `chat.uncensoredTakeover.*` 三个目录的既有插值机制；字号只用
  `text-ui-*`，状态色只用 `*-surface` / `*-surface-foreground` 语义对。
