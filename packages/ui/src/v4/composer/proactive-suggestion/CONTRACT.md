# ui-composer-proactive-suggestion

UI-модуль проактивной подсказки. Владелец состояния — `createProactiveSuggestionController`.
`useConversationProactiveSuggestion` — адаптер композера: identity-срез, ленивый contextProvider, ref контейнера и рендер подсказки над top content; политику не меняет.

1. Turn завершён (`completedSuccess`), черновик пуст, turn не decided. Подсказку
   запускает только focus/click внутри реального контейнера композера; переход
   phase→completed при уже установленном фокусе сам запрос не создаёт.
2. `focus()`: полученный текст показывается из кэша без запроса; иначе запрос,
   но не более `PROACTIVE_SUGGESTION_MAX_ATTEMPTS` (2) на turn.
3. `blur()`: in-flight отменяется, текст скрывается, но turn НЕ decided; полученный
   текст кэшируется, повторный focus показывает его без запроса.
4. `accept()` (Tab/клик), `Escape` (в том числе во время loading) и первый ввод —
   decided навсегда для turn. Accept заполняет существующий draft, не отправляет и
   возвращает фокус в contenteditable.
5. Смена turn/session, unmount, `disabled` — сброс, отмена и сброс счётчика попыток;
   stale-ответы отбрасываются по sequence id и turn key.
6. `focusout` слушается только на контейнере композера; уход фокуса в другой
   contenteditable не скрывает подсказку.
7. Выключенная настройка/нет сервиса — ноль запросов и пустой рендер.
8. Контекст: реальные строки проекции (userInput/assistantText/toolCall),
   `fileChanges` строк в diffs, открытые code-viewer табы, tool results и test
   results; лимиты messages 8 / openFiles 16 / diffs 6 / toolResults 8 / testResults 4.
