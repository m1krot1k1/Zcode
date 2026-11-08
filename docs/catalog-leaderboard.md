# Catalog & Leaderboard Specification

Статус: draft (foundation contract)
Владелец контракта: `packages/shared/src/catalog/index.ts`
Потребители: UI-каталоги Skills, MCP и Plugins (`packages/ui/src/components/*`).

## 1. Назначение и границы

Единый контракт сортировки, бейджей и нормализации имён для трёх каталогов: Skills, MCP servers
и Plugins. Модуль чистый (без I/O и React): он не загружает данные, не хранит состояние и не
форматирует строки. Загрузка данных, состояние «установлено» и i18n остаются у соответствующих
UI-компонентов и сервисов.

**Запрещено фабриковать метрики.** Нельзя показывать, логировать или сохранять выдуманные installs,
downloads, stars, рейтинги и значения trend. Если источник метрику не отдаёт — интерфейс обязан
явно сказать, что данных нет, и использовать курируемый порядок.

## 2. Источники данных

| Поверхность       | Источник                                                   | Метрики                                                 | Порядок                                                                                                               |
| ----------------- | ---------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Skills            | skills.sh API                                              | installs (реальные, могут отсутствовать); `publishedAt` | curated rank (если задан), затем installs desc                                                                        |
| Skills → Trending | Только если источник реально отдаёт поле trend             | trend                                                   | Без реального trend-поля вкладка обязана показывать `catalog.noTrendingData`; сортировка остаётся по installs/curated |
| MCP               | Official MCP Registry (`registry.modelcontextprotocol.io`) | installs отсутствуют                                    | Курируемый rank (`MCP_CURATED_SERVERS`)                                                                               |
| Plugins           | Marketplace manifests (ZCode official, Claude official)    | installs отсутствуют                                    | Курируемый rank (`PLUGIN_CURATED_NAMES`, выведен из официальных плагинов репозитория)                                 |

Термин **curated** означает редакционный порядок, выбранный продуктовой командой. Это не
измеренная популярность и не install counts. В UI это должно читаться как `catalog.curatedNote`
("Curated ordering (not install counts)" / «精选排序（非安装量）»).

## 3. Контракт

```ts
type CatalogBadge = "official" | "popular" | "new" | "featured" | "community" | "curated";
type CatalogSortMode = "recommended" | "installs" | "name" | "newest";
interface CatalogEntryLike {
  name: string;
  installs?: number;
  publishedAt?: string;
  curatedRank?: number;
}
```

Экспорты (фиксированные имена):

- `SKILLS_POPULAR_MIN_INSTALLS = 1000` — порог бейджа `popular`, не сигнал ранжирования.
- `OFFICIAL_PUBLISHERS = ['vercel-labs', 'anthropics', 'google', 'google-labs-code', 'vercel']`.
- `isOfficialPublisher(publisher)` — case-insensitive, trim, принимает `owner`, `owner/repo`, GitHub URL.
- `MCP_CURATED_SERVERS` — курируемый порядок популярных MCP-серверов.
- `getMcpCuratedRank(name)` — lowercase, trim, сегмент после последнего `/`, снятие
  `io.github.`/`mcp-server-`/`server-`/`mcp-` префиксов и `-mcp`/`-server` суффиксов,
  `_` → `-`; `undefined` вне списка.
- `getPluginCuratedRank(idOrName)` — принимает `plugin@marketplace`, имя или путь.
- `compareCatalogEntries(a, b, mode)` — см. раздел 4.
- `isNewPublishedAt(publishedAt, days = 30, now = new Date())` — `true` только для реальной
  ISO-8601 даты в окне `[now - days, now]`; отсутствие/мусор/будущее → `false`.
- `skillsBadges({ installs, publisher, publishedAt, now })` — порядок бейджей
  `official`, `popular`, `new`.

## 4. Правила сортировки

| mode                    | Правило                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `recommended` (default) | `curatedRank` asc (без rank — в конце), затем `installs` desc (нет значения — в конце), затем name `localeCompare` |
| `installs`              | `installs` desc, отсутствующие в конце, затем name                                                                 |
| `newest`                | `publishedAt` desc, отсутствующие или непарсимые в конце, затем name                                               |
| `name`                  | `localeCompare`                                                                                                    |

Инварианты:

- отсутствующее значение никогда не сравнивается как `0` и не отображается как `0`;
- сортировка стабильна для равных ключей (fallback по name);
- «top first»: первый элемент списка — лучший по выбранному режиму (наивысший installs,
  наименьший curated rank, самая свежая дата).

## 5. Бейджи

| Бейдж           | Правило                                                               |
| --------------- | --------------------------------------------------------------------- |
| `official`      | `isOfficialPublisher(publisher)`                                      |
| `popular` (Pop) | `installs` — конечное число и `>= SKILLS_POPULAR_MIN_INSTALLS` (1000) |
| `new`           | `isNewPublishedAt(publishedAt, 30)`                                   |
| `featured`      | редакционная конфигурация поверхности MCP/Plugins                     |
| `community`     | не официальный publisher (поверхности MCP/Plugins)                    |
| `curated`       | запись входит в курируемый список MCP/Plugins                         |

