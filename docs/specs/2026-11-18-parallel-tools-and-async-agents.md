# 并行工具调用与异步 Agent 批量执行

## 背景

当前运行时的并行组只依据工具条目的静态 `concurrentSafe` 元数据：

- `Read`/`Grep`/`Glob`/`WebFetch` 等 read-only 工具会进入同一个并行组。
- `Bash` 静态标记为 `concurrentSafe: false`，即使命令是 `pwd`、`ls`、`git status` 这类只读命令，也会与所有写命令一样串行执行。
- 同一批里的多个 `Agent` 虽然共享并行组，但默认 `run_in_background: false`；batch runner 会等所有 Agent 结束才把整批结果交回模型，最慢的 Agent 决定整批延迟。

目标是让所有**可证明安全**的调用并行，同时保留副作用调用的串行屏障；多个 Agent 不必等最慢的一个，先完成的结果先进入模型上下文。

## 外部实践

- Anthropic 的 multi-agent research system 建议主 Agent 并行启动 3–5 个子 Agent，而不是串行；同时明确指出同步等待所有子 Agent 是延迟瓶颈，异步结果需要额外的协调、状态和错误处理。
- Claude Code subagents 文档把后台子 Agent 作为默认并发模型：启动后父级继续工作，完成时发送通知；需要立即答案时才使用同步调用。
- OpenAI Agents SDK 默认在一次模型请求的多个 tool call 全部完成后才再次调用模型，并通过 `parallel_tool_calls`/并发上限控制执行；这验证了“同一批结果先聚合再回到模型”是标准语义。
- LangGraph 的 map-reduce/Send API 使用 fan-out/fan-in：并行分支完成后由 reducer 聚合，不承诺单个分支提前推进下游。

因此本仓库采用两层策略：

1. **同一批内的工具**仍然按组聚合，保证消息协议和结果顺序稳定；但扩大可并行组，允许只读 Bash 命令加入。
2. **多个 Agent** 通过后台通知实现“先完成先消费”，不强行改变模型消息协议，也不在一个批次内注入半成品工具结果。

## 契约

### 1. 动态并发能力

`ToolEntry` 新增可选的 `resolveConcurrencyCapability(input, context)`。`scheduleTools` 在构建依赖图时调用它，并用返回值覆盖静态元数据：

- `readOnly`
- `concurrentSafe`
- `sideEffectScope`

`Bash` 条目使用 `isBashInputConcurrencySafe` / `isRuntimeReadOnlyBashCommand` 判定：

- 只读命令：`concurrentSafe: true`、`readOnly: true`、`sideEffectScope: "none"`。
- 写命令或无法证明只读的命令：保持 `concurrentSafe: false`，作为并行组之间的屏障。
- 判定必须基于完整命令（含管道、重定向、命令替换），不能只看第一个 token。

### 2. Agent 批量自动后台

`ToolExecutionContext` 新增 `parallelAgentBatchSize`，由 batch runner 按同组内 `Agent`/`Task` 数量填充。

Agent handler 的 `runInBackground` 解析顺序：

1. 显式 `run_in_background: true/false` 优先（turn-scoped caller 的 `true` 被拒绝，见 §3.1）。
2. 未显式指定、caller 为 root/main（`callerAgentType === undefined`）、同组 Agent/Task 数量 `> 1`：自动后台启动。
3. 单 Agent、存在 `task_graph` 或 turn-scoped caller：保持前台阻塞语义。

后台 Agent 返回启动确认；每个 Agent 完成时通过既有 `background_task.notification` 队列进入模型上下文。模型可以先消费已完成的结果，不必等待最慢的 Agent。

### 3. 顺序与失败边界

- 并行组内任意调用失败不取消同组其他调用；失败作为该调用的结果返回。
- 写命令、写文件、PTY、未分类的 MCP 工具不进入并行组。
- `maxConcurrency` 仍限制单组同时执行数，默认 10。
- 同一批的 `batch_start`/`batch_complete` 事件顺序不变；后台 Agent 的完成通知独立于 batch。

### 3.1 Turn-scoped caller invariant

`callerAgentType !== undefined` 表示调用来自 subagent/`start`/`orchestrator`/worker，而不是持久 root。此类 caller 的 runtime 在本轮报告后立即关闭并取消所有直接子任务，因此：

- 同批多个 `Agent`/`Task` 不得自动后台；全部在当前 turn 内 foreground 执行并 join。
- 显式 `run_in_background: true` 在 spawn 前拒绝，返回 `agent_background_unavailable`；错误提示要求移除该字段并前台重试。
- profile 的 `background: true` 只是 persistent root 的默认值；turn-scoped caller 以 `allowBackground: false` 覆盖它。
- `allowBackground: false` 同时关闭 `autoBackgroundMs` 定时器和外部 background request，避免 turn 结束后才 detach。
- `task_graph` 仍是静态 join 的替代路径；其节点继承同一 `allowBackground` 策略。

