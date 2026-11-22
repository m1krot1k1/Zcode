# Телеметрия сабагентов и граф вызовов

Статус: реализовано 2026-11-14.

## Scope

- own tokens/time каждого завершённого child run-а;
- subtree aggregate: own + все потомки без двойного счёта;
- видимость в строке сабагента (`own / subtree`);
- отдельный граф спавнов от текущего Agent-узла с ролями, статусом и usage.

Не входит: отдельный биллинг-экран, историческая аналитика за пределами `model_usage`,
пересчёт цен и квот.

## Владелец и порядок событий

Единственный владелец runtime-агрегата — `RuntimeTaskRegistry` в процессе CLI.

1. При admission ребёнок получает `parentTaskId` ближайшего subagent-таска.
2. На завершении child run-а `runner-execution.ts` берёт own usage из model events и
   вызывает `registry.getSubtreeUsage(agentId, ownUsage)`.
3. `AgentCompletedOutput` и `SubagentStopped` получают additive-поля
   `subtreeTotalTokens`, `subtreeTotalDurationMs`, `subtreeToolUseCount`.
4. ProductProjection переносит их в `SubagentRow`; UI показывает `own / subtree`
   и строит граф из живого дерева Agent/Task tool calls.
5. После restart own usage остаётся в `model_usage`; subtree-агрегат доступен
   из terminal catalog/событий и не пересчитывается повторно.

Двойной счёт запрещён: каждый task входит в агрегат ровно один раз, own usage
передаётся явно и не берётся одновременно из registry и events.

## Ограничения

- Сумма `totalDurationMs` — сумма длительностей run-ов, а не wall-clock параллельного дерева.
- Для background-детей, завершившихся после родителя, поздний aggregate может не попасть
  в уже закрытую строку родителя; live-строка обновляется, холодная — из сохранённых событий.
- Граф строится из зеркалированных Agent/Task tool calls текущего узла; после холодного
  restore он ограничен сохранённым транскриптом.

## Приёмка

- Unit: `runtime-task-subtree-usage.test.ts` — own + child + grandchild без двойного счёта,
  leaf и unknown task.
- UI: строка показывает `own / subtree` только когда потомки добавили расход.
- Graph dialog открывается кнопкой рядом с уровнем/usage и рендерит вложенные Agent-узлы.
