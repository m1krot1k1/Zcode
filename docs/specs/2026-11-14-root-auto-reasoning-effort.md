# Автоматический reasoning effort у корневой сессии

Статус: реализовано 2026-11-14. Связано с
[относительным классом effort для сабагентов](./2026-11-14-subagent-reasoning-effort-level.md).

Реализация:
`apps/zcode-cli/packages/core/src/runtime/helpers/root-auto-effort.ts` (чистая эвристика),
`runtime/methods/turn-model.ts` (применение на admission), `RuntimeConfig.ui.autoReasoningLevel`
(отключение в конфиге, default true). Тесты: `tests/root-auto-effort.test.ts`.

## Scope

Автоматический выбор reasoning level для обычной задачи в root-сессии (без явного
`/start` и без ручного выбора уровня в композере) и его видимость в чате.

Не входит: выбор модели, изменение глобальной настройки `model.reasoningLevel`,
авто-эскалация посреди turn.

## Продуктовые правила

1. Явный выбор пользователя всегда главнее: если композер или `/effort` задал level,
   авто-режим не переопределяет его в этом turn и в последующих turn сессии.
2. Авто-режим включается настройкой сессии; выключенный режим сохраняет текущее
   поведение (session selection + default модели).
2a. Явность уровня — отдельное session-local состояние, а не «в selection есть
   reasoningLevel». Default модели, workspace preference и значение, унаследованное новым
   session, не считаются явным выбором. Явным считается только действие пользователя:
   `/effort`, `session/setThoughtLevel`, model-config команда со сменой/пином уровня, либо
   level, отличающийся от текущей session selection в присланном submission.
2b. Явность переживает рестарт и холодное восстановление: рядом с
   `runtime/model_selection` пишется core-owned entry
   `runtime/reasoning_level_explicit` (`{ explicit: boolean }`). Старые сессии без этого
   entry сохраняют прежнее поведение: level в selection считается явным (консервативно,
   чтобы не перетереть реальный выбор пользователя).
3. Level выбирается на admission submission по детерминированной эвристике:
   длина/структура запроса, режим (plan/edit), наличие `task_graph`-подобных признаков.
   Первая версия не делает отдельный вызов модели — классификатор не должен добавлять
   латентность и стоимость на каждый turn.
4. Выбранный level валидируется по `supportedLevels` активной модели. Модель без
   уровней — no-op.
5. Смена уровня идёт через существующий `emitModelSelected` + `model_change` marker,
   поэтому композер и timeline обновляются тем же путём, что и ручное переключение.
6. Marker обязан печатать именно level (`X (high) → X (low)` или отдельной строкой),
   а не «X → X». Только смена уровня без смены модели не должна теряться.
7. Авто-выбор не пишет `local_setting(model.reasoningLevel)`: глобальная настройка
   остаётся пользовательской, иначе следующий turn унаследует случайный уровень.
8. Пользователь всегда видит, какой уровень выбран: композер показывает текущий
   level, timeline содержит marker с уровнем, при отключённом режиме — ничего не
   меняется.
9. Смена модели сбрасывает явность уровня: новый level — это default/resolved level
   новой модели, auto снова разрешён. Повторный выбор того же уровня пользователем
   (`/effort max` при уже выбранном max) явность сохраняет.

## Матрица default / explicit / auto

| Источник уровня | explicit | auto может менять |
| --- | --- | --- |
| default модели при создании сессии | нет | да |
| workspace preference / session create без user-пина | нет | да |
| `runtime/model_selection` из нового entry с `explicit: false` | нет | да |
| UI echo level модели, когда у session нет своего level | нет | да |
| `/effort <level>` (в т.ч. до первого сообщения, в т.ч. равный default) | да | нет |
| submission, чей level отличается от session level | да | нет |
| echo текущей session selection | наследует session explicit | по флагу |
| старая сессия без sidecar-entry | да (legacy) | нет |
| смена provider/model | нет | да |
| auto-выбор | нет | да (пересчитывается каждый turn) |

Ограничение core-only версии: клиент, который присылает новый level **только** в submission,
без команды `switchModelConfig`/`setThoughtLevel`, при отсутствии level в session selection
трактуется как echo (auto может пересчитать). Штатный desktop-композер сначала применяет
level командой, поэтому это не меняет `/effort`; протокольный флаг из intent
(`reasoningLevelExplicit`) уже поддержан структурно и позволяет wave 2 закрыть этот случай
без эвристики.

