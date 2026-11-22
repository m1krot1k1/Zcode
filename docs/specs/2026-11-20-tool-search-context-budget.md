# ToolSearch: экономия контекста по умолчанию

Статус: **implemented**, 2026-11-20.

## 1. Проблема

Реальный main-turn ZCode отправлял **39 884 входных токена** до начала работы. Из них
**105 263 символа (≈26 300 токенов)** — tool declarations. 41 из 54 инструментов уже
помечены `shouldDefer`, но `toolSearchMode` был `"off"`, поэтому все схемы уходили в
модель. `cacheReadTokens = 0`, то есть каждый следующий шаг повторял этот префикс.

## 2. Контракт

- `toolSearchMode` остаётся трёхзначным: `auto | local | off`.
- `auto` разрешается в:
  - `native`, если provider поддерживает native ToolSearch и включён по умолчанию;
  - `local`, если модель поддерживает tool calls;
  - `off` иначе.
- `local` скрывает deferred-схемы, оставляет `ToolSearch`/`DeferredToolCall` и resident
  tools; MCP-инструменты считаются deferred.
- **Fresh settings** (нет persisted `toolSearchMode`) сохраняют безопасный default `off`.
- **Existing explicit `off`** — это старый default, который нельзя отличить от
  осознанного opt-out. Один раз мигрируем его в `auto` (`toolSearchModeMigrationVersion: 1`).
  После миграции явный `off` пользователя сохраняется навсегда.
- `native` в App settings не появляется; это внутренний resolved mode.
- Миграция идемпотентна: `parse(parse(x)) === parse(x)`.

## 3. Ожидаемый эффект

Измерение на реальном запросе:

|                   | Символов | ≈токенов |
| ----------------- | -------: | -------: |
| Все 54 tool-схемы |  105 263 |   26 300 |
| Deferred (41)     |   69 238 |  ≈18 000 |
| Resident (13)     |   32 904 |   ≈8 200 |

Ожидаемое снижение входа — **≈45%**; фактический выигрыш зависит от того, как часто
модель вызывает `ToolSearch`, и от provider prefix cache. Это гипотеза до A/B, не гарантия.

## 4. Риски

- Модель может хуже вызывать редкие инструменты, пока не сделает `ToolSearch`.
- MCP-инструменты теперь требуют discovery; это ожидаемо, но меняет траекторию.
- Если модель не поддерживает tool calls, `auto` откатывается в `off`.
- Пользователь может вернуть старое поведение: Settings → General → Tool search → Off.

## 5. Тесты

- `packages/shared/test/appSettings.test.ts`: fresh off, existing off → auto once,
  explicit off after migration preserved, invalid modes rejected.
- `apps/zcode-cli/packages/core/tests/tool-search.test.ts`: auto → local/native/off.
- Desktop E2E ToolSearch settings остаётся на явных режимах; default fresh app data
  не меняется.

## 6. Что не входит

- Lazy MCP server connection (схемы скрываются, но серверы могут подключаться).
- Observation masking старых tool-результатов.
- Снижение `workingContextCeilingTokens`.
- Автоматическое включение для fresh install без persisted mode; это отдельное решение
  после A/B.