### 3.2 Terminal gate

child turn 成功结束时，runtime 在返回报告前检查直接子任务：

- 只统计 `type === "local_agent"`、`parentSessionId` 等于当前 child session、且状态非终态的任务。
- 若存在未收敛子任务，返回 `agent_unresolved_children` 错误，而不是成功报告；随后 runtime 关闭会取消这些子任务。
- 该门禁是 §3.1 的防御层：即使未来路径绕过 foreground 策略，也不会把“已丢失的 branch”伪装成成功。

### 4. 状态所有者

| 状态                    | 所有者                                                     |
| ----------------------- | ---------------------------------------------------------- |
| 工具是否可并行          | `ToolScheduler` + `ToolEntry.resolveConcurrencyCapability` |
| 并行组与 maxConcurrency | `batch-runner`                                             |
| Agent 是否后台          | Agent handler + caller scope + `parallelAgentBatchSize`    |
| 后台结果投递            | `runtime-command-queue` / `background_task.notification`   |

事件顺序：

```text
model stream
  -> scheduleTools (dynamic capability)
  -> batch_start(group 0)
       -> read-only Bash / Read / Grep in parallel
  -> batch_complete(group 0)
  -> batch_start(group 1: write barrier)
  -> batch_complete(group 1)
  -> model next request

parallel Agent batch (root/main)
  -> Agent launches background (all siblings)
  -> batch_complete (launch acknowledgements)
  -> notification(agent A completed) -> model turn
  -> notification(agent B completed) -> model turn

nested Agent batch (turn-scoped caller)
  -> all Agent/Task calls run foreground in the same batch
  -> each child settles and returns its report
  -> batch_complete (all reports)
  -> parent turn returns its report
```

### 5. 执行选项透传

`executeToolSchedule` 传给 `executeBatch` 的选项对象和 `executeBatch` 的每个分支（快路径与按 `maxConcurrency` 分块的并发路径）都必须把完整的 `ToolBatchExecuteOptions`/`ToolExecuteOptions` 上下文转发给工具执行；禁止手工重建只含部分字段的选项对象，否则字段会随分支分叉而静默丢失。

修复前，`executeBatch` 的快路径已经展开 `...options`，但按 `maxConcurrency` 分块的分支手工列举字段，漏掉 `finishReason` 与 `consecutiveSchemaFailuresByTool`；`executeToolSchedule` 传给 `executeBatch` 的选项对象同样手工重建，额外漏掉 `offPeakTurn`。

- `offPeakTurn` 必须到达 `ToolExecutionContext`：`assertNotOffPeakTurn` 依赖本轮事实对 `Workflow` 与 `OffPeakCreate` 执行 handler 级闲时轮拒绝（`handlers/workflow.ts`、`handlers/off-peak.ts`），这是 provider denylist 之外的第二层防护；字段缺失时该函数提前返回，拒绝被绕过。`SendMessage` 按 `packages/shared/src/off-peak-execution.ts` 的约定在闲时轮允许执行，不在这层拒绝范围内。
- `finishReason` 与 `consecutiveSchemaFailuresByTool` 必须到达 `call-runner-support`：前者保证 `finishReason: "length"` 的截断输入走截断恢复而不是普通自修复，后者保证调用方的连续 schema 失败计数持续更新。
- 回归覆盖：`apps/zcode-cli/packages/core/tests/schedule-options-forwarding.test.ts` 经 `executeSchedule` 同时验证快路径与分块并发路径，以及三个字段是否到达 handler 与自修复准入。

## 6. Параллельная оркестрация независимых задач и выбор профилей

### Владельцы состояния

- Root turn владеет исходной целью и финальной проверкой; он не переписывает план orchestrator.
- Orchestrator владеет планом: todos (`TodoWrite`), назначением профилей, порядком зависимостей и централизованной сверкой отчётов. `TodoRead`/`TodoWrite` — control-plane плана, а не доступ к репозиторию; Read/Glob/Grep/Bash/Write/Edit остаются недоступны роутерам.
- Worker владеет только своей веткой и её отчётом; вложенное делегирование разрешено в пределах профиля, глубины, бюджета и `maxParallel`.
- Runtime владеет admission, слотами параллелизма, отменой, таймаутами и записью `session_task_link`; UI/store не дублируют эту истину.

### Правила выполнения

