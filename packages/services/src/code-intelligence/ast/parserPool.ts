import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * Ленивый пул `web-tree-sitter`.
 *
 * Загрузка `.wasm` подтверждена фактически на этом репозитории: `Parser.init()` без аргументов
 * находит `tree-sitter.wasm` рядом с модулем, `Language.load(<path>)` поднимает грамматику,
 * `Parser.parse(text)` возвращает дерево с корректными `startPosition/endPosition`.
 *
 * Грамматики кешируются на процесс: `Language` — тяжёлый wasm-модуль, повторная загрузка
 * на каждый файл съедала бы десятки миллисекунд. `Parser` переиспользуется через `reset()`.
 *
 * ВАЖНО: этот модуль не бросает исключения наружу при отсутствии грамматики — вызывающая
 * сторона обязана деградировать до структурного текстового чанкера и записать диагностику.
 */

/** Минимальная структурная форма узла tree-sitter, которой пользуется наш код. */
export interface TsPoint {
  row: number;
  column: number;
}

export interface TsNode {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: TsPoint;
  endPosition: TsPoint;
  childCount: number;
  namedChildCount: number;
  children: TsNode[];
  namedChildren: TsNode[];
  parent: TsNode | null;
  isNamed: boolean;
  hasError: boolean;
  childForFieldName(name: string): TsNode | null;
  namedChild(index: number): TsNode | null;
}

export interface TsTree {
  rootNode: TsNode;
  delete(): void;
}

export interface TsParser {
  setLanguage(language: unknown): void;
  parse(input: string): TsTree | null;
  delete(): void;
}

export interface TsLanguage {
  delete?: () => void;
}

interface TsModule {
  Parser: {
    init(): Promise<void>;
    new (): TsParser;
  };
  Language: {
    load(path: string): Promise<TsLanguage>;
  };
}

const requireFromHere = createRequire(import.meta.url);

let modulePromise: Promise<TsModule> | undefined;
let initPromise: Promise<void> | undefined;
let wasmDirCache: string | null | undefined;
const languageCache = new Map<string, Promise<TsLanguage | null>>();
const parserCache = new Map<string, TsParser>();

/** Каталог предсобранных грамматик; `null`, если пакет недоступен в рантайме. */
export function grammarDirectory(): string | null {
  if (wasmDirCache !== undefined) return wasmDirCache;
  try {
    const packageJsonPath = requireFromHere.resolve("tree-sitter-wasms/package.json");
    wasmDirCache = join(packageJsonPath, "..", "out");
  } catch {
    wasmDirCache = null;
  }
  return wasmDirCache;
}

async function loadModule(): Promise<TsModule> {
  modulePromise ??= (async () => {
    // Пакет публикуется как dual ESM/CJS; createRequire надёжно работает и в ESM, и в CJS-бандле.
    const loaded = requireFromHere("web-tree-sitter") as TsModule & { default?: TsModule };
    return loaded.Parser ? loaded : (loaded.default as TsModule);
  })();
  return modulePromise;
}

/** Однократная инициализация wasm-рантайма; повторные вызовы возвращают тот же промис. */
export async function initTreeSitter(): Promise<TsModule | null> {
  try {
    const module = await loadModule();
    initPromise ??= module.Parser.init();
    await initPromise;
    return module;
  } catch {
    modulePromise = undefined;
    initPromise = undefined;
    return null;
  }
}

/**
 * Возвращает парсер с загруженной грамматикой или `null`, если грамматика недоступна.
 * Ошибка загрузки кешируется как `null`, чтобы не бить по диску на каждом файле.
 */
export async function acquireParser(wasmFileName: string): Promise<TsParser | null> {
  const module = await initTreeSitter();
  const directory = grammarDirectory();
  if (!module || !directory) return null;
  let languagePromise = languageCache.get(wasmFileName);
  if (!languagePromise) {
    languagePromise = module.Language.load(join(directory, wasmFileName)).catch(() => null);
    languageCache.set(wasmFileName, languagePromise);
  }
  const language = await languagePromise;
  if (!language) return null;
  const cached = parserCache.get(wasmFileName);
  if (cached) return cached;
  const parser = new module.Parser();
  try {
    parser.setLanguage(language);
  } catch {
    parser.delete();
    return null;
  }
  parserCache.set(wasmFileName, parser);
  return parser;
}

/** Освобождение wasm-ресурсов; вызывается при остановке воркера. */
export function disposeTreeSitter(): void {
  for (const parser of parserCache.values()) {
    try {
      parser.delete();
    } catch {
      // Игнорируем: закрытие процесса всё равно освободит wasm-память.
    }
  }
  parserCache.clear();
  languageCache.clear();
  initPromise = undefined;
  modulePromise = undefined;
}