## Персистентность явности

```text
core runtime
  sessionModelSelection ──┐
  reasoningLevelExplicit ─┤
                          ├─ persistRuntimeModelSelection ──> session_entry
                          │      runtime/model_selection        (как раньше)
                          │      runtime/reasoning_level_explicit
                          │        { explicit: boolean, level: string | null }
                          │
resumeFromStore ──────────┘
  sidecar есть, level совпадает  → explicit = sidecar.explicit
  sidecar есть, level не совпал  → explicit = true (selection писала не core-точка,
                                    например bootstrap `/effort` после первого сообщения)
  sidecar нет                    → explicit = (selection.options.reasoningLevel !== undefined)
```

`level` в sidecar — это защита от устаревшего флага: bootstrap пишет только
`runtime/model_selection`, поэтому расхождение уровней означает пользовательскую запись,
которую auto не должен перетирать. Совпадающий уровень — core-запись, флаг валиден.

Sidecar пишется только core-runtime (та же точка, что и selection entry) и не меняет
формат `runtime/model_selection`, поэтому старые сборки, читающие БД, не ломаются, а
новые сборки на старых БД работают по legacy-правилу.

## Ограничения core-only версии (wave 2)

- `session/create` с `thoughtLevel` вызывает тот же `setThoughtLevel`, что и `/effort`;
  core не может отличить workspace-default от явного пина без флага от bootstrap.
  Такой session создаётся explicit до появления протокольного флага
  `thoughtLevelExplicit` (optional, default false) в create-параметрах.
- Model-config команда, присылающая `thought` вместе со сменой модели, по контракту
  v4 считается явным пином (`switchModelConfig`), поэтому auto после неё не включается.
  Смена модели без `thought` сбрасывает explicit и разрешает auto.
- Submission-time `reasoningLevelExplicit` уже принимается рантаймом структурно
  (`readIntentReasoningLevelExplicit`), но bootstrap/UI пока его не заполняют; для
  штатного композера explicit-изменения приходят командой, не submission-ом.

## Владелец состояния и порядок событий

Единственный владелец — core admission корневого turn. UI не классифицирует
сложность и не выбирает level; он только отображает `ModelSelected` и config
projection.

```text
submission (prompt, mode, intent selection, intent explicit?)
        │
        ├─ execution-scoped model? ──> не переопределять
        │
        ├─ level не задан ────────────> auto enabled? ──> heuristic
        │
        ├─ explicit == true ─────────> применить как есть
        │
        ├─ intent level != session ──> explicit := true (пользователь сменил уровень)
        │
        └─ session explicit == false -> auto enabled? ──> heuristic
                                   │
                                   └─> setSessionModelSelection(auto, explicit=false)
                                              │
                                              ├─ persist model_selection + explicit sidecar
                                              ├─ composer config update
                                              └─ model_change marker (с level)
```

## Проверки

- Unit: чистая эвристика (positive/negative/boundary), no-op для модели без уровней,
  explicit selection не перетирается.
- Unit: `resolveExplicitReasoningLevel` — матрица default/explicit/auto, echo, model switch,
  legacyбез sidecar.
- Integration: submission с auto и без auto даёт разные ModelSelected, marker
  содержит level; composer projection обновляется.
- Regression: `/effort` и ручной выбор композера не меняют семантику; `/effort` до первого
  сообщения не теряется (см. `2026-11-15-reasoning-level-persistence.md`).
- Regression: свежая сессия с persisted default `max` получает auto-level и marker;
  UI echo уровня модели при session без своего level тоже получает auto-level;
  стор с `explicit: false` повторяет это после resume; сессия без sidecar сохраняет
  прежнее поведение; смена модели снова разрешает auto.
- Измерение: usage-строки уже содержат `reasoningLevel`; сравнить стоимость на
  завершённую задачу и pass rate до/после.

## Открытые вопросы

- Эвристика первой версии: детерминированная оценка по длине, структуре (списки/заголовки/
  code fence), implementation/complex-маркерам, plan и task_graph-подсказкам. Без вызова модели.
- Auto включён по умолчанию; отключается `ui.autoReasoningLevel: false` в конфиге. Явный
  `reasoningLevel` пользователя всегда главнее.
- Marker использует существующий `ModelSelected`/`model_change`; при повторном auto-выборе
  того же уровня событие не эмитится, поэтому чат не заполняется разделителями.
