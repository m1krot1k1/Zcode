# Установка MCP/плагинов с approval и retry

Статус: реализовано 2026-11-15.

## Проблема

После preflight `requires` отсутствующий MCP/plugin только блокировал spawn. У агента не было
легального способа установить capability, а повторный Task не мог пройти preflight. Для skills
есть `SkillInstall`; для MCP/plugin нужен отдельный approval-gated installer.

## Продуктовое правило

1. `InstallCapability` — единственный агентский путь установки MCP/plugin. Он объявлен
   `needsApproval: true`: в обычных permission modes требуется approval, в yolo установка
   выполняется автоматически. Явный deny всё равно блокирует.
2. Вход: `kind` (`mcp`|`plugin`), `id`; для MCP — `config`; для plugin — `marketplace` и/или
   `pluginName` (можно передать id в форме `<name>@<marketplace>`). MCP `config` проходит
   `parseMcpServerConfig` (та же схема, что у файла конфигурации): например, `args` обязан
   быть массивом строк. Неверный config отклоняется до connect и до записи на диск.
3. Handler вызывает host-owned `CapabilityInstallPort`; сам ничего не пишет в конфиг и не
   подключает процессы.
4. `isInstalled` проверяет live MCP status (`connected`) или enabled plugin в discovery;
   успешная установка кэшируется в порту, чтобы немедленный retry видел capability.
5. Успешный результат: `installed` + evidence. Для MCP успех — только `connectServer`
   со статусом `connected`: `failed`/`connecting`/`disconnected` отклоняют установку, не
   кэшируются и не пишутся durable config. Для MCP `requiresReload: false`: сервер
   подключён, его tools входят в live-снимок следующего child/Task (см.
   [mcp-live-snapshot](2026-11-15-mcp-live-snapshot.md)). Для plugin `requiresReload: true`:
   plugin skills/agents/MCP активируются в следующей сессии. Повторная установка
   идемпотентна: `already_installed`.
6. После `capability_missing` родитель вызывает `InstallCapability`, ждёт `installed` и
   повторяет **тот же** Task один раз. Отказ пользователя/ошибка установки → `blocked`, без
   повторных попыток и без подмены capability.
7. Runtime без installer-порта оставляет прежний fail-closed
   `capability_requires_environment`.

## Владелец и порядок

```text
Task(requires: ["mcp:x", "plugin:y"])
        │
        ▼
assertRequiredCapabilities
        ├─ installed → spawn
        └─ missing → CoreError capability_missing (installTool: InstallCapability)
                │
                ▼
InstallCapability (needsApproval; yolo auto, normal ask)
        │
        ▼
CapabilityInstallPort.install
        ├─ mcp: McpPort.connectServer(name, config)
        └─ plugin: installZCodeMarketplacePlugin(...)
                │
                ▼
installed + requiresReload → retry same Task once
```

## До / после

| Сценарий | До | После |
| --- | --- | --- |
| Нужен отсутствующий MCP | spawn blocked, пути установки нет | approval → validate → connect → retry в том же turn |
| Неверный MCP config (`args` не массив) | мог сохраниться и «установиться» | ошибка схемы до connect и записи |
| MCP connect вернул `failed` | отчёт `installed` при мёртвом сервере | ошибка, без cache и durable config |
| Нужен отсутствующий plugin | spawn blocked | approval → install → reload для components |
| Повторная установка | — | `already_installed` |
| Отказ/ошибка установки | — | `blocked` с evidence |
| Runtime без порта | fail closed | fail closed (`capability_requires_environment`) |

## Проверки

- `apps/zcode-cli/packages/core/tests/capability-install.test.ts` — approval metadata,
  делегирование в порт, отсутствие порта.
- `apps/zcode-cli/packages/core/tests/capability-preflight.test.ts` — installed/missing
  MCP/plugin, подсказка `InstallCapability`, fail-closed без порта.
- `apps/zcode-cli/packages/bootstrap/tests/capability-install-port.test.ts` — MCP live
  status/cache, `requiresReload: false`, отклонение неверного config до connect,
  отклонение `failed` без cache и durable config, plugin install/cache и
  `requiresReload: true`, ошибка без installedPlugins.
- `apps/zcode-cli/packages/core/tests/subagent-mcp-live-snapshot.test.ts` — MCP,
  подключённый после старта runtime, виден следующему child без reload.
