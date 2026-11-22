# Ограничение диагностических ошибок модели (R06)

Статус: реализовано. Основание: `docs/research/2026-11-11-zcode-wide-competitive-research.md` §R06.
Уточнение 2026-11-11 (ветка qw4-serialize): байтовый бюджет строки принудительно
применяется в `serialize.ts` (было: `context` копировался целиком, лимит
обеспечивался только владельцами проекций).

## 1. Проблема и доказательство

`turn.failed` в core передаёт в `logger.error` исходный `coreError`. Цепочка `cause`
содержит `AiSdkModelAdapterError.context.responseBodySummary`, а тот в
`detectProviderBusinessFinishError` формировался как `candidates.find(hasBusinessSignal)`,
то есть как целый finish/error chunk вместе с вложенным request body
(`input`, `messages`, `tools`). `adapters/src/logging/serialize.ts` копирует
`error.context` без ограничения размера, поэтому `JSON.stringify` одной записи
`zcode-<date>.jsonl` достигал 1.46 MB; этот же файл попадает в support bundle.

Воспроизведение из исследования: `~/.zcode/cli/log/zcode-2026-11-11.jsonl`
(строки 1 464 477 / 1 464 655 B).

## 2. Владелец и границы

| Слой                                                 | Ответственность                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| adapters model (`provider-finish-business-error.ts`) | единственный owner формы `responseBodySummary` для `ProviderBusinessError`: безопасные метаданные + байтовый бюджет                                                                                                                                                                                                     |
| adapters logging (`serialize.ts`)                    | единственный writer JSONL и единственная точка принудительного байтового бюджета: `serializeLogError` ограничивает error-кадр, `toSerializableEntry` → `boundSerializedEntryLine` ограничивает всю строку; `DefaultLogRedactor` остаётся key-based (по `authorization`, `token`, `secret`, …) и применяется до усечения |
| core runtime (`turn-errors.ts`)                      | только потребитель: в `logger.error` уходит ограниченная проекция ошибки с безопасными кадрами cause; `projectExecutionErrorPayload` не меняется                                                                                                                                                                        |

Единственный контракт строки объявлен в adapters logging: `LOG_LINE_MAX_BYTES =
32_768` (`serialize.ts`), потому что этот модуль — единственный writer JSONL. Из
него выводятся `LOG_ERROR_FRAME_MAX_BYTES = 32_768 − 4_096`, бюджет context-кадра,
identity/message/stack-лимиты и запас строки под timestamp/level/message/context
вне error-кадра. adapters model объявляет совпадающий по значению
`PROVIDER_ERROR_DIAGNOSTIC_MAX_BYTES = 32_768` для своей сводки, а core-лог
ограничивает свою проекцию тем же числом (`TURN_ERROR_LOG_MAX_BYTES = 32_768`),
не вводя нового числа строки.

```
provider chunk ──► detectProviderBusinessFinishError
                     ├─ candidates.find(hasBusinessSignal)  ← только выбор сигнала
                     └─ summarizeProviderBusinessSignal  ← owner безопасной формы
                             ├─ scalars/keys/request id/status
                             ├─ sourceBytes (размер исходного body)
                             └─ value redaction → ≤2 KiB truncation → marker
                                   │
core: appendTurnOutcomeEvent ──────┘
   logger.error(message, createTurnErrorLogView(coreError, projection))
        └─ value redaction → name/message/code/type/stack + allowlist-скаляры каждого кадра cause;
           глубина ≤8, identity ≤128 B, общий бюджет 32 KiB,
           при вытеснении causeTruncated/logViewTruncated
              │
adapters logging: key-based redactor → bound error frame → bound line → zcode-*.jsonl
                     (одна строка ≤ 32 768 B, enforcement point — serialize.ts)
```

## 3. Правила

1. Полный request/response body не пишется в JSONL и support bundle никогда.
2. В `responseBodySummary` сохраняются только безопасные метаданные:
   `keys` (имена ключей верхнего уровня, без секретов), скалярные поля
   `success`, `code`, `error_code`, `providerCode`, `request_id`, `requestId`,
   `status`, `statusCode`, `responseStatus`, `providerId`, `providerRequestId`,
   `msg`/`message`/`providerMessage`/`type`, вложенный `error` с теми же скалярными
   полями и `type`, а также `sourceBytes` — размер исходного body в UTF-8 байтах.
