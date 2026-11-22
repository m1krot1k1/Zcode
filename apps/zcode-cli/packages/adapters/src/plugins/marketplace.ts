// Плагин-маркетплейс: barrel публичного API.
//
// Реализация разделена по лимиту строк:
// - marketplace-types.ts — типы, константы, compat-проверки, JSON/путь-утилиты;
// - marketplace-primitives.ts — манифесты, источники и кэш (низкий уровень);
// - marketplace-runtime.ts — refresh/install-исполнение поверх примитивов;
// - marketplace-validation.ts — валидация плагинов и managed-marketplace записей;
// - marketplace-sources.ts — git/zip-источники и staging;
// - marketplace-store.ts — состояние known-marketplaces/installed-plugins и операции.
export * from "./marketplace-types.js";
export * from "./marketplace-primitives.js";
export * from "./marketplace-runtime.js";
export * from "./marketplace-validation.js";
export * from "./marketplace-sources.js";
export * from "./marketplace-store.js";
