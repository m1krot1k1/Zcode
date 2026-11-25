# Явный выбор модели не подменяется runtime-дефолтом

Статус: реализовано 2026-11-25.

## Проблема

`createSession.config.modelSelection` — явный выбор модели клиентом. Если применение
этого выбора падало (например, `provider.notInRegistry`), `createSession` ловил ошибку,
писал warning и продолжал первый input. `resolveSubmittedExecutionState` без
`firstInput.modelSelection` брал `runtime.getSessionModelSelection()` — runtime-дефолт.
Пользователь получал ответ не выбранной модели, без ошибки в ответе на команду.

## Правило

- `createSession.config.modelSelection` (структурированный явный выбор) применяется
  до первого input.
- Если применить его не удалось, команда завершается ошибкой, созданная сессия
  удаляется, первый input не отправляется. Runtime-дефолт не подставляется.
- Guarded-режим сохраняет прежнее fail-closed поведение; legacy flat config
  (`provider`/`model`/`thought`) сохраняет опубликованную warn-деградацию.
- Успешное применение оставляет выбор в runtime, поэтому intent первого input несёт
  именно выбранную модель.

## Проверка

- `apps/zcode-cli/packages/bootstrap/tests/v4-native-session-mgmt.test.ts`:
  explicit `config.modelSelection` + `provider_not_in_registry` → reject,
  `deleteSession` вызван, `sendInput` не вызван.
- Тот же файл: успешное применение `config.modelSelection` → `sendInput` получает
  intent с выбранной моделью.
