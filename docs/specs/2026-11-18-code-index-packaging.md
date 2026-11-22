# Упаковка tree-sitter для графа кода

## Проблема

В собранном приложении `app.asar` не содержал `web-tree-sitter` и `tree-sitter-wasms`: проверка `listPackage` по 3.17.128 находила 0 совпадений. При этом `parserPool` загружает оба пакета динамически через `createRequire`, поэтому статический сборщик зависимостей их не видел.

Следствие в интерфейсе индекса:

- `symbols` заполнены текстовым fallback-парсером;
- `refs` и `edges` равны 0, поэтому «Связи» показывают 0;
- индекс выглядит рабочим, но граф и переходы по ссылкам пусты.

Та же причина задела серверный runtime: в архиве `zcode-server-linux-x64.tar.gz` был `web-tree-sitter`, но `tree-sitter-wasms` отсутствовал (0 файлов). `stage.ts` собирает `runtime/node_modules` сканированием bare-спецификаторов, а грамматики резолвятся по пути и в это сканирование не попадают.

## Контракт

- `web-tree-sitter` и `tree-sitter-wasms` входят в `REQUIRED_ASAR_RUNTIME_MODULES` (injection) и в `requiredRuntimeModules` (финальная проверка bundle).
- `stage.ts` добавляет оба пакета в `referencedPackages` явно: серверный runtime обязан содержать `runtime/node_modules/web-tree-sitter` и `runtime/node_modules/tree-sitter-wasms`, даже если сканер bundle их не видит.
- `parserPool` продолжает резолвить грамматики из `app.asar/node_modules`; при недоступности остаётся текстовый fallback, но это больше не штатное состояние пакета.
- `SCHEMA_VERSION` поднят до 4: прежние text-fallback записи без `refs`/`edges` несовместимы с корректным графом и должны быть перестроены при открытии индекса.
- Ограничения сканера сохраняются: файлы больше 1 MiB и файлы, похожие на секреты, не индексируются. Это осознанная защита, а не дефект упаковки.

## Приёмка

- `packages/desktop/test/runtimeModulePackaging.test.ts` проверяет наличие обоих пакетов в двух списках.
- `packages/zcode-server-cli/test/packaging.test.ts` проверяет, что staged-архив содержит `runtime/node_modules/tree-sitter-wasms` вместе с wasm-грамматикой.
- `packages/services/test/code-intelligence/graphConnections.test.ts` собирает реальный индекс по двум TypeScript-файлам и падает, если `refs` или межфайловые `edges` пусты.
- После сборки `listPackage(app.asar)` находит `web-tree-sitter` и `tree-sitter-wasms`.
- В собранном 3.17.129: asar содержит 62 записи `web-tree-sitter` и 41 запись `tree-sitter-wasms`; Electron с `ELECTRON_RUN_AS_NODE` загрузил грамматику из asar и разобрал TypeScript в AST без ошибок.
- После переиндексации на TypeScript-репозитории `refs` и `edges` не равны 0, а поиск по графу возвращает соседей.
- Существующие тесты code intelligence (schema, graph, parseFile) остаются зелёными.