Один вход может дать несколько бейджей; `skillsBadges` возвращает их в фиксированном порядке
`official → popular → new`.

## 6. Поведение поверхностей

- **Default order**: top first, режим `recommended`.
- **Вкладки**: `all`, `allTime`, `popular`, `trending`, `curated`, `official`, `community`.
  Вкладка — фильтр по данным, а не пересортировка с выдуманными метриками.
- **Trending**: вкладка существует, только если у источника есть реальное trend-поле. Иначе
  показывается `catalog.noTrendingData` и список сортируется по installs (Skills) или curated
  order (MCP/Plugins). Нельзя имитировать trend перестановкой записей.
- **Search — данные источника, затем фильтр**:
  - Skills: стартовая витрина загружает ограниченный снимок skills.sh по широкому запросу `skill`;
    это выборка каталога, а не полный глобальный рейтинг. Отправленный пользователем запрос
    выполняется через skills.sh API, чтобы находить записи за пределами снимка. При явном поиске
    фильтр Popular не скрывает найденные записи ниже порога installs; сортировка остаётся выбранной.
  - MCP: отправленный запрос выполняется через Registry API и показывает все найденные записи,
    включая не входящие в редакционную подборку Popular. После очистки запроса пользователь
    возвращается к выбранной витрине. Очистка/изменение запроса инвалидирует незавершённый поиск:
    его поздние результаты, ошибки и завершение загрузки не могут менять состояние новой витрины.
  - Plugins: поиск фильтрует загруженные записи текущего сегмента/источника; он не меняет
    сортировку и не подмешивает «релевантность» без метрики.
    Пустой результат показывает пустое состояние, а не весь список. Поиск и выбранный сегмент
    не должны заставлять пользователя принимать неполную начальную выборку за полный каталог.
- **Installed state**: состояние «установлено» приходит из соответствующего сервиса и не
  пересчитывается в каталоге. Смена вкладки, сортировки или поиска не сбрасывает и не подменяет
  installed-состояние; установленная запись остаётся помеченной после повторной загрузки списка.
- **Failure/empty**: отсутствие installs или publishedAt не является ошибкой загрузки; ошибка
  сети показывается отдельно и не заменяется курируемым порядком как «успехом».

## 7. i18n

Ключи добавляются в оба словаря (`packages/ui/src/i18n/locales/en-US.ts`,
`packages/ui/src/i18n/locales/zh-CN.ts`) плоско, dotted-ключами в `Record<string, string>`:

- `catalog.tabs.*` — 7 ключей;
- `catalog.badge.*` — 6 ключей;
- `catalog.source.*` — 6 ключей;
- `catalog.sort.*` — 5 ключей;
- `catalog.installsCount`, `catalog.rankLabel`, `catalog.noTrendingData`, `catalog.curatedNote`,
  `catalog.officialRegistryNote`;
- `catalog.skills.title`, `catalog.mcp.title`, `catalog.plugins.title`.

`catalog.noTrendingData` обязан честно сообщать, что trend-данных нет, и называть фактическое
основание порядка (installs или curated). Новые ключи вне `catalog.*` не добавляются.

## 8. Сценарии приёмки

1. **Skills installs**: запись с `installs: 5000` в режиме `installs` стоит выше записи с
   `installs: 1200`; запись без installs — в конце, бейдж `popular` отсутствует.
2. **Порог Pop**: `installs: 999` → без бейджа; `installs: 1000` → `popular`.
3. **Официальность**: `anthropics/skills` → `official`; `some-user/skills` → без `official`.
4. **Новизна**: `publishedAt` в пределах 30 дней → `new`; ровно 31 день, невалидная строка,
   отсутствие и будущая дата → без `new`.
5. **MCP нормализация**: `io.github.modelcontextprotocol/server-sequential-thinking` и
   `sequential-thinking` дают одинаковый curated rank; неизвестный сервер — `undefined`.
6. **MCP порядок**: список без installs в режиме `recommended` идёт по rank; в режиме `installs`
   (без метрик) — по name, без падений.
7. **Plugins порядок**: `pdf@zcode-plugins-official` выше `documents@zcode-plugins-official`
   согласно курируемому порядку; installs нигде не подставляются.
8. **Trending отсутствует**: вкладка показывает `catalog.noTrendingData`; сортировка остаётся
   installs/curated, выдуманные trend-значения не появляются.
9. **Search**: отправленный запрос получает удалённую выдачу за пределами начального снимка;
   результаты поиска не скрываются вкладками Popular/Curated, очистка возвращает выбранную
   витрину; installed-метки сохраняются.
10. **Смена языка**: все `catalog.*` ключи есть в en-US и zh-CN; отсутствие ключа — дефект.

## 9. Верификация

- Unit-тесты: `packages/shared/test/catalog.test.ts`
  (`pnpm vitest run packages/shared/test/catalog.test.ts`).
- Typecheck пакета: `pnpm --filter @zcode/shared exec tsc --noEmit -p tsconfig.json`.