3. `sourceBytes` считается по `JSON.stringify(record)`; при несериализуемом
   (циклическом/`bigint`) body поле отсутствует — это не ошибка.
4. Каждая сериализованная строка JSONL ≤ 32 768 байт. Для этого:
   - enforcement point — `adapters/src/logging/serialize.ts`, потому что он
     единственный пишет JSONL. `serializeLogError` собирает кадр и прогоняет его
     через `fitErrorFrameToBudget`: контекст копируется в JSON-безопасную форму с
     ограничениями глубины (8), числа узлов (512), записей (64), элементов массива
     (32) и длины строк (1 024 B); при усечении ставится
     `contextTruncated: true`. Затем кадр измеряется по итоговому
     `JSON.stringify` и детерминированно сжимается: сначала отбрасывается самый
     глубокий cause с `causeTruncated`, затем stack с `stackTruncated`, затем
     context сжимается до 512 B, затем message до 128 B, затем context удаляется;
     в крайнем случае остаётся identity + `logFrameTruncated`. Поэтому вложенные
     массивы/объекты не могут обойти бюджет: считаются байты финальной
     сериализации, а не отдельные значения;
   - `toSerializableEntry` страхует строку целиком (`boundSerializedEntryLine`):
     при превышении `LOG_LINE_MAX_BYTES` сжимается context записи до 4 KiB,
     затем message до 2 KiB/256 B, затем context удаляется с
     `logLineTruncated: true`. Структурные поля журнала (`timestamp`, `level`,
     `event`, `module`, `message`) сохраняются до последнего;
   - `name`, `message` и `stack` кадра усекаются по UTF-8 байтам с маркером
     `[truncated: N bytes]` (256 B / 2 048 B / 4 096 B соответственно); identity
     ошибки (`code`, `type`) ограничены 256 B **без** маркера: маркер внутри
     бизнес-кода сломал бы сопоставление кодов, а факт усечения виден по длине;
   - `responseBodySummary` ≤ 2 048 B; поля добавляются в детерминированном
     порядке, и самое дорогое поле вытесняется, пока бюджет не соблюдён, с
     `summaryTruncated: true`; `sourceBytes` добавляется первым и сохраняется;
   - core-лог-проекция ошибки ограничена `TURN_ERROR_LOG_MAX_BYTES` = 32 768 B
     (сам error-объект ≤ 28 672 B с запасом на остальные поля строки): cause-цепочка
     сохраняется (docs/design/v2/logging.md), но только с allowlist скалярных полей;
     при переполнении детерминированно отбрасывается самый глубокий cause
     (`causeTruncated`), затем stack (`stackTruncated`), затем хвостовые поля
     context, затем message; в крайнем случае остаётся identity и `logViewTruncated`;
   - identity-поля кадра (`name`, `code`, `type`) ограничены
     `TURN_ERROR_LOG_IDENTITY_MAX_BYTES` = 128 B: иначе провайдерский `code`/`name`
     в килобайты сам выводит строку за бюджет, а message-shrink и hard fallback
     его не уменьшают;
   - identity самой ошибки (`providerCode`, `providerRequestId`) ограничены
     `PROVIDER_IDENTITY_MAX_BYTES` = 128 B без маркера: они попадают в
     `AiSdkModelAdapterError.context`, который adapters logging дополнительно
     ограничивает своим бюджетом;
   - текстовые поля ограничены по UTF-8 байтам, а не по UTF-16 code units.
5. Порядок операций фиксирован: **сначала маскировка значения, затем усечение по бюджету.**
   Обратный порядок оставляет в обрезанном префиксе первые байты секрета
   (`Authorization: Bearer sk-…`), а `DefaultLogRedactor` ищет только имена ключей
   и такой свободный текст не очистит. Значения `message`/`providerMessage`/`msg`/`code`
   (`responseBodySummary`, `providerMessage` самой ошибки и core-проекция) проходят
   value-level маскировку: echo заголовка `authorization`, `Bearer`/`Basic`,
   форматы `sk-`/`gh*_`/`AKIA`/`AIza`, `api-key|token|password|secret|credential = value`.
   Токен после `Bearer`/`Basic` маскируется, если содержит хотя бы один
   не-буквенный символ, чтобы обычная фраза `basic authentication` не стала
   `[redacted]`. Маскировка детерминированная, не меняет структуру allowlist
   и применяется только к копии для лога.
