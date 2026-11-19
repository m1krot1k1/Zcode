# Проактивная подсказка следующей задачи в ConversationComposer

## Назначение

После завершённого turn модели, когда пользователь фокусирует пустой композер, UI
показывает одну короткую подсказку следующей задачи. Подсказка никогда не
отправляется автоматически: пользователь вставляет её Tab или кликом и правит
черновик сам.

## Владельцы

| Состояние                                                  | Владелец                                                                                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Текст подсказки, loading, attempts, кэш по turn            | `useComposerProactiveSuggestion` + `createProactiveSuggestionController` (`packages/ui/src/v4/composer/proactive-suggestion/`)                          |
| Запрос к модели, таймаут, отмена, очистка/валидация ответа | сервис `proactive-suggestion` (`packages/services/src/proactive-suggestion/`), доступен как `services.proactiveSuggestionService` (`complete`/`cancel`) |
| Настройка `proactiveSuggestionSettings`                    | `useSettings()` → `AppSettings` (`settingService`)                                                                                                      |
| Черновик                                                   | `useComposerDraftController` (`text`, `updateText`, `scheduleDraftPersist`), editor — `LexicalChatInputHandle.setText/focus`                            |
| Диффы turn                                                 | `fileTransactionStore` (`selectSessionFileTransactions`)                                                                                                |
| Открытые файлы                                             | side-pane memory (`readProactiveSuggestionOpenFilePaths`)                                                                                               |

Render-процесс не дублирует сервисную очередь: контроллер держит максимум один
in-flight запрос и монотонный `sequence`, устаревший ответ отбрасывается.

## Точка монтажа

`packages/ui/src/v4/ConversationComposer.tsx` вызывает адаптер
`useConversationProactiveSuggestion`
(`packages/ui/src/v4/composer/proactive-suggestion/useConversationProactiveSuggestion.tsx`)
безусловно после `useComposerSendController`; на вход идут реальные поля
композера: `composer` (snapshot, sessionId, workspace identity), `draft`,
`disabled`, `inputApiRef`, `updateText`, `scheduleDraftPersist`,
`topContentNode`.

Адаптер:

1. лениво собирает `contextProvider` в момент старта запроса из актуального
   `snapshotRef`, `fileTransactionStore` и side-pane memory; вычисляет `turnId`
   через `resolveProactiveSuggestionTurnId` и `sessionId`;
2. передаёт сервис, настройку, `sessionId`, `turnId`, `phase`, `draft`,
   `disabled`, `contextProvider`, `labels`, `containerRef`, `onAccept` и
   `focusEditor` в `useComposerProactiveSuggestion`
   (`useComposerProactiveSuggestion.tsx`) — политика и контроллер остаются за
   ним;
3. возвращает `topContentNode` (подсказка над attachment top content) и
   `containerRef`; `ConversationComposer.tsx` передаёт их через `...proactive`
   в `buildComposerRoot`, поэтому `node` рендерится в
   `ChatPromptEditor.topContent` — над строкой ввода, внутри composer surface.

`containerRef` — внешний `<div data-testid={TID_V4_COMPOSER}>` в
`conversation-composer/ComposerRoot.tsx`; только события внутри него гасят
подсказку.

`onAccept(text)`: `inputApi.setText` → `updateText` → `scheduleDraftPersist` →
фокус редактора. Автоотправки и записи в очередь нет.

## Контекст запроса

Собирается лениво (`contextProvider`) в момент старта запроса из актуальных
`snapshotRef`, `fileTransactionStore.getState()` и side-pane memory:

