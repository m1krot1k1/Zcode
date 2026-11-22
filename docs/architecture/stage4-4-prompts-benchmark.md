# Этап 4.4 — Бенчмарк системных промптов и кэшируемого префикса

Документ фиксирует фактические измерения системного промпта до и после инкремента 4.4,
структуру промптов v2, стабильность кэшируемого префикса и метод проверки эффекта на
`cacheReadTokens`. Все числа получены из текущего рабочего дерева; выдуманных значений нет.

## 1. Метод измерений

| Что измеряется | Как | Ограничение метода |
| --- | --- | --- |
| Размер исходников промпта | `node scripts/prompt-registry.mjs --report` | Считает символы файла-источника, а не собранное сообщение |
| Размер собранного identity-секции | `buildIdentitySection(...)` в Vitest-измерении: `section.chars`, `section.tokens` | `section.tokens` — оценка `estimateTokens` из `context/utils.ts` (эвристика, не BPE-токенизатор) |
| Размер блока протоколов | `buildCognitiveProtocolsBlock(profile).length` | Символы готового текста |
| Стабильность префикса | `apps/zcode-cli/packages/core/tests/prompt-cache-prefix.test.ts` | Проверяется побайтовое равенство, не реальный провайдерский cache-hit |

Аппроксимация «1 токен ≈ 4 символа» приведена отдельной колонкой именно как аппроксимация.
Реальный BPE-токенайзер в зависимостях репозитория для всех целевых моделей отсутствует,
поэтому `tokenlens`-оценка не заявляется как факт.

## 2. Состояние `config/prompts/` (проверка целостности)

Ассеты не были удалены предыдущими инкрементами — восстановление из git не потребовалось.

```
git status --porcelain config/prompts   # пусто до правок 4.4
git ls-files config/prompts             # 8 файлов на месте
git log --oneline -5 -- config/prompts
  64df2977 Добавить canary и генерацию skills
  80fc8bf4 Дать каждой роли свой evidence-контракт
  6ec8d18b Стабилизировать 10-task prompt holdout
  7f7b53c2 Расширить holdout, cache guard и skills mining
  85add509 Зафиксировать реальный prompt holdout
```

Состав: `baseline.json`, `registry.json`, `eval/holdout-baseline.jsonl`,
`eval/holdout-candidate.jsonl`, `eval/holdout10-baseline.jsonl`,
`eval/holdout10-candidate.jsonl`, `eval/static-baseline.jsonl`, `eval/static-candidate.jsonl`.

## 3. Измерения до/после

### 3.1 Собранная identity-секция (то, что реально уходит в кэшируемый system-блок)

| Профиль | chars | `estimateTokens` | ≈токенов при 4 симв./токен |
| --- | --- | --- | --- |
| `standard` | 4 925 | 1 642 | 1 232 |
| `deep` | 5 670 | 1 890 | 1 418 |
| `max_reasoning` | 6 339 | 2 113 | 1 585 |

Справочно, компоненты этой секции:

| Компонент | chars |
| --- | --- |
| `SECURITY_NOTICE` | 459 |
| `buildHarnessBlock()` | 1 199 |
| Блок когнитивных протоколов `standard` | 1 765 |
| Блок когнитивных протоколов `deep` | 2 510 |
| Блок когнитивных протоколов `max_reasoning` | 3 179 |

### 3.2 Исходники промптов по реестру

`node scripts/prompt-registry.mjs --report`, после правок 4.4:

```
ok   identity-stable           16077 chars  ~ 4020 tok  budget 18000
ok   cognitive-protocols       11602 chars  ~ 2901 tok  budget 13000
ok   project-instructions       4762 chars  ~ 1191 tok  budget 6500
ok   built-in-profiles         46208 chars  ~11552 tok  budget 56000
ok   compaction-prompt          8304 chars  ~ 2076 tok  budget 10000
ok   deep-task-contract         2301 chars  ~  576 tok  budget 4000
ok   prism-core                 5053 chars  ~ 1264 tok  budget 6500
ok   research-eval-skill        2276 chars  ~  569 tok  budget 4000
ok   bash-tool-description      1480 chars  ~  370 tok  budget 3000
```

