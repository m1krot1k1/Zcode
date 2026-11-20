# Реестр встроенных агентов и override моделей

Статус: **implemented**, 2026-11-20.

## 1. Проблема

В runtime ZCode есть 16 специализированных встроенных ролей
(`start`, `orchestrator`, `researcher`, `debugger`, `implementer`, `coder`,
`frontend-coder`, `backend-coder`, `infra-coder`, `reviewer`, `security-reviewer`,
`test-engineer`, `evaluator`, `self-improver`, `knowledge-curator`, `subagent-factory`).
Но `SubagentsService` отдавал в Settings только `Explore`:

- `createBuiltInAgents()` возвращал один `Explore`;
- `BUILT_IN_AGENT_NAMES` содержал только `Explore`;
- в списке настроек были видны `Explore` и plugin-агенты `visual-judge`, а остальные 16
  ролей — нет.

Дополнительно `start`/`orchestrator` уже были объявлены как model-overridable в
`BuiltInSubagentName`, UI и state migration, но формальная схема
`subagentRuntimeStateSchema` и `normalizeBuiltInSelectionOverrides()` их отбрасывали.
Пользовательская настройка «быстрая модель для роутера» терялась после перезапуска Host.

## 2. Контракт

### 2.1 Единый каталог

`packages/shared/src/subagent-catalog/builtInAgents.ts` — единственная проекция метаданных встроенных
ролей для Settings и Services: имя, описание, цвет, tools, skills, `injectAgentsMd`,
`memory`. Runtime-промпты и исполнение остаются в
`apps/zcode-cli/packages/core/src/subagent/built-in-profiles.ts`.

Каталог не импортирует Core. Соответствие каталога runtime-ростеру проверяет
`apps/zcode-cli/packages/bootstrap/tests/built-in-agents-contract.test.ts`.

### 2.2 Что видно в Settings

- `Explore` — read-only.
- 16 встроенных ролей — read-only строки с описанием, tools и concrete preferred skills.
- Plugin-агенты — как раньше, read-only.
- User/workspace-агенты — как раньше, редактируемые.

Строка показывает `N skills`, где `N` — число конкретных навыков; wildcard `*`
(«можно загрузить любой навык») не считается специализацией и в счётчик не входит.
Полный список конкретных навыков доступен в `title` бейджа.

### 2.3 Model override

Явный override модели разрешён для:

- `Explore`
- `general-purpose` (legacy, в ростере может отсутствовать)
- `start`
- `orchestrator`

Остальные встроенные worker-роли наследуют модель сессии. Это сохраняет дешёвый/быстрый
роутер и сильную модель исполнителя. Расширение override на всех worker-ролей — отдельное
решение, не входит в этот контракт.

Схема `subagentRuntimeStateSchema`, `normalizeBuiltInSelectionOverrides()` и state migration
обязаны принимать один и тот же набор имён. Иначе override снова будет молча теряться.

## 3. Реализация

- `packages/shared/src/subagent-catalog/` — managed-модуль `shared-subagent-catalog`
  (`module.ts`, `contract.ts`, `CONTRACT.md`); каталог и `BUILT_IN_AGENT_NAMES`.
- `packages/services/src/subagents/builtInAgents.ts` — `createBuiltInAgents()` и
  `normalizeBuiltInSelectionOverrides()`; вынесено из `subagents-service-part1.ts`, чтобы
  не нарушать лимит 800 строк.
- `packages/shared/src/subagent-catalog/runtimeConfig.ts` — `start`/`orchestrator` в схеме.
- `packages/ui/src/settings/subagents-section/AgentListRow.tsx` — бейдж concrete skills.
- i18n: `settings.subagents.skillsCount` (en-US, zh-CN, ru-RU).

## 4. Тесты

- `packages/shared/test/builtInAgents.test.ts` — полный ростер и парсинг router-overrides.
- `packages/services/test/subagentsService.test.ts` — все built-in строки видны, skills
  заполнены, `start`/`orchestrator` overrides сохраняются.
- `packages/ui/test/subagentsSection.test.ts` — бейдж считает concrete skills, не `*`.
- `apps/zcode-cli/packages/bootstrap/tests/built-in-agents-contract.test.ts` — shared
  каталог совпадает с runtime-ростером.

## 5. Ограничения

- Runtime по-прежнему разрешает `skills: ["*"]`; это soft-specialization, а не жёсткий
  allowlist. Переход к role-scoped каталогу навыков — отдельный этап.
- Worker-роли пока не имеют per-role model override.
- Видимость в Settings не доказывает, что orchestrator выбирает специализированную роль;
  это измеряется отдельно по трассам.