6. Усечение детерминированное: результат не зависит от времени/окружения,
   маркер ` [truncated: <originalBytes> bytes]` содержит исходный размер
   в байтах (после маскировки), а суммарная длина усечённого значения ≤ бюджета.
7. UTF-8 не режется посередине символа: откат выполняется по
   continuation-byte (`0b10xxxxxx`), поэтому результат не содержит
   replacement-символов `U+FFFD` для валидного входа.
8. Заголовки авторизации и секреты не логируются никогда:
   - `responseBodySummary` не копирует значения объектов (в том числе
     `headers`/`authorization`), только whitelisted скаляры и имена ключей,
     а имена, совпадающие с `authorization|api-key|cookie|credential|password|secret|token`,
     исключаются из `keys`;
   - `responseHeaders` на `ProviderBusinessError` проходят через существующий
     `sanitizeModelNetworkHeaders` (значения секретных заголовков заменяются
     `[redacted]`, `retry-after`/`x-should-retry` сохраняются для retry);
   - core-проекция для лога не копирует исходные `context`/`cause` объекты:
     из каждого кадра берутся только allowlist скаляры, поэтому вложенные
     `headers`/`data`/`responseBodySummary` туда не попадают.
9. Обычные ошибки не меняются: короткая `ProviderBusinessError` сохраняет
   `providerCode`, `providerMessage`, `responseStatus`, `statusCode`;
   core-запись сохраняет `name`, `message`, `code`, `type`, `stack` исходной
   ошибки (в пределах границ), а `projectedError` публикуется как раньше.
   `serializeLogError` для обычной ошибки возвращает ровно `name`/`message`/
   `code`/`type`/`context` (и `stack` при `includeStack`) без маркеров усечения.
10. Порядок операций в adapters logging: **key-based redaction → байтовый бюджет
    кадра → усечение context/stack/message → байтовый бюджет строки.** Редакция
    выполняется до любого усечения: `DefaultLogRedactor` маскирует значения по
    именам ключей, иначе обрезка могла бы сохранить префикс секрета, который
    редактор ещё не тронул.
11. Логирование не бросает исключений: бросающий getter/Proxy в `context` даёт
    `{ contextUnserializable: true }`, сбой сборки кадра — `ErrorLogUnserializable`,
    сбой редактора на уровне записи — маркер `[Unserializable]`. Эти маркеры
    ограничены теми же бюджетами.

## 4. Сценарии приёмки

