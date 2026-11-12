# Политика knip-baseline

Статус: действует. Baseline хранится в `scripts/knip-baseline.json`, гейт — `pnpm knip`
(`node scripts/knip-baseline.mjs`) падает только на **новых** замечаниях.

## Зачем baseline, а не ноль

`knip` статически не видит несколько легитимных классов использования:

- entry points, которые запускаются инструментами, а не импортами (e2e-харнессы,
  build-скрипты, `.vscode/*.mjs`, `scripts/**`);
- тестовые данные и фикстуры (graphs, lowering-ожидания, browser-фикстуры);
- сгенерированные декларации (`dist-types`, `*.d.ts`) и governance-заглушки
  (`module.ts`, `contract.example.ts`);
- зависимости, которые реально используются в файлах, исключённых из анализа
  (например `packages/ui/src/components/**` — вендоренные ai-elements/ui-примитивы);
- runtime-closure зависимости, которые нужны сборке поставки, а не импортам:
  `electron-builder` (`@lydell/node-pty-*`), `bundle.mjs` (`@babel/runtime`,
  `module-details-from-path`), tsup-externals удалённого server-бандла.

Эти классы описаны **в конфиге** (`knip.json`: `entry`, `ignore`, `ignoreDependencies`),
а не в baseline. Baseline — только то, что остаётся после явной конфигурации.

## Правила разбора

1. **Сначала конфиг, потом baseline.** Если файл запускается инструментом или лежит в
   исключённой директории — это `entry`/`ignore`, а не «мёртвый код».
2. **Удаление вместо де-экспорта.** Если символ не импортируется ни из одного файла и не
   является частью публичного контракта — удалить. Проверка: `grep -rIlw <name>` по
   репозиторию (исключая node_modules/dist) даёт только файл-определение.
3. **Никакого массового `knip --fix`.** Проверено: он снимает `export` у символов,
   которые используются через `import("...")`/inline-типы, и typecheck падает.
4. **`ignoreDependencies` только с доказательством.** Каждая запись должна иметь
   объяснение, где зависимость используется (см. таблицу ниже).
5. **Каждая партия — отдельным коммитом** с прогоном `tsc`/тестов затронутых пакетов и
   обновлением baseline.

## Обоснованные `ignoreDependencies`

| Область | Зависимости | Где используются |
| --- | --- | --- |
| `packages/ui` | `@radix-ui/react-radio-group`, `@rive-app/react-webgl2`, `ansi-to-react`, `embla-carousel-react`, `media-chrome`, `react-jsx-parser`, `use-stick-to-bottom` | `packages/ui/src/components/**` (исключён из knip как вендоренный набор примитивов/ai-elements) |
| `packages/desktop` | `esbuild`, `@opentelemetry/otlp-transformer` | dev-инструменты e2e-скриптов и OTLP-приёмник телеметрии |
| `packages/desktop` | `@babel/runtime`, `@larksuiteoapi/node-sdk`, `module-details-from-path`, `@lydell/node-pty-*` | runtime-closure `bundle.mjs` (CJS-require из @arms/rum-core, native prebuilds) |
| `packages/desktop` | `@electron/rebuild`, `@wdio/local-runner`, `tailwindcss` | скрипты postinstall, конфиг wdio, Tailwind-Vite плагин |
| `packages/server` | `@lydell/node-pty-*`, `axios`, `form-data`, `combined-stream`, `follow-redirects`, `proxy-from-env`, `node-forge`, `yaml`, `yauzl`, `yazl`, `undici` | tsup-externals удалённого server-бандла (не импортируются напрямую) |
| `packages/web`, `packages/web-share` | `tailwindcss` | CSS-директива `@import "tailwindcss"` |
| `packages/share-ui` | `@types/react`, `@types/react-dom`, `@tailwindcss/typography` | типы для компиляции ре-экспортируемых исходников UI и typography-плагин |
| `apps/zcode-cli` | `oxlint`, `postject`, `tsx` | бинарники в lint/test/SEA-скриптах пакетов |
| `apps/zcode-cli/packages/office-runtime` | `@aiden0z/pptx-renderer`, `@modelcontextprotocol/ext-apps`, `docx-preview` | `ui/` (исключён из knip как вендоренный набор вьюеров) |
| `packages/shared` | `@modelcontextprotocol/ext-apps` | `src/mcp-apps/` (контракт генерируется в `module.ts`/`contract.ts`, которые knip игнорирует) |
| корень | `zod`, `ws`, `node-pty`, `@modelcontextprotocol/sdk` | dev-скрипты smoke/e2e, не входящие в runtime root-пакета |
| корень | `d3-path`, `tailwind-scrollbar-hide` | транзитивные зависимости UI-тулинга |
| корень | `@release-it/conventional-changelog`, `dotenv`, `lint-staged`, `postject`, `turbo` | конфиги release-it/lint-staged, e2e-скрипты desktop, SEA-сборка, CLI turbo |

## Что остаётся в baseline и почему не удаляется

- **exports/types**: символы, у которых есть внешние ссылки (barrel `export *`, тесты,
  публичные контракты пакетов). Удаление меняет публичную поверхность и типы
  потребителей, поэтому требует отдельного решения о версии API.
- **duplicates**: намеренные legacy-алиасы (`Goal*`/`Target*`, `SSHDialog` →
  `RemoteConnectionDialog`), которые читают старые сохранённые конфиги.
- **dependencies/devDependencies**: runtime-closure сборки (см. выше) — удаление ломает
  поставку, а не только линт.

## Проверка политики

```bash
pnpm knip                 # new=0 обязателен
pnpm knip:update-baseline # только после уменьшения текущего числа
```
