# Bash sandbox honesty (вариант B: удаление provider-visible surface)

> Статус: код и тесты обновлены; runtime-проверки **не выполнены** в этой
> сессии (shell недоступен, см. §6). Контекст: R04 и QW1 из
> [`docs/research/2026-11-11-zcode-wide-competitive-research.md`](../research/2026-11-11-zcode-wide-competitive-research.md)
> (`#### R04`, `| QW1 |`).
>
> Предыдущая итерация переописала deprecated-поле как no-op, но продолжала
> показывать его провайдеру и принимать в runtime. Текущий контракт — полное
> удаление sandbox-поля из provider-visible input schema и из handler-а.

## 1. Проблема

В ZCode **нет OS-sandbox для Bash**. Любое поле, которое выглядит как
sandbox-переключатель, создаёт у модели и пользователя ложную гарантию
изоляции. После удаления поля из схемы не остаётся ни «sandbox mode», ни
«dangerously override», ни `sandboxed: true`:

| Поверхность                    | Где                                                                                               | Контракт                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Provider-visible input schema  | `apps/zcode-cli/packages/contracts/src/tools/bash.ts` (`BashInputSchema` → `BashInputJsonSchema`) | Поля нет; object остаётся strict (`additionalProperties: false`)              |
| Runtime input schema           | тот же `BashInputSchema` через `entry.runtimeInputSchema`                                         | Поля нет; legacy-аргумент отклоняется strict-валидацией до handler-а          |
| Provider-visible output schema | `core/src/tool/handlers/bash.ts` (`entry.outputSchema`)                                           | Поля нет (output-проекция удаляет legacy-поле)                                |
| Telemetry                      | `core/src/tool/handlers/bash.ts` (`startBashCommandTelemetry`)                                    | `sandboxed: false` всегда: команда действительно не изолирована               |
| Execution request              | `core/src/tool/handlers/bash.ts` (`createExecutionRequest`)                                       | Внутренний trace: `enabled: false`, `metadata.enforcement: "not_implemented"` |

Наблюдаемый факт: `rg "request.sandbox" apps/zcode-cli/packages/adapters/src/exec`
пуст. Ошибка `sandbox_violation` (`execution.port.ts:163`) не производится ни
одной веткой. Adapter остаётся исполнителем без sandbox-логики.

## 2. Решение (вариант B: удаление)

1. **Provider-visible input не объявляет sandbox.** `BashInputSchema` больше
   не содержит `dangerouslyDisableSandbox`; значит, ни
   `BashInputJsonSchema`, ни runtime-проекция `getTools()` →
   `projectToolModelContract` (`core/src/runtime/methods/config.ts:138-162`,
   `core/src/tool/model-contract.ts:20-33`) не предлагают модели это поле.
   `resolveModelContract` у Bash больше нет: отдельная honest-проекция не
   нужна, когда поля нет вовсе.
2. **Runtime admission отклоняет legacy-аргумент.** `BashInputSchema`
   остаётся `.strict()`; объект со старым `dangerouslyDisableSandbox`
   отклоняется тем же единственным парсером входа до permission, hook-ов и
   handler-а. Отказ приходит как обычная recoverable validation-ошибка
   executor-а, а не как падение процесса.
3. **Handler не парсит и не пересылает поле.** `createBashSandboxTrace`
   больше не принимает вход: внутренний trace всегда
   `{ enabled: false, metadata: { enforcement: "not_implemented" } }`.
   Ни `ExecutionRequest`, ни telemetry, ни permission не зависят от старого
   аргумента.
4. **Телеметрия честная.** `CommandTraceStart.sandboxed` всегда `false`:
   команда не изолирована. `sandboxed: true` не записывается ни на одном
   пути.
5. **Output не эхо-гарантия.** Новый ответ Bash не содержит
   `dangerouslyDisableSandbox`: handler удаляет legacy-поле, которое всё ещё
   проставляет out-of-scope `bash-output.ts`; provider-visible output schema
   записи его не описывает. Runtime `BashOutputSchema` сохраняет optional-поле
   только для чтения старых persisted-результатов.
6. **Поведение выполнения не меняется.** Команда, cwd, timeout, output
   limits, background lifecycle, permission-проверки и read-only
   классификация остаются прежними.

### 2.1. Оставленный legacy-носитель типа

`BashInput` в контракте сохраняет `@deprecated dangerouslyDisableSandbox?`
только как носитель типа для out-of-scope `handlers/bash-output.ts`, который
читает это поле. Поле **не входит** в `BashInputSchema`, не попадает в
provider JSON Schema, не принимается runtime admission, не пересылается в
execution, telemetry или output. После очистки `bash-output.ts` носитель
удаляется отдельным изменением владельца контракта.

## 3. Поток и владелец состояния

```
model tool call / legacy transcript
   │  провайдер больше не видит sandbox-поля;
   │  legacy-аргумент приходит только из старого transcript/hook payload
   ▼
BashInputSchema (.strict)                ← единственный парсер входа
   ├─ без sandbox-поля → parse ok
   └─ с legacy sandbox-полем → recoverable validation error до handler
   ▼
bashHandler (только для валидного входа)
   ├─ permission capability              ← не читает sandbox (его нет)
   ├─ telemetry.startCommand({ sandboxed: false })      ← единственная запись факта
   ├─ ExecutionRequest.sandbox = { enabled:false,
   │                              metadata:{ enforcement:"not_implemented" } }  ← внутренний trace
   └─ executionPort.run(request)         ← adapter не читает request.sandbox
   ▼
BashOutput (без dangerouslyDisableSandbox)
```

