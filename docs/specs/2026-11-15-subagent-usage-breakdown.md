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

| Сценарий | До | После |
| --- | --- | --- |
| Завершённый субагент | только total | total + input/output/cache |
| Run с потомками | own/subtree total | own breakdown + subtree total отдельно |
| Нет usage от provider | total отсутствует | breakdown тоже отсутствует, без нулей |

## Acceptance-сценарии

1. `SubagentStopped` с usage → row содержит все переданные поля; UI показывает breakdown.
2. Старое событие без breakdown → row и UI работают как раньше, поля не появляются.
3. Потомки не попадают в own breakdown; subtree total не меняется.

## Проверки

- Projection: `product-projection.test.ts` — `SubagentStopped` переносит usage breakdown в row.
- UI/store: `subagentUsageStore.test.ts` — mapping cache-полей, overwrite и clear на terminal.
- UI: `AgentToolCallBlock` рендерит breakdown при наличии полей и не рендерит при
  отсутствии.
- Telemetry: `conversationTelemetryAttachment.test.ts` / `messageTelemetry.test.ts`
  продолжают проходить с новым callback.
- Targeted tests/typecheck запускаются в текущем окружении после установки Node/pnpm;
  результаты фиксируются в отчёте сессии.