До правок (baseline инкремента 1): `identity-stable` 15 732 chars / 3 933 tok,
`built-in-profiles` 44 235 / 11 059. Итоговый стек `config/prompts/eval/static-baseline.jsonl`
= 21 655 токенов (`synthetic: true`), candidate = 21 038.

### 3.3 Что изменилось по существу

| Было (v1) | Стало (v2) |
| --- | --- |
| `# Priorities` 1–6 + `# Depth` + `# Tools` + `# Safety` + `# Done` | `# Repository policy` 1–4 (репозиторные правила) + `# Tools` + `# Safety` + `# Reporting` |
| Проверка/верификация/запрет заглушек — только прозой в `# Done` и `# Priorities` | Вынесены в 5 явных протоколов с заголовками `Protocol 1..5`, покрываемых тестом |
| `# Depth` дублировал пункты верификации из `# Priorities` | Удалён; «глубина» теперь структурирована протоколами и профилем |
| Нет связи с механиками 4.1 | Protocol 5 ссылается на `TOOL_CALL_TRUNCATED_BY_MAX_TOKENS` и self-repair |
| Нет выбора глубины | `promptDepth`: `standard` / `deep` / `max_reasoning` — текст протоколов + `thinking`/`maxOutputTokens` |

Устранённое дублирование подтверждено тестом
`apps/zcode-cli/packages/core/tests/cognitive-protocols.test.ts`:
секция не содержит старой формулировки `# Done\nFinish the requested scope end-to-end`,
не содержит `Verify at the layer you changed`, а строка про необратимые действия
встречается ровно один раз.

## 4. Пять когнитивных протоколов: где живут и как связаны с рантаймом

| # | id | Заголовок | Связь с рантаймом |
| --- | --- | --- | --- |
| 1 | `plan_before_mutation` | Plan and Architecture Before Mutation | Гейт перед `Write`/`Edit`/`MultiEdit`/`ApplyPatch`/мутирующим `Bash` |
| 2 | `invariants_and_edges` | Invariants, Data Contracts, Edge Cases | Требует секцию анализа до правок; в `max_reasoning` — матрица краевых случаев |
| 3 | `evidence_grounded` | Evidence-Grounded Verification | Запрет опоры на вторичные сводки; требует читать реальные файлы/схемы/логи |
| 4 | `self_critique_gate` | Self-Critique and Gate Check | Требует typecheck/lint/tests в затронутом объёме + аудит собственного диффа |
| 5 | `zero_stub_surgical_edit` | Zero-Stub and Surgical Edit Mandate | Запрет заглушек/TODO/`any`; ссылка на `TOOL_CALL_TRUNCATED_BY_MAX_TOKENS` и self-repair из 4.1 |

Все пять присутствуют во всех трёх профилях — профиль меняет строгость формулировок и
бюджет рассуждения, но не отключает проверку. Это зафиксировано тестом
`contains all five protocol headings for every depth profile`.

Порядок секций в собранном system-сообщении:

```
[system #1] cli_prefix                      (без cache_control)
[system #2] stable body + cognitive protocols   (cache_control: ephemeral)
[system #3] "\n\n" + dynamic sections           (cache_control: ephemeral)
```

Протоколы стоят в stable-блоке, потому что зависят только от профиля глубины, а профиль
владеет сессия. Напоминания, todo, дата, память и guidance живут в третьем сообщении.

## 5. Профили глубины и параметры модели

| Профиль | `reasoningEffort` | `thinkingBudgetTokens` | `minMaxOutputTokens` |
| --- | --- | --- | --- |
| `standard` | `medium` | 8 192 | 32 768 |
| `deep` | `high` | 16 384 | 40 960 |
| `max_reasoning` | `max` | 31 999 | 49 152 |

Значения проходят через `resolveReasoningAwareMaxOutputTokens` (инкремент 4.1): резерв
`MIN_TOOL_PAYLOAD_RESERVE_TOKENS = 16 384` под JSON-аргументы инструментов сохраняется,
`thinkingBudgetTokens < minMaxOutputTokens` для каждого профиля (проверяется тестом).

Важно: если `promptDepth` не задан, рантайм использует прежний путь 4.1
(`model.options?.reasoningLevel`), т.е. поведение существующих сессий не меняется молча.

