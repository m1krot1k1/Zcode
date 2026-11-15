# Дедупликация плагинов и MCP из разных маркетплейсов

Статус: реализовано 2026-11-15.

## Проблема

Один и тот же плагин может быть установлен из нескольких маркетплейсов. Plugin ID
содержит marketplace (`<name>@<marketplace>`), поэтому такие копии считались разными
плагинами и обе попадали в discovery. MCP-серверы плагина namespaced по manifest name:
`plugin:<name>:<server>`. Две копии давали одинаковые runtime-ключи, а `Object.assign`
молча оставлял последнюю — в UI при этом было видно два плагина/MCP-сервера.

## Продуктовое правило

1. Discovery дедуплицирует плагины по **manifest name** до слияния components.
2. Приоритет — порядок кандидатов: inline-плагины пользователя → официальный
   marketplace → установленные marketplace-плагины. Первая копия выигрывает.
3. Отброшенная копия не исчезает бесследно: пишется warning
   `plugin_duplicate_name` с marketplace/pluginId, поэтому причина видна в диагностике.
4. MCP-серверы сливаются first-wins. Если ключ уже занят, пишется
   `plugin_mcp_server_duplicate`; тихая замена запрещена.
5. Дедупликация не меняет enable/disable и options оставшегося плагина: это тот же
   первый кандидат, который и раньше загружался первым.

## До / после

| Сценарий | До | После |
| --- | --- | --- |
| Один плагин из inline и official | два plugin row, MCP key перезаписан | один plugin row, MCP key один |
| Один плагин из двух marketplaces | два plugin row | остаётся первый по приоритету |
| Конфликт MCP-ключей | молчаливая замена | first-wins + warning |

## Проверки

- `apps/zcode-cli/packages/adapters/tests/plugins.test.ts` —
  `dedupes the same plugin name across marketplaces and keeps the first MCP server`:
  один plugin row, один `plugin:shared-plugin:shared`, диагностика
  `plugin_duplicate_name` для отброшенной official-копии.
- Полный `plugins.test.ts` (81 тест) проходит.
