# Office mode: команда и детали tool call

## Проблема

В `interfaceMode=office` renderers `execute` и `execute-group` показывали только
«Выполняется» / «Команда выполнена»:

- `canToggle` и `forceOpen` принудительно выключались, поэтому карточка не раскрывалась;
- `secondaryText` для execute и `latestCommand` для execute-group очищались, поэтому
  команда не отображалась даже в свёрнутом виде;
- `ToolSnapshotFieldNotice` не рендерился, поэтому нельзя было догрузить поля вызова,
  если они были заменены snapshot-ссылками.

Пользователь не мог понять, какая команда выполняется и что именно запускалось.

## Контракт

- Office mode сохраняет краткие подписи «Выполняется» / «Команда выполнена», но
  команда показывается в summary, если она есть во входе tool call.
- Карточка остаётся раскрываемой: в раскрытом состоянии доступны полный input,
  output и `ToolSnapshotFieldNotice`.
- Execute-group в office mode показывает команду активного дочернего вызова, как и
  обычный режим, и раскрывается в список дочерних tool calls.
- Изменения не затрагивают permission preview и другие места, где `forceOpen`
  задаётся контекстом.

## Приёмка

- `executeToolCallBlock.test.tsx`: office mode содержит `pnpm build`, триггер
  `aria-expanded="false"` и не рендерит детали до раскрытия.
- `executeGroupToolCallBlock.test.ts`: office mode содержит активную команду
  `pnpm test` и раскрываемый триггер.
- В обычном режиме поведение не меняется: существующие тесты execute/execute-group
  проходят без правок ожиданий.