Схема настроек: `promptDepth` в `appSettingsObjectSchema` (default `standard`) и в
`appSettingsPatchSchema`; enum — единый `promptDepthSchema` из `packages/shared/src/prompt-depth.ts`.

## 6. Стабильность кэшируемого префикса

Тест `apps/zcode-cli/packages/core/tests/prompt-cache-prefix.test.ts` фиксирует:

1. Смена динамического контекста (дата, `guidanceToolNames`, `memoryRoot`) не меняет
   стабильное system-сообщение ни на байт.
2. На одной поверхности (`zcode_desktop` + фиксированный `genUiOutputDirectory`) смена
   даты и guidance также не меняет стабильный префикс.
3. Стабильное тело помечено `cacheControl: { type: "ephemeral" }`, динамический блок
   начинается с `\n\n`.
4. Все stable-секции идут до всех dynamic-секций.
5. Два прогона с одинаковым набором входов дают побайтово одинаковые сообщения и одинаковый
   порядок `section.source` (порядок не зависит от порядка массива `guidanceToolNames`).
6. Префикс инвалидируется только при смене `promptDepth` — это осознанный выбор
   пользователя, а не реакция на динамику.
7. Все пять протоколов присутствуют внутри кэшируемого префикса.

Осознанное исключение: секция `desktop_context` имеет `cacheHint: "stable"`, но её
содержимое зависит от `genUiOutputDirectory`, который различается между сессиями. Это
стабильно внутри сессии и меняется только при новом каталоге — префикс не «перетасовывается»
между шагами.

## 7. Ожидаемый эффект на `cacheReadTokens` (расчёт, не выдуманные числа)

Провайдерский prompt caching оплачивает `cache_control`-помеченный префикс один раз
(cache write) и затем читает его по пониженной цене (cache read) при каждом следующем
запросе, пока префикс совпадает побайтово.

Для сессии глубины `deep` стабильный префикс = `cli_prefix` + identity-секция:

```
stable_prefix_tokens ≈ estimateTokens(cli_prefix + identity(deep)) ≈ 1 900–2 000 токенов
```

Расчёт эффекта за сессию из `N` шагов (шаги — модельные запросы внутри одного turn-цикла):

```
без кэша:       N × stable_prefix_tokens              (полная цена)
с кэшем:        1 × stable_prefix_tokens (write) + (N−1) × stable_prefix_tokens × read_discount
экономия       ≈ (N−1) × stable_prefix_tokens × (1 − read_discount)
```

До 4.4 стабильный префикс был меньше (нет блока протоколов, ~0.4–0.8k токенов меньше), но
инвалидировался чаще: любая правка формулировок в `# Priorities`/`# Depth` меняла байты.
После 4.4 префикс больше по размеру, зато стабилен по построению и проверен тестом.
Реальный `read_discount` различается по провайдерам и не измерялся в этом инкременте.

Метод фактической проверки (выполняет Этап 6 на реальном провайдере):

1. Запустить сессию из ≥ 5 шагов на одном `promptDepth`.
2. Собрать `usage.cacheReadTokens` / `usage.cacheWriteTokens` из событий модели
   (`recordModelUsageFact`).
3. Проверить: `cacheWriteTokens > 0` только на первом шаге; на шагах 2..N
   `cacheReadTokens ≈ stable_prefix_tokens`; между шагами 2..N `cacheWriteTokens ≈ 0`.
4. Сменить `promptDepth` и убедиться, что следующий шаг снова даёт cache write
   (префикс легитимно инвалидирован).

До этого измерения утверждения о конкретной экономии в деньгах или процентах не делаются.

## 8. Eval-ассеты

`config/prompts/eval/*` не перегенерировались: holdout-записи описывают поведение агента на
задачах, а не текст промпта. Эквивалентность/улучшение проверяются:

1. Структурно — unit-тестами (`cognitive-protocols.test.ts`, `prompt-cache-prefix.test.ts`).
2. Реестром — `node scripts/prompt-registry.mjs --report` (маркеры и бюджеты).
3. Сравнением пар baseline/candidate — `compareEvalRecords` в `prompt-registry.mjs`
   на задачах `holdout10-*`.

Регрессия success rate в `compareEvalRecords` остаётся жёстким провалом, поэтому прогон
holdout на реальной модели нужен до включения профиля по умолчанию для всех пользователей.