1. Зависимая задача сначала раскладывается на todos с владельцем-профилем и проверяемым критерием. Независимые листья уходят отдельными `Task` в одном assistant-сообщении; зависимые запускаются только после терминального отчёта prerequisites.
2. Последовательный цикл `Task → ожидание → Task` для независимых пунктов запрещён: runtime исполняет несколько Agent/Task calls одного батча параллельно, и оркестратор обязан этим пользоваться.
3. Профиль выбирается по компетенции: backend/runtime/protocol — `backend-coder`, UI/renderer — `frontend-coder`, build/release/CI — `infra-coder`, тесты — `test-engineer`, дефект — `debugger`, факты — `researcher`, проверка — `reviewer`/`security-reviewer`, новые устойчивые роли — `subagent-factory`. Один профиль не назначается всем независимым пунктам; повторное использование допустимо только для однотипных пунктов одной области.
4. После join orchestrator обновляет todos, сверяет отчёты с исходной целью и отправляет repair-ветку при пробеле. Конфликтующие/неоднозначные результаты проходят через существующий review/verification механизм, а не разрешаются молчаливым выбором первого отчёта.
5. Параллелизм не обходит `maxParallel`, бюджет, глубину, отмену и таймауты. Дочерние сессии наследуют allowlist родителя через `resolveSubagentToolAllowlist`; расширение доступа невозможно.

### Marketplace

Совместимые skills/plugins/MCP устанавливаются дочерним агентом через существующие нативные инструменты (`SkillSearch`, `SkillInstall`, `InstallCapability`) и общий механизм настройки; отдельного обхода для субагентов нет. Несовместимая платформа/окружение отклоняется fail-closed, а установка не расширяет allowlist родителя. Границы проверяются `capability-preflight`, `capability-install` и `subagent-skill-marketplace` тестами.

### Воспроизводимость и метрики

Сессия `session_a45d1d5f23b175e9f67ef3a8bd59485f` в локальных артефактах отсутствует: id не найден в `~/.zcode/cli/log/*.jsonl`, `~/.zcode/cli/db/db.sqlite` (таблицы `session`, `session_task_link`) и каталогах rollout/agents. Это зафиксированный блокер доступа, а не основание подменять данные. Эквивалентный регрессионный сценарий — `subagent-nested-join.test.ts`: три независимые ветки разных профилей запускаются одним батчем, счётчик одновременно активных веток должен достигнуть 3, а общая длительность — быть меньше последовательной суммы. Сравнение до/после: последовательная очередь трёх веток с барьером была бы ≥ 3× задержки одной ветки; параллельный батч завершается за одну задержку. Численный выигрыш фиксируется в отчёте прогона теста; при недоступности production-сессии остаётся риск, что конкретная модель сама сериализует вызовы, и это лечится контрактом промпта, а не рантаймом.

## 验收

- `runtime-tool-loop.test.ts`：只读 Bash 与 `Read` 进同一组；写 Bash 单独成组；后续只读命令在写屏障之后。
- `agent-routing-policy.test.ts`：root 同组多个 Agent 自动 `runInBackground: true`；orchestrator/worker 同组多个 Agent 为 `runInBackground: false` 且 `allowBackground: false`；嵌套显式 `true` 在 spawn 前拒绝。
- `subagent-background.test.ts`：`allowBackground: false` 即使配置 `autoBackgroundMs` 也不会 detach；runner 直接拒绝嵌套显式 background；既有后台通知和去重不回归。
- `subagent-terminal-gate.test.ts`：有未收敛直接子任务时返回 `agent_unresolved_children`；终态子任务、其他父级和非 agent 任务不误报。
- `schedule-options-forwarding.test.ts`：快路径与按 `maxConcurrency` 分块的并发路径都完整转发 `offPeakTurn`/`finishReason`/`consecutiveSchemaFailuresByTool`；`executeSchedule` 路径再次手工重建部分选项视为回归。
- `subagent-nested-join.test.ts`：三条 независимые ветки разных профилей одновременно активны (`maxActiveBranches === 3`), завершаются за время меньше последовательной очереди и попадают в `session_task_link` с разными `agentType`; прежний join-сценарий продолжает проходить.
- `subagent-profile.test.ts`：orchestrator получает `Task` + `TodoRead`/`TodoWrite` и не получает Read/Glob/Grep/Bash/Write/Edit; контракт содержит todo-декомпозицию, запрет последовательного цикла для независимых пунктов, матрицу профилей и централизованную сверку.
- 生产构建后，混合批次中只读命令的日志时间应重叠；写命令与前后只读命令不得重叠。

## 不在本次范围

- 在同一批次内把单个工具结果提前注入模型请求。主流 SDK 仍在全部 tool result 后重新调用模型；本仓库用后台 Agent 通知实现早期结果消费。
- 对任意 Bash 命令做自动并行。只有可证明无副作用的命令才允许，避免竞态和不可复现的测试。
