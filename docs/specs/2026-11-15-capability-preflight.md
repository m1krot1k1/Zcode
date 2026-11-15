# Жёсткий preflight capability перед спавном

Статус: реализовано 2026-11-15.

## Проблема

Правило «установи skill/MCP/plugin, если его нет» жило только в промптах. Модель могла
заявить, что установит возможность, но запустить ветку без неё; для MCP/plugin отдельного
модельного инструмента установки нет. Нужен runtime-gate, который не зависит от
добросовестности модели.

## Продуктовые правила

1. `Task`/`Agent` принимает `requires: string[]`:
   `skill:<name>`, `mcp:<server>`, `plugin:<id>`.
2. Перед спавном runtime проверяет требования:
   - `skill:` — через `SkillPort.discoverSkills`; отсутствующий skill отклоняет spawn
     с `agent_capability_missing` и указанием `SkillInstall`;
   - `mcp:`/`plugin:` — fail closed с `agent_capability_requires_environment`: они
     подключаются средой, а не Task;
   - неизвестный синтаксис — отклоняется.
3. Отказ означает «ветка не запущена», а не «ветка упала». Родитель обязан устранить
   capability gap и повторить тот же Task; повторять неизменённый вызов нельзя.
4. Проверка fail closed: если registry недоступен или discovery бросил ошибку, spawn
   отклоняется, а не пропускается.
5. `requires` не расширяет полномочия: проверяется только наличие, не загружает skill и
   не меняет allowlist.

## Владелец и порядок

```text
Task/Agent input { requires }
        │
        ▼
assertRequiredCapabilities (core handler)
        ├─ skill: discoverSkills → all present → launch
        │                       └─ missing → CoreError capability_missing (no spawn)
        ├─ mcp:/plugin: → CoreError capability_requires_environment (no spawn)
        └─ unknown → CoreError capability_missing (no spawn)
```

## До / после

| Сценарий | До | После |
| --- | --- | --- |
| Нужен отсутствующий skill | ветка могла стартовать | spawn отклонён до установки |
| `skill:` установлен | — | spawn разрешён |
| `mcp:`/`plugin:` в Task | молчаливое продолжение | fail closed с инструкцией среды |
| Registry недоступен | не проверялось | spawn отклонён |

## Проверки

- `apps/zcode-cli/packages/core/tests/capability-preflight.test.ts` — отсутствие
  requirements, installed/missing skill, MCP/plugin, неизвестный синтаксис, отказ registry.
- `assertRequiredCapabilities` вызывается в `agentHandler` до любых проверок ролей и
  `subagentPort.launch`.
