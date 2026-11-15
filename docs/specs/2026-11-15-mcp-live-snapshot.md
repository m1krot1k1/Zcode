# Live MCP snapshot для следующего child без reload

Статус: реализовано 2026-11-15.

## Проблема

`InstallCapability` подключал MCP-сервер и писал durable config, но следующий child получал
снимок, зафиксированный в `mcpStartupPromise` при создании runtime. Прямой `connectServer`
не отправляет `notifications/tools/list_changed`, поэтому не менялся и `toolListRevision`.
Итог: `mcp__<server>__<tool>` не появлялся ни у следующего child, ни у родителя до
перезапуска приложения.

## Продуктовое правило

1. `McpPort.currentSnapshot?()` возвращает текущие `statuses` и `tools`, а не снимок старта
   runtime. Adapter реализует его поверх `status()` + `listTools()`.
2. При spawn child runtime строит MCP-access из `currentSnapshot()`, если порт его
   поддерживает. `mcpStartupPromise` остаётся barrier'ом первичной инициализации, а не
   источником истины навсегда.
3. `createBorrowedSubagentMcpAccess` сохраняет server-scope и deny-фильтр на live-снимке.
   Вложенный orchestrator поднимает `currentSnapshot()` к корневому adapter, поэтому MCP,
   установленный его дочерью, виден следующей дочерней задаче на любой глубине.
4. Если порт не реализует `currentSnapshot`, поведение прежнее: используется startup-снимок.
   Ошибка live-снимка логируется и не отменяет spawn; fallback остаётся startup-снимок.
5. Успешный `connectServer` увеличивает `toolListRevision`. На следующем turn boundary
   root runtime перерегистрирует инструменты, даже если сервер подключён из
   `InstallCapability`, а не через `list_changed`. Успехом установки считается только
   статус `connected`: `failed`/`connecting` не попадают в live-снимок и не кэшируются.
6. Для MCP `InstallCapability` возвращает `requiresReload: false` и evidence про следующий
   Task. Для plugin `requiresReload: true` сохраняется: plugin skills/agents/MCP входят в
   startup-набор runtime и активируются в следующей сессии.

## Владелец и порядок

```text
InstallCapability (child, approval/yolo)
        │
        ▼
CapabilityInstallPort.install
        ├─ persistMcpServerConfig
        └─ McpPort.connectServer ──► records + toolListRevision += 1
                │
                ▼
orchestrator spawns next child
        │
        ▼
resolveSubagentMcpAccess
        ├─ await mcpStartupPromise (barrier)
        ├─ mcpPort.currentSnapshot() (live)
        └─ borrowed snapshot = scope/deny filter(live)
                │
                ▼
child registry: mcp__<server>__<tool> доступен без reload
```

## До / после

| Сценарий | До | После |
| --- | --- | --- |
| MCP установлен через InstallCapability | следующий child не видит tools | следующий child видит tools |
| Вложенный orchestrator | видит только startup snapshot | поднимает live-снимок к корню |
| Родитель на следующем turn | registry не обновляется | `toolListRevision` меняется, registry обновляется |
| Порт без `currentSnapshot` | startup snapshot | startup snapshot (без изменений) |
| Plugin | требует reload | требует reload (без изменений) |

## Проверки

- `apps/zcode-cli/packages/core/tests/subagent-borrowed-mcp-port.test.ts` — live-снимок
  фильтруется по scope/deny, вложенный порт видит новый server, frozen snapshot не мутирует.
- `apps/zcode-cli/packages/core/tests/subagent-mcp-live-snapshot.test.ts` — spawn использует
  `currentSnapshot` и видит MCP, подключённый после старта runtime.
- `apps/zcode-cli/packages/bootstrap/tests/capability-install-port.test.ts` — MCP install
  возвращает `requiresReload: false` после успешного `connectServer`.
- `apps/zcode-cli/packages/adapters/src/mcp` — `connectServer` увеличивает revision;
  существующие adapter-тесты покрывают подключение и список tools.