Владелец факта «sandbox не реализован» — Bash handler: он единственный
формирует `ExecutionRequest.sandbox` и telemetry-атрибут. Adapter остаётся
исполнителем без sandbox-логики; новые поля не появляются.

## 4. Границы

**В scope:** `apps/zcode-cli/packages/contracts/src/tools/bash.ts`,
`apps/zcode-cli/packages/core/src/tool/handlers/bash.ts`, focused-тесты,
спека.

**Out of scope (не меняется):**

- Реальный OS-sandbox (seatbelt/bwrap/landlock/restricted token) и
  `sandbox_violation`. Это вариант A, отдельная работа.
- Electron renderer sandbox, plugin sandbox, CSP, permission-слой.
- `ExecutionSandboxPolicy.dangerouslyDisableSandbox` в
  `packages/contracts/src/interfaces/execution.port.ts`: внутренний тип
  execution port, не provider-visible; adapter его не читает.
- `BashErrorCode.SANDBOX_VIOLATION` и `ShellPermissionPolicy.sandboxEnabled`
  как внутренние типы без потребителей; удаление — отдельное решение
  владельца контракта.
- `docs/design/v2/tool/04-bash.md` всё ещё описывает sandbox-поле; документ
  должен быть обновлён владельцем дизайн-документа.

## 5. Критерии приёмки

1. Provider-visible `Bash` input schema (путь `getTools()` →
   `projectToolModelContract`, а также `createBashToolEntry()`) не содержит
   `dangerouslyDisableSandbox`; сериализованная схема не содержит строки
   `sandbox`.
2. Provider-visible `Bash` output schema (`entry.outputSchema`) не содержит
   `dangerouslyDisableSandbox` и строки `sandbox`.
3. Runtime `BashInputSchema` отклоняет legacy-аргумент со
   `dangerouslyDisableSandbox` recoverable validation-ошибкой; handler не
   выполняет команду, не стартует telemetry и не формирует
   `ExecutionRequest`.
4. На валидном входе telemetry получает `sandboxed: false`; `sandboxed:
true` не встречается ни в одном тесте.
5. `ExecutionRequest.sandbox` содержит ровно `enabled: false` и
   `metadata.enforcement: "not_implemented"`; сырое значение legacy-входа не
   пересылается.
6. Ответ Bash не содержит `dangerouslyDisableSandbox`.
7. Выполнение и permission-поведение не изменились: команда/cwd/timeout те
   же; guarded-режим по-прежнему требует approval для опасной команды;
   permission capability не зависит от sandbox-аргумента.
8. Negative-тест: сериализованная provider-схема (input и output) не содержит
   `sandbox` / `without sandboxing`.

## 6. Проверка

- Focused regression: `apps/zcode-cli/packages/core/src/tool/handlers/__tests__/bash-sandbox-honesty.test.ts`
  (provider-вход через `projectToolModelContract`, `createBashToolEntry`,
  output-схема, отказ legacy-аргумента до выполнения, telemetry
  `sandboxed`, внутренний trace, отсутствие эха в результате, неизменность
  выполнения/permission).
- Команда (cwd `apps/zcode-cli`):
  `./node_modules/.bin/vitest run packages/core/src/tool/handlers/__tests__/bash-sandbox-honesty.test.ts`
- Typecheck пакета (cwd `apps/zcode-cli/packages/core`): `../../node_modules/.bin/tsc --noEmit`.
- Lint изменённых файлов (cwd `apps/zcode-cli/packages/core`):
  `../../node_modules/.bin/oxlint src/tool/handlers/bash.ts src/tool/handlers/__tests__/bash-sandbox-honesty.test.ts --no-ignore`.

**Статус выполнения:** в текущей сессии все вызовы shell завершались
`spawn /bin/zsh EAGAIN` (включая `node -e` и `node scripts/check-workspace-freshness.mjs`),
поэтому команды выше **не выполнены**. Сборка не подтверждена; требуется
запуск в нормальном окружении.

Отдельно к сбору и резолву тестов:

- Root `vitest.config.ts` включает `packages/*/test/**` и
  `packages/*/src/**/contract.test.ts`, но не
  `packages/*/src/**/__tests__/*.test.ts`. Focused-тест
  `packages/core/src/tool/handlers/__tests__/bash-sandbox-honesty.test.ts` нужно
  запускать явным путём (как в команде выше), иначе он не попадёт в
  default-выборку. То же ограничение действует для package-скрипта
  `packages/core`: `vitest tests` этот файл не собирает.
- `@zcode/contracts` резолвится через `package.json#exports` в `dist/`, а не в
  `src/`. Поэтому focused vitest **требует предварительной сборки**
  `@zcode/contracts` (в `turbo run test` это делает `dependsOn: ["build"]`).
  Без пересборки тест увидит stale `dist` со старым полем и упадёт ложно.
  Корректный порядок: `pnpm --filter @zcode/contracts build`, затем
  `vitest run <path>`. Ни одна из этих команд в текущей сессии не выполнялась.

## 7. Остаточные ссылки

1. `apps/zcode-cli/docs/design/v2/tool/04-bash.md:28,54,107,149` описывает
   sandbox как действующую политику — требует обновления владельцем
   дизайн-документа.
2. `docs/automation-edit-status.md:441` и research-документы упоминают поле в
   историческом контексте; это не provider-facing schema.
3. Runtime `BashOutputSchema` и `BashOutput.dangerouslyDisableSandbox`
   сохраняют optional legacy-поле для чтения старых persisted-результатов;
   provider-visible output schema его не описывает.
4. `adapters/src/exec` не читает `request.sandbox` — подтверждено и
   задокументировано комментарием в `bash.ts`; сам adapter не менялся.