| #   | Сценарий                                                                           | Ожидание                                                                                                                             |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | finish chunk с `input`/`messages`/`tools` и уникальным маркером prompt             | маркер отсутствует в `responseBodySummary` и в сериализованной строке; `keys` не содержит `input`/`messages`/`tools`                 |
| 2   | тело с `headers: { Authorization: "Bearer …" }`                                    | значение секрета отсутствует в summary и в строке                                                                                    |
| 3   | длинное текстовое поле (multibyte, > 32 768 B)                                     | строка ≤ 32 768 B, маркер содержит исходный размер, нет `U+FFFD`                                                                     |
| 4   | обычный business error (`code`/`message`/`request_id`)                             | поля сохранены, строка не усечена                                                                                                    |
| 5   | core `appendTurnOutcomeEvent` с `cause`, содержащим полный body                    | лог-строка ≤ 32 768 B, содержит безопасный cause-кадр с `providerCode`/`statusCode`, не содержит prompt/секрет/`responseBodySummary` |
| 6   | core обычная ошибка                                                                | `message`/`code`/`type` не изменились                                                                                                |
| 7   | `providerMessage` длиннее бюджета и начинается с `Authorization: Bearer <secret>`  | после усечения секрета нет ни в префиксе, ни в маркере; маркер `[truncated: …]` присутствует                                         |
| 8   | core-кадр с `message`/`code`/`name`, начинающимися с секрета, и размером > бюджета | секрет замаскирован до усечения; identity ≤128 B; строка ≤ 32 768 B                                                                  |
| 9   | core-кадр с `code`/`type`/`name` в 10 000 B                                        | строка ≤ 32 768 B; identity усечены с маркером, hard fallback не обязателен                                                          |
| 10  | finish chunk с `providerCode`/`request_id` в 10 000 B                              | `ProviderBusinessError.providerCode`/`providerRequestId` ≤128 B, строка ≤ 32 768 B                                                   |
| 11  | обычная ошибка `serializeLogError` (`name`/`message`/`code`/`type`/малый context)  | кадр равен входу, маркеров усечения нет                                                                                              |
| 12  | context 1 MB в `AiSdkModelAdapterError`                                            | кадр ≤ 28 672 B, `contextTruncated: true`, скаляры (`providerCode`, `statusCode`) сохранены, строка ≤ 32 768 B                       |
| 13  | вложенные массивы/объекты суммарно 1 MB                                            | бюджет считается по итоговому JSON, строка ≤ 32 768 B, `contextTruncated: true`                                                      |
| 14  | 24 cause-кадра с длинными `message`/`context`                                      | кадр ≤ 28 672 B, есть `causeTruncated`/`ErrorCauseDepthLimit`, корневые `name`/`message` сохранены                                   |
| 15  | чувствительный ключ (`apiKey`, `authorization`, `token`) + 500 KB значения         | редакция применена до усечения, секрета нет ни в context, ни в строке                                                                |
| 16  | циклический context и циклический cause                                            | сериализация не бросает, `[Redacted:Circular]`/`ErrorCauseCircularReference`, бюджет соблюдён                                        |
| 17  | multibyte context (200 000 × `😀`)                                                 | кадр ≤ 28 672 B, нет `U+FFFD`                                                                                                        |
| 18  | большой context самой записи журнала (не error)                                    | строка ≤ 32 768 B                                                                                                                    |
| 19  | большой error-кадр + большой payload-context записи                                | строка ≤ 32 768 B, `error.name` сохранён, `logLineTruncated` не выставлен                                                            |

## 5. Коллекция регрессий

Регрессионные тесты R06 лежат рядом с исходниками в `src/**/__tests__/` и не
попадали ни в корневой `vitest.config.ts` (он не покрывает `apps/zcode-cli`), ни в
`apps/zcode-cli/vitest.config.ts`. В `apps/zcode-cli/vitest.config.ts` они
подключены явными путями (не широким глобом `src/**/__tests__`):

- `packages/adapters/src/model/__tests__/provider-finish-business-error.redaction.test.ts`
- `packages/core/src/runtime/helpers/__tests__/turn-errors.redaction.test.ts`
- `packages/core/src/tool/handlers/__tests__/bash-sandbox-honesty.test.ts`

Бюджет строки адаптера проверяется новым
`packages/adapters/tests/logSerializeBounds.test.ts` (собирается существующим
`packages/*/tests/**` правилом).

Запуск: `cd apps/zcode-cli && npx vitest run <path>`. Это единственный конфиг,
который видит `src/**/__tests__`; скрипт пакета `vitest tests` по-прежнему
фильтрует только `tests/`, поэтому перечисленные файлы запускаются явным путём
или полным прогоном из `apps/zcode-cli`. Широкий глоб `src/**/__tests__` не
включён намеренно: он подтянул бы не относящиеся к R06 исходники.

## 6. Остаточные пробелы

- `adapters/src/model/runner-diagnostics.ts` (`summarizeRawFinishChunkPreview`)
  ограничивает preview 2 048 символами `JSON.stringify(...).slice`, то есть
  UTF-16 code units, а не байтами: строка бюджета там не проверяется. Это
  отдельный payload, не error-кадр, и в текущей задаче не менялся.
- `adapters/src/model/model-execution.ts` ограничивает
  `OPENCODE_DIAGNOSTIC_BODY_MAX_BYTES = 8_192` при чтении тела, но его
  `sanitizeOpenCodeDiagnosticMessage` режет по `.slice(0, 280)` (code units) без
  явного байтового бюджета строки.
- Оба места остаются явными пробелами: исправление требует изменения владельцев
  этих модулей и не входит в enforcement point `serialize.ts`.

## 7. Вне области

Retry-решения, формат `/report`, OTel-экспорт, серверная очистка истории,
изменение `DefaultLogRedactor` и ротации JSONL.