| Поле              | Источник                                                                                                 | Лимит                             |
| ----------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `messages`        | `rows.window`: user/assistant тексты                                                                     | 8 сообщений, 600 символов каждое  |
| `assistantResult` | последний `assistantText` (сравнение kind регистронезависимое)                                           | 1200 символов                     |
| `toolResults`     | `toolCall` (сводка/ошибка, без тестовых прогонов)                                                        | 8, 400 символов                   |
| `testResults`     | тестовые tool-call'ы (`pnpm test`, `vitest`, `jest`, …)                                                  | 4 (`toolName`/`status`/`summary`) |
| `diffs`           | `fileTransactionStore` → `buildProactiveSuggestionTransactionDiffs` (откатанные транзакции пропускаются) | 6, 300 символов                   |
| `openFiles`       | side-pane memory                                                                                         | 16                                |

Строковые поля обрезаются в builder до shared-лимитов (`diffs.summary` — 300,
`toolResults.toolName` — 80, `toolResults.summary` — 400, `testResults.toolName` — 120,
`testResults.status` — 40, `testResults.summary` — 300), поэтому strict-parse получает
уже валидный снимок даже при переполненных исходных строках.

`readProactiveSuggestionRows` нормализует реальные строки проекции. Агрегат
`turnHeader.fileChanges = {files: number}` не является списком файлов и не должен
попадать в диффы; списки берутся из `fileTransactionStore`. Wire-shape и лимиты
принадлежат `packages/shared/src/proactive-suggestion/contract.ts`
(`testResults` входит в контракт запроса).

## События и порядок

1. `phase === completedSuccess`, `draft` пуст, настройка включена, сервис есть.
2. `focusin/click` на contenteditable внутри контейнера → `start()`: attempts+1,
   sequence+1, запрос `complete({requestId, sessionId, turnId, draftEmpty:true, cursor, context})`.
3. `focusout` за пределы контейнера (или focus на другом редакторе)
   → `cancel({requestId})`; in-flight ответ с прежним sequence игнорируется, но
   попытка уже израсходована (anti-loop). Клик внутри контейнера, включая кнопки
   подсказки, не считается уходом.
4. `Escape` показывается/во время loading → `cancel` + скрыть.
5. Успешный ответ → текст в кэше turn; повторный focus показывает его без запроса.
6. `Tab` на editor при показанной подсказке → `preventDefault` + accept; клик по
   подсказке — accept; кнопка dismiss — скрыть.
7. Непустой draft, смена turn, выключение настройки или `disabled` → скрыть и
   отменить запрос. Смена turn сбрасывает кэш и attempts.

Итого запросов не больше двух на turn: in-flight отмена + одна повторная попытка;
третий focus запрос не отправляет.

## Платформы

- Electron: `proactiveSuggestionService` доступен через локальный сервис-аксессор;
  запрос идёт через IPC-host, ответ — один текст.
- Web (включая remote/mobile): всё UI-поведение то же; если аксессор не отдаёт
  `proactiveSuggestionService`, `hasService` = false и подсказка не запрашивается.
  Мобильная раскладка получает тот же `ComposerProactiveSuggestion` над вводом;
  размеры/переносы задаются компонентом, без hover-only действий.
- i18n: `composer.proactiveSuggestion.loading|hint|dismiss`; темы — токены
  `bg-surface`/`text-secondary`, без хардкода цветов.

## Приёмка

- `packages/ui/src/v4/composer/proactive-suggestion/contract.test.ts`: сборка
  контекста, регистронезависимый `assistantText`, нормализация реальных строк,
  лимиты, обрезка строковых полей до shared-схемы, транзакционные диффы.
- `packages/ui/test/proactiveSuggestionHook.test.tsx`: focus/blur/cancel, Escape,
  accept/dismiss, отсутствие запроса при непустом draft/выключенной настройке,
  cap двух попыток, ленивый `contextProvider` в момент запроса, отсутствие
  автоотправки.
- `rg -n "useConversationProactiveSuggestion" packages/ui/src/v4` показывает
  импорт/вызов в `ConversationComposer.tsx`; `useComposerProactiveSuggestion`
  вызывается в `useConversationProactiveSuggestion.tsx`.
