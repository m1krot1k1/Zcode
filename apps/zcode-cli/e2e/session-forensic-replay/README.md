# Session Forensic Replay E2E

Детерминированное воспроизведение ранее падавшей траектории
`session_dee7732e677519c63e3dd10d5eeeaaff` (см.
[`docs/architecture/stage1-forensic-audit-and-baseline.md`](../../../docs/architecture/stage1-forensic-audit-and-baseline.md)).

Набор гоняет **настоящий** runtime (`createZCodeApp` → `AgentRuntime` →
tool registry → executor → adapters), подменяя только модель: локальный
скриптованный OpenAI-совместимый провайдер на `127.0.0.1`. Сети, ключей и
дисплея не требуется — набор пригоден для CI.

## Кейсы

| Кейс                     | Что доказывает                                                                                                                                                     | Закрывает |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `truncated-tool-args`    | Обрыв tool call по `finishReason === "length"` даёт детерминированный `TOOL_CALL_TRUNCATED_BY_MAX_TOKENS` + инструкцию декомпозиции; `Unexpected end of JSON input` не появляется; на диск не попадает ни байта обрезанного файла | F-01 |
| `multiedit-transaction`  | Атомарная мультифайловая транзакция: успешный `create+edit+delete` применяется целиком; транзакция с синтаксической ошибкой отклоняется с `No files were modified`; `Edit` со сдвинутым отступом сопоставляется tolerant-стратегией | F-02, F-03, F-07 |
| `pty-session`            | `PtySession` виден модели (порт инжектируется хостом), реально стартует shell, отдаёт инкрементальный вывод, `exitCode`, терминальное состояние при `kill` | — |
| `bash-sandbox`           | Модель видит фактический `sandbox.mode` в тексте результата; запись за пределами workspace (в `$HOME`) блокируется реальной `bwrap`-песочницей | F-03 |
| `swarm-file-locks`       | Три параллельных субагента с пересекающимся `write_paths`: реестр владения сериализует доступ — ровно один получает владение, остальные детерминированно отклоняются (`write_claim_conflict`), общий файл не затирается | F-02 |
| `enhance-command`        | Реальный `runEnhanceCommand` → `generateWorkspaceText`: успешный возврат промпта, сохранение `@path`-упоминаний, отмена через `AbortSignal`, отказ на пустом вводе, `model_unavailable` | 4.4 |
| `prompt-cache-apply-patch` | Кэшируемый префикс (tools + первые сообщения) побайтово стабилен между запросами провайдера; `ApplyPatch` виден не-GPT модели и реально применяет патч | F-03 |
| `code-index`             | Реальный `CodeIntelligenceService` (SQLite + AST): автостарт индексации в фоне, релевантный фрагмент в поиске, инкрементальное обновление после правки, инструмент `CodeIndex` виден модели | F-05 |
| `auto-repair-loop`       | `enableAutoRepairLoop: true` в реальном ходе агента: `tsc` через `ExecutionPort` даёт блокирующий сигнал `TS1005`, модель получает `[auto-repair]`-отчёт и исправляет файл без участия пользователя; лимит запусков соблюдён | 4.5b |

## Запуск

Сначала соберите пакеты (нужны `dist` артефакты):

```bash
pnpm --filter @zcode/contracts build
pnpm --filter @zcode/shared-types build
pnpm --filter @zcode/adapters build
pnpm --filter @zcode/core build
pnpm --filter @zcode/bootstrap build
```

Полный набор:

```bash
node apps/zcode-cli/e2e/session-forensic-replay/run.mjs
```

Из рабочего дерева монорепозитория (когда `node` не видит workspace-резолюцию):

```bash
pnpm --filter zcode-cli exec tsx ../../apps/zcode-cli/e2e/session-forensic-replay/run.mjs
```

Отдельные кейсы и артефакты:

```bash
node apps/zcode-cli/e2e/session-forensic-replay/run.mjs \
  --case=truncated-tool-args,pty-session \
  --artifacts-dir=/tmp/replay-artifacts
```

Флаги:

- `--case=a,b` — выбор кейсов (по умолчанию все).
- `--artifacts-dir=<dir>` — сохранить артефакты (иначе временный каталог удаляется).
- `--keep-tmp` — не удалять временный каталог.

## Артефакты

```
<artifacts-root>/
  result.json                      # сводка: статус, длительности, assertions по кейсам
  cases/<case>/capture.json        # перехваченные запросы/ответы провайдера
  cases/<case>/events.json         # события сессии (tool_call_*, model_*, subagent_*, ...)
  cases/<case>/result.json         # assertions конкретного кейса
  cases/<case>/workspace/          # рабочая папка кейса
```

## Требования окружения

- POSIX-шелл (`/bin/sh`) для `pty-session` и `bash-sandbox`.
- `bubblewrap` для реальной изоляции на Linux. Если `bwrap` недоступен,
  `bash-sandbox` требует честный `degraded` с причиной в тексте результата —
  кейс не притворяется, что изоляция есть.
- Собранные `dist` пакетов (см. выше).
