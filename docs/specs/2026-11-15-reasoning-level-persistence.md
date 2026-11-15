# Сохранение reasoning level до первого сообщения

Статус: реализовано 2026-11-15 (core + bootstrap adoption).
Связано с [auto reasoning effort](./2026-11-14-root-auto-reasoning-effort.md).

## Проблема

`/effort <level>` (и `session/setThoughtLevel`, и model-config команда) до первого
сообщения пытался записать `runtime/model_selection` entry в ещё не созданную сессию.
`session_entry.session_id` имеет `references session(id) on delete cascade`, а desktop-host
создаёт draft-session с `persistence: "deferred"` (строка `session` появляется только при
первом сообщении). В результате:

- `~/.zcode/cli/log/zcode-2026-11-15.jsonl`: 4 пары
  `session.model_selection.persist_failed` (`module: "bootstrap"`,
  `context.error: "FOREIGN KEY constraint failed"`, `thoughtLevel: "low"`) в 09:52:45,
  09:59:09, 10:13:15, 10:15:51 UTC;
- выбор жил только в памяти runtime/cli-default и не был durable: завершение процесса до
  первого сообщения теряло уровень, а БД не содержала выбора для только что созданной
  сессии.

## Продуктовое правило

1. `/effort` до первого сообщения обязан примениться к сессии и сохраниться. Запись
   `runtime/model_selection` выполняется только после того, как строка `session` реально
   создана; до этого выбор удерживается в runtime state и записывается штатным
   `persistSession` при создании сессии / первым submission.
2. Ошибка `FOREIGN KEY constraint failed` не является ожидаемым путём: в успешном сценарии
   `session.model_selection.persist_failed` не появляется.
3. Старые сессии не меняют поведение: восстановление читает существующий entry как раньше.
4. Отказ реального storage не приводит к тихой потере: уровень остаётся в runtime state,
   пишется `warn` (`session.model_selection.persist_failed`), команда не притворяется
   успешно сохранённой в БД. Следующий штатный persist получает актуальный выбор.

## Владелец состояния и порядок событий

Владелец session-local выбора — core runtime (`sessionModelSelection`). Единственный
write-path session entry — `persistRuntimeModelSelection` в core. Bootstrap
(`apps/zcode-cli/packages/bootstrap/src/app/session-facade.ts`,
`persistSessionModelSelection`) обязан не писать напрямую до `runtime.isSessionPersisted()`;
guard применён в `session-facade.ts` (draft-session → запись откладывается до core
`persistSession`).

```text
/effort / session.create(thoughtLevel)
        │
        ▼
bootstrap SessionFacade.setThoughtLevel
        │  setSessionModelSelection(selection)
        ▼
core runtime (единственный владелец sessionModelSelection)
        │
        └─ sessionRowCreated === false ──> запись отложена (нет FK)
        │
        └─ sessionRowCreated === true  ──> saveSessionEntry(runtime/model_selection)
                                                │
первое сообщение → ensureSessionPersisted → createSession (row exists)
                                                │
                                                └─ persistSession пишет актуальный
                                                   sessionModelSelection явно
```

Bootstrap adoption (применено):

```ts
// session-facade.ts, persistSessionModelSelection
const selection = readUserModelSelection(deps);
if (!selection) return;
// draft-session ещё не имеет строки session → FK на session_entry.session_id.
if (!deps.runtime.isSessionPersisted()) return;
```

`sessionRowCreated` ставится в `true` сразу после успешного `sessionStore.createSession`
и в `resumeFromStore` (строка уже существует). `sessionPersisted` остаётся семантикой
«сессия полностью инициализирована» и не используется как условие FK.

Параллельные первые сообщения и `/effort` во время создания сессии не теряются: все
записи сериализуются, каждая читает актуальный `sessionModelSelection` при выполнении, а
`ensureSessionPersisted` по-прежнему объединяет одновременные создания в один
`createSession`. Повторная запись использует тот же id
`<sessionId>:runtime-model-selection` (upsert), поэтому идемпотентна.

## Интерфейсы

- `SessionFacade.persistSessionModelSelection` не пишет в store, если
  `runtime.isSessionPersisted()`/`isSessionRowCreated()` ещё false.
- Внутренний `persistRuntimeModelSelection` (core) проверяет `sessionRowCreated` и является
  единственной точкой записи entry `runtime/model_selection` из runtime.
- `sessionStore.sessionEntries({ sessionID, type: "runtime/model_selection" })` —
  существующий путь чтения; формат не меняется.

## До / после

| Сценарий | До | После |
| --- | --- | --- |
| `/effort low` в draft-сессии | FK warn, durable записи нет | запись при создании сессии, warning отсутствует |
| Первое сообщение после `/effort` | уровень применялся из памяти | уровень применяется и сохраняется |
| Процесс закрыт до первого сообщения | выбор потерян | выбор сохранён при создании сессии, пока процесс жив; при аварийном завершении до создания сессии — не durable (принято) |
| Ошибка storage | warn, тихая потеря durable | warn, выбор остаётся в памяти и пишется следующим persist |

## Acceptance-сценарии

1. Новая draft-сессия → `/effort low` → первое сообщение: в `session_entry` появляется
   `runtime/model_selection` с `reasoningLevel: "low"`, лог не содержит
   `session.model_selection.persist_failed`, запрос уходит с `effort: "low"`.
   (Bootstrap adoption выше применён: прямой writer не вызывается до создания строки.)
2. `/effort` после первого сообщения: одна upsert-запись, повторные вызовы не создают
   дубликатов.
3. Старая сессия без entry: восстановление не падает, поведение прежнее.
4. Storage mock с FK-ошибкой: команда остаётся успешной в runtime, пишется warn, следующий
   persist сохраняет выбор.

## Проверки

- Core regression: `apps/zcode-cli/packages/core/tests/reasoning-level-selection.test.ts` —
  запись до создания строки не вызывает store; после `createSession` пишет выбор;
  повторная запись идемпотентна; sidecar явности пишется/читается.
- Bootstrap regression: `session-facade.test.ts` — pre-session `/effort` не
  вызывает `saveSessionEntry` напрямую.
