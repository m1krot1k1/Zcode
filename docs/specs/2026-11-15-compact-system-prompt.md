# Компактное системное ядро вместо всегда включённого PRISM

Статус: реализовано 2026-11-15.

## Проблема

PRISM `coding` профиль занимал 9 029 символов (≈42% системного текста) и всегда
добавлялся в identity. Большая часть текста — research/eval и generation-gate методология,
которая не нужна обычной кодовой задаче; evidence/verification частично дублируются
harness-правилами и `AGENTS.md`.

## Продуктовое правило

1. По умолчанию identity использует компактное coding-ядро: роль, приоритеты,
   инструментальная дисциплина, safety, evidence и формат завершения.
2. Полный PRISM `coding` профиль остаётся в identity как A/B baseline и включается
   `ZCODE_SYSTEM_PROMPT_PROFILE=prism`; пересборка для сравнения не нужна.
3. Research/eval методология вынесена в skill `research-eval` и загружается только для
   self-improvement/eval задач.
4. Vendored PRISM source остаётся checksum-verified; генератор проверяет source checksums,
   а identity содержит `PRISM_SOURCE_SHA256`, `PRISM_PROFILE_SHA256` и
   `COMPACT_PROFILE_SHA256`.
5. Компактное ядро не должно дублировать harness/AGENTS.md: один владелец на правило.

## До / после

| | До | После |
| --- | --- | --- |
| Default system prefix | PRISM `coding`, 9 029 chars | compact core, ~2 k chars |
| Research/eval | always-on | `research-eval` skill |
| A/B | только смена исходников | env `ZCODE_SYSTEM_PROMPT_PROFILE=prism` |
| Provenance | PRISM checksums | PRISM checksums + compact digest |

## Проверки

- `node scripts/prism10-runtime-profile.mjs --check` — identity соответствует генератору.
- `node --test scripts/test/prism10-runtime-profile.test.mjs` — full PRISM profile,
  compact prompt, digests и selector.
- `pnpm prism10:check` в pre-push.
- A/B-план: baseline (env=prism) vs candidate (default compact) на одинаковых задачах,
  модели, инструментах и grader; метрики completion/regressions/tool errors/tokens/latency;
  protected holdout; кандидат не меняет тесты.
