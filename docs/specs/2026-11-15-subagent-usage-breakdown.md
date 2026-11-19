# Per-agent usage breakdown у субагентов

Статус: реализовано 2026-11-15, включая live-обновление через telemetry supervisor.

## Проблема

`subagentRow` показывал только `totalTokens` и subtree-агрегат. При разборе стоимости
нельзя было увидеть, сколько ушло во вход, выход и кэш, хотя runtime уже агрегирует
`ModelUsage` (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`,
`reasoningTokens`). Из-за этого приходилось вручную разбирать rollout-логи.

## Продуктовые правила

1. `SubagentStopped` для завершённого run-а несёт own usage breakdown
   (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`,
   `reasoningTokens`) вместе с `totalTokens`.
2. `subagentRow` хранит breakdown рядом с `totalTokens`; subtree-агрегат остаётся
   отдельным и не смешивается с own usage.
3. UI-строка Agent показывает total, длительность и breakdown (`вход/выход/кэш`).
   Отсутствующие поля не рендерятся и не подменяются нулями.
4. Ошибка/отмена без usage не синтезирует фиктивные значения.
5. Token count в строке Agent, в breakdown и в графе вложенных агентов форматирует
   один `formatCompactTokenCount(value, locale)`; шкала единиц полная — `k/M/B/T`:
   - `< 1 000` — точное число (`999`);
   - `1 000 … 999 999` — прежний компактный вид с `k` (`34k`, `55k`,
     `999 999 -> 1000k`); этот диапазон не менялся;
   - `1 000 000 … 999 999 999` — `M`;
   - `1 000 000 000 … 999 999 999 999` — `B`;
   - `>= 1 000 000 000 000` — `T`; единицы выше `T` нет, поэтому
     `1e15 -> 1000,0T`.
     Для `M`/`B`/`T` действуют общие правила:
   - ровно одна дробная цифра;
   - decimal separator по locale (`ru-RU` — запятая, `en-US` — точка):
     `1 000 000 -> 1,0M`, `3 000 000 -> 3,0M`, `3 100 000 -> 3,1M`,
     `3 200 000 -> 3,2M`, `3 942 000 -> 3,9M`;
   - группировка разрядов отключена (`useGrouping: false`), поэтому на стыке
     `999 999 999 -> 1000,0M` (`ru-RU`) / `1000.0M` (`en-US`), а не
     `1 000,0M` / `1,000.0M`. Диапазон `< 1M` правила группировки не касается;
   - порог применяется к исходному (неокруглённому) значению, округление
     выполняется после выбора единицы: `999 999 999` остаётся в `M` и даёт
     `1000,0M`, а `1 000 000 000` попадает в `B` и даёт `1,0B`;
   - суффикс — Latin `k/M/B/T` (не кириллическая `к`); второй formatter для
     тех же чисел не создаётся.
     Форма `3942к`/`3942k` для значений `>= 1 000 000` не допускается.

## Владелец состояния и порядок событий

```text
usage.delta (child session, каждый model request)
        │
        ▼
telemetry supervisor (renderer)
  handleForeground/BackgroundSubagentFact
        │  onSubagentUsageChanged(childSessionId, usage)
        ▼
subagentUsageStore (Zustand, ключ = childSessionId)
        │
        ▼
ConversationAgentToolCallRow → AgentToolCallBlock
  live input/output/cache обновляются сразу; projection-поля — fallback
        │
terminal/cleanup → onSubagentUsageChanged(childSessionId, null) → clear
```

```text
subagent runner (core)
  aggregateModelUsage(child events)
        │
        └─ SubagentStopped { totalTokens, inputTokens, outputTokens,
                             cacheReadTokens, cacheWriteTokens, reasoningTokens }
                  │
                  ▼
product projection (bootstrap)
  subagentRow { totalTokens, inputTokens, outputTokens, cacheReadTokens, ... }
                  │
                  ▼
UI AgentToolCallBlock
  "N tok · duration · вход X · выход Y · кэш Z"
```

## До / после

| Сценарий              | До                | После                                  |
| --------------------- | ----------------- | -------------------------------------- |
| Завершённый субагент  | только total      | total + input/output/cache             |
| Run с потомками       | own/subtree total | own breakdown + subtree total отдельно |
| Нет usage от provider | total отсутствует | breakdown тоже отсутствует, без нулей  |

## Acceptance-сценарии

1. `SubagentStopped` с usage → row содержит все переданные поля; UI показывает breakdown.
2. Старое событие без breakdown → row и UI работают как раньше, поля не появляются.
3. Потомки не попадают в own breakdown; subtree total не меняется.
4. `ru-RU`, total `3 942 000` → в строке Agent `3,9M tok`, подстроки `3942`
   в usage-части нет.
5. `ru-RU`, total `1 000 000` / `3 000 000` / `3 100 000` / `3 200 000` →
   `1,0M` / `3,0M` / `3,1M` / `3,2M`.
6. Границы k: `999 999` → `1000k`, `34 000` → `34k`, `55 000` → `55k`;
   `en-US` для `>= 1 000 000` использует точку (`3.9M`), а не запятую.
7. Стык M/B по сырому значению: `999 999 999` → `1000,0M` (`en-US` —
   `1000.0M`), `1 000 000 000` → `1,0B`; группирующих разделителей в целой
   части нет.
8. B/T: `3 942 000 000` → `3,9B`; `1 000 000 000 000` → `1,0T`;
   `1 500 000 000 000` → `1,5T`; `1e15` → `1000,0T` (единицы выше `T` нет).
9. `en-US`: `1 000 000 000` → `1.0B`, `1 500 000 000 000` → `1.5T`,
   без `,` в целой части.

## Проверки

- Projection: `product-projection.test.ts` — `SubagentStopped` переносит usage breakdown в row.
- UI/store: `subagentUsageStore.test.ts` — mapping cache-полей, overwrite и clear на terminal.
- UI: `AgentToolCallBlock` рендерит breakdown при наличии полей и не рендерит при
  отсутствии.
- UI: `agentToolCallBlock.test.ts` проверяет фактический рендер строки для
  `ru-RU` и `en-US` на миллионных, миллиардных и триллионных значениях, стык
  `999 999 999`/`1e9`, `1e12`/`1e15`, отсутствие группировки разрядов,
  breakdown и границу `999 999`.
- Telemetry: `conversationTelemetryAttachment.test.ts` / `messageTelemetry.test.ts`
  продолжают проходить с новым callback.
- Targeted tests/typecheck запускаются в текущем окружении после установки Node/pnpm;
  результаты фиксируются в отчёте сессии.
