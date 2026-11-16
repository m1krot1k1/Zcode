# Live-активация плагинов и профилей без перезапуска

Статус: реализовано 2026-11-16.

## Проблема

Два независимых снимка замораживались до конца жизни процесса:

1. `PluginLoadOutcome` резолвился один раз в `create-app-env.ts`. После установки плагина
   его MCP-серверы, skill roots и agent profiles не появлялись в работающем runtime.
2. `createTurnAgentDefinitions` фиксировал профили на старте turn. `subagent-factory`
   писал `.zcode/agents/<name>.md` внутри turn, но следующий `Task` с этим именем
   отклонялся до следующего turn.

## Продуктовое правило

1. Плагин, установленный через `InstallCapability` или Settings, активирует свои
   data-plane компоненты в живом runtime: MCP-серверы, skills, agent profiles.
2. Плагинные MCP-серверы подключаются через тот же `McpPort.connectServer`; успехом
   считается только `status: "connected"`. Уже подключённые серверы не переподключаются.
   При disable/uninstall plugin-owned MCP-серверы отключаются.
3. Plugin skill roots читаются через динамический getter на каждом `discoverSkills`;
   `NodeSkillAdapter` не пересоздаётся. Следующий child видит новый skill без reload.
4. `loadAgentDefinitions` читает текущий plugin catalog, а не startup snapshot. После
   plugin refresh definitions перезагружаются; новый plugin agent доступен следующему
   `Task` в том же turn.
5. `subagent-factory` после терминала получает тот же refresh definitions. Родитель
   видит созданный профиль в следующем model step того же turn; agent listing
   пересобирается на каждом model step, поэтому отдельный synthetic reminder не нужен.
6. Refresh definitions ограничен двумя триггерами: терминал `subagent-factory` и
   plugin install/enable/disable/uninstall. Обычное редактирование профилей по-прежнему
   применяется со следующего turn; turn-freeze не отменяется.
7. Hooks, plugin commands и plugin UI по-прежнему применяются в следующей сессии.
   Это security/renderer слой; live-refresh для них не входит в этот change.
8. Refresh идемпотентен и сериализован: параллельные вызовы делят один refresh
   promise; ошибка одного компонента не откатывает уже активированные остальные, но
   возвращается в evidence.

## Владелец и порядок

```text
InstallCapability(plugin) / Settings plugins/install
        │
        ▼
installZCodeMarketplacePlugin (durable config + cache)
        │
        ▼
PluginRuntimeCatalog.refresh()  ← единственный владелец текущего PluginLoadOutcome
        ├─ diff mcpServers: added / removed
        ├─ runtime.applyPluginMcpServers(added/removed)
        │     ├─ connect added через McpPort (status connected)
        │     └─ disconnect removed plugin-owned servers
        ├─ skillPort getExtraResolvedRoots() → current().skillRoots
        └─ runtime.reloadAgentDefinitions()
                │
                ▼
следующий child/Task видит plugin MCP/skills/agents без reload
```

```text
subagent-factory terminal
        │
        ▼
parent runtime.reloadAgentDefinitions(trace, signal)
        │
        ▼
next model step: agent listing + Agent tool admission видят новый профиль
```

## До / после

| Сценарий | До | После |
| --- | --- | --- |
| Agent install plugin | skills/agents/MCP только после reload | data-plane сразу |
| Settings install/enable plugin | только после reload | data-plane сразу |
| Disable/uninstall plugin | stale MCP/skills/agents до reload | plugin-owned MCP отключён, skills/agents исчезают |
| subagent-factory → Task в том же turn | unknown agent type | профиль доступен |
| Обычное редактирование профиля | следующий turn | следующий turn (без изменений) |
| Plugin hooks/commands/UI | reload | reload (явно вне scope) |

## Проверки

- `capability-install-port.test.ts` — plugin install вызывает refresh callback и
  возвращает активационный результат.
- `plugin-runtime-catalog.test.ts` — refresh перечитывает config, diff MCP и
  сериализует параллельные вызовы.
- `subagents.test.ts` / `subagent-runtime-refresh.test.ts` — локальный loader и
  factory refresh.
- `subagent-mcp-live-snapshot.test.ts` — plugin MCP появляется в next child.
- Live: `InstallCapability` plugin → `mcp__plugin_...` tool в новой сессии;
  `subagent-factory` → `Task(<new-profile>)` в том же turn.
