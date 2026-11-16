# Prompt registry and prompt CI

Статус: реализовано 2026-11-16.

## Назначение

Промпты ZCode — это несколько независимых слоёв (identity, harness, AGENTS.md, роли,
compaction, memory, tool descriptions, skills, workflow/expert prompts). Без единого реестра
они расходятся по владельцам, дублируют правила и незаметно растут. Prompt registry делает
эти слои проверяемыми до запуска модели.

## Контракт

`config/prompts/registry.json` — единственный список проверяемых prompt-слоёв. Каждая запись:

```json
{
  "id": "identity-stable",
  "path": "apps/zcode-cli/packages/core/src/context/sections/identity.ts",
  "maxChars": 18000,
  "required": ["# Depth", "primary sources"]
}
```

- `id` уникален;
- `path` относителен корню репозитория и обязан существовать;
- `maxChars` — бюджет источника в символах; превышение блокирует pre-push;
- `required` — обязательные маркеры, доказывающие, что слой не потерял ключевое правило.

`node scripts/prompt-registry.mjs --check` проверяет бюджеты и маркеры, а также сообщает
о точных длинных строках, повторяющихся в разных слоях. Дубли — warning, потому что
некоторые контракты намеренно повторяются; `--strict` превращает их в ошибку.

## Completion contract

Правило «довести запрошенный объём до конца» принадлежит двум слоям:

- `AGENTS.md` — для всех задач в этом репозитории;
- `COMPACT_CODING_CORE_SYSTEM_PROMPT` — для поведения агента в runtime.

Нельзя останавливаться на первом слое или частичном исправлении. Нужно реализовать весь
запрошенный объём, проверить его, исправить найденное и только затем отчитываться. Partial
допустим только при реальном блокере с evidence и следующим checkpoint.

## Проверки

- `pnpm test:prompt-registry` — unit-тесты линтера.
- `pnpm prompt:check` — текущие бюджеты и маркеры.
- Оба шага входят в `pnpm verify:pre-push`.

## Prompt eval lab

`pnpm prompt:snapshot` фиксирует текущие размеры слоёв в `config/prompts/baseline.json`
(коммит, дата, chars, estimatedTokens). Это статический baseline, а не доказательство качества.

Для поведенческого сравнения используется JSONL с записями:

```json
{
  "taskId": "...",
  "arm": "baseline|candidate",
  "run": 1,
  "success": true,
  "tokens": 1234,
  "cacheReadTokens": 900,
  "durationMs": 5000,
  "quality": 0.8,
  "criticalRegressions": 0,
  "holdout": true,
  "synthetic": false
}
```

`node scripts/prompt-registry.mjs --compare baseline.jsonl --candidate candidate.jsonl` проверяет:
одинаковые задачи, минимум 3 прогона на arm, protected holdout, отсутствие падения success,
критических регрессий и деградации качества >0.05, а также наличие хотя бы одного улучшения
по токенам/времени/качеству. `synthetic: true` даёт verdict `inconclusive`, пока нет реальных
записей.

## Границы

Реестр проверяет источники промптов, а не поведение модели. Eval lab проверяет записи
прогонов, но не запускает модель сам. Он не заменяет живой A/B и независимого grader.
