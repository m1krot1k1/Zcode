# Агенты из установленных навыков

Статус: **implemented**, 2026-11-20.

## 1. Назначение

Пользователь ставит навык из `skills.sh` и ожидает, что рядом появится
специализированный агент, который этот навык использует. Навык без агента остаётся
«текстом в каталоге»: модель может его не выбрать, а в Settings не видно, кто им владеет.

Контракт: **успешная установка marketplace-навыка создаёт user-scope агента с тем же
именем и сохраняет его на диск**, чтобы он был доступен в следующих сессиях.

## 2. Инварианты

- **I1. Имя = имя навыка.** `frontend-design` → агент `frontend-design`.
- **I2. Сохранение на диск.** Профиль лежит в `~/.zcode/agents/<name>.md`, а не только
  в памяти. Он переживает перезапуск и виден в Settings → Subagents.
- **I3. Навык подключён.** В `skills` профиля стоит точное имя навыка (и bare alias для
  `plugin:skill`), поэтому `Skill` может его загрузить.
- **I4. Один владелец.** Профиль создаёт тот же слой, который устанавливает навык:
  `SkillsService` для UI-установки и `NodeSkillAdapter` для tool-установки.
- **I5. Не перезаписывать пользователя.** Если файл уже существует, установка навыка
  не трогает его. Перезапись — только при явном `overwrite` (повторная установка).
- **I6. Ошибка провижининга не отменяет установку навыка.** Навык уже записан; агент —
  дополнительный артефакт. Ошибка логируется, установка остаётся успешной.
- **I7. Built-in имя не перезаписывается.** Если навык называется `reviewer`, агент
  получает `reviewer-skill`; в результате профиля фиксируется `nameAdjusted: built-in`.
- **I8. Без root-only инструментов.** Генерируемый агент получает worker-набор, не
  `Cron*`, `Workflow`, `EnterWorktree`, `TaskCreate` и т.п.

## 3. Профиль

| Поле             | Значение                                                                                                                                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`           | имя навыка; при коллизии/недопустимых символах — детерминированно исправленное                                                                                                                                                                              |
| `description`    | `Специализированный агент навыка «name»: <описание>`                                                                                                                                                                                                        |
| `systemPrompt`   | загрузить навык через `Skill`, работать в назначенной области, вернуть evidence                                                                                                                                                                             |
| `tools`          | `CodeIndex`, `Read`, `Glob`, `Grep`, `Write`, `Edit`, `ApplyPatch`, `MultiEdit`, `Bash`, `WebFetch`, `WebSearch`, `Task`, `Skill`, `SkillSearch`, `SkillInstall`, `InstallCapability`, `TodoRead`, `TodoWrite`, `AskUserQuestion`, `TaskOutput`, `TaskStop` |
| `skills`         | `[name]` (+ bare alias)                                                                                                                                                                                                                                     |
| `includeInSwarm` | `true`                                                                                                                                                                                                                                                      |
| `maxTurns`       | `40`                                                                                                                                                                                                                                                        |
| `injectAgentsMd` | `true`                                                                                                                                                                                                                                                      |
| `color`          | детерминированный из имени                                                                                                                                                                                                                                  |

## 4. Потоки

### UI / Settings marketplace

```
SkillsMarketplacePanel
  → SkillsService.installMarketplaceSkill
    → write skill snapshot
    → discover installed metadata
    → onMarketplaceSkillInstalled
      → provisionSkillAgentProfile(~/.zcode/agents/<name>.md)
      → SubagentsService.prepareRuntimeState()
  → result.agentName (optional)
```

### Agent tool `SkillInstall`

```
SkillInstall
  → NodeSkillAdapter.installMarketplaceSkill
    → write skill snapshot
    → discover installed metadata
    → provisionSkillAgent (same shared builder/serializer)
  → result.agentName
  → tool result: "Specialist agent X is saved and becomes available next turn."
```

Следующий turn читает `~/.zcode/agents` через существующий loader; отдельный
`subagent-factory` вызов не нужен.

## 5. Идемпотентность и ошибки

- Существующий файл → `created: false`, `reason: "exists"`, содержимое не меняется.
- `overwrite: true` (явная повторная установка) → файл перезаписывается.
- Нет прав/диск → установка навыка успешна, агент не создан, warning в логе.
- Имя занято built-in → `name-skill`, `reason: "built-in"`.
- Недопустимые символы → kebab/sanitized имя, `reason: "invalid"`.

## 6. Тесты

- `packages/shared/test/builtInAgents.test.ts` — builder: same name, reserved collision,
  invalid name, serializer, tools/skills.
- `packages/services/test/subagentsService.test.ts` — profile persisted, idempotent,
  appears in `settingsUserOnly` list with `source: "user"` and `skills`.
- `packages/services/test/skillMarketplace.test.ts` — install invokes host callback and
  returns `agentName`.
- `apps/zcode-cli/packages/adapters/tests/skill-marketplace.test.ts` — tool-path install
  writes `~/.zcode/agents/find-skills.md` and returns `agentName`.

## 7. Ограничения

- Уже установленные marketplace-навыки не получают агента задним числом; для них нужен
  отдельный backfill/Settings action. Это следующий шаг, не скрытая автогенерация.
- Навык может требовать специфический MCP/plugin tool, которого нет в worker-наборе.
  Профиль всё равно создаётся; при необходимости пользователь редактирует `tools`.
- Имя агента sanitized при недопустимых символах; «точно такое же имя» гарантируется для
  валидных kebab-case имён marketplace.
