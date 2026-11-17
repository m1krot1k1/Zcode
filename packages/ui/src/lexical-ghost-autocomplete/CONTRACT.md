# ui-lexical-ghost-autocomplete

Ghost-text в поле ввода композера: нативная inline-нода Lexical + клавиатура.

Инварианты:

- Подсказка живёт только в `GhostTextNode`. Она не участвует в `getMarkdown()`/`getTextContent()`,
  не копируется (`excludeFromCopy`) и не уходит в отправляемое сообщение до явного принятия.
- Все мутации показа/скрытия идут с тегом `history-merge`: `Ctrl+Z` не отменяет чужую правку.
  Принятие (`Tab`/`ArrowRight`/клик) — обычный шаг истории.
- Приоритеты: `Tab`/`ArrowRight`/`Escape` регистрируются на `COMMAND_PRIORITY_LOW`, поэтому открытые
  панели `/` и `@` (`CRITICAL`) забирают клавиши первыми. Плагин дополнительно уступает им по флагу.
- IME (`compositionstart..compositionend`) полностью блокирует запрос и показ подсказки.
- Решение «спрашивать ли модель» — чистая функция `resolveGhostAutocompleteSkip`: пустой ввод,
  короткий префикс, выделение, открытая панель, IME, курсор не в конце — причины отказа.
- Дебаунс адаптивный (`resolveAdaptiveGhostDebounceMs` из `shared-chat-autocomplete`), устаревший
  запрос отменяется сразу при новом нажатии.

Точки пересечения:

- `useChatAutocomplete` обращается к `IChatAutocompleteService` (services) — UI не зовёт модель сам.
- `LexicalChatInput` монтирует плагин и передаёт `isTriggerPanelOpen` из `SlashCommandPlugin`.
