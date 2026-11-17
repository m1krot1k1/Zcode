/**
 * Мультиязычный реестр: расширение → языка → `.wasm`-грамматика.
 *
 * Реально проверено на этом репозитории (`web-tree-sitter@0.25.10` + `tree-sitter-wasms@0.1.13`):
 * загружаются и парсят typescript, tsx, javascript, python, go, rust, c, cpp, c_sharp, java,
 * kotlin, ruby, php, bash, json, toml, html, css, vue.
 *
 * `tree-sitter-yaml.wasm` из этого артефакта падает при `Language.load` (`resolved is not a function`),
 * а markdown-грамматики в пакете нет. Для YAML/Markdown и неизвестных текстовых языков используется
 * собственный детерминированный структурный чанкер (`textChunker.ts`) — он не заглушка, а полноценный
 * алгоритм по отступам/скобкам/ключам/заголовкам.
 */

/** Числовые id пишутся в БД (`files.lang_id`), поэтому значения фиксированы. */
export const LANGUAGE_ID = {
  unknown: 0,
  typescript: 1,
  tsx: 2,
  javascript: 3,
  jsx: 4,
  python: 5,
  go: 6,
  rust: 7,
  c: 8,
  cpp: 9,
  csharp: 10,
  java: 11,
  kotlin: 12,
  ruby: 13,
  php: 14,
  bash: 15,
  json: 16,
  toml: 17,
  yaml: 18,
  markdown: 19,
  html: 20,
  css: 21,
  vue: 22,
} as const;

export type LanguageId = (typeof LANGUAGE_ID)[keyof typeof LANGUAGE_ID];
export type LanguageName = keyof typeof LANGUAGE_ID;

export interface LanguageDescriptor {
  id: LanguageId;
  name: LanguageName;
  /** Имя файла грамматики в `tree-sitter-wasms/out`, `null` — используется текстовый чанкер. */
  wasm: string | null;
}

const DESCRIPTORS: Record<LanguageName, LanguageDescriptor> = {
  unknown: { id: LANGUAGE_ID.unknown, name: "unknown", wasm: null },
  typescript: {
    id: LANGUAGE_ID.typescript,
    name: "typescript",
    wasm: "tree-sitter-typescript.wasm",
  },
  tsx: { id: LANGUAGE_ID.tsx, name: "tsx", wasm: "tree-sitter-tsx.wasm" },
  javascript: {
    id: LANGUAGE_ID.javascript,
    name: "javascript",
    wasm: "tree-sitter-javascript.wasm",
  },
  jsx: { id: LANGUAGE_ID.jsx, name: "jsx", wasm: "tree-sitter-javascript.wasm" },
  python: { id: LANGUAGE_ID.python, name: "python", wasm: "tree-sitter-python.wasm" },
  go: { id: LANGUAGE_ID.go, name: "go", wasm: "tree-sitter-go.wasm" },
  rust: { id: LANGUAGE_ID.rust, name: "rust", wasm: "tree-sitter-rust.wasm" },
  c: { id: LANGUAGE_ID.c, name: "c", wasm: "tree-sitter-c.wasm" },
  cpp: { id: LANGUAGE_ID.cpp, name: "cpp", wasm: "tree-sitter-cpp.wasm" },
  csharp: { id: LANGUAGE_ID.csharp, name: "csharp", wasm: "tree-sitter-c_sharp.wasm" },
  java: { id: LANGUAGE_ID.java, name: "java", wasm: "tree-sitter-java.wasm" },
  kotlin: { id: LANGUAGE_ID.kotlin, name: "kotlin", wasm: "tree-sitter-kotlin.wasm" },
  ruby: { id: LANGUAGE_ID.ruby, name: "ruby", wasm: "tree-sitter-ruby.wasm" },
  php: { id: LANGUAGE_ID.php, name: "php", wasm: "tree-sitter-php.wasm" },
  bash: { id: LANGUAGE_ID.bash, name: "bash", wasm: "tree-sitter-bash.wasm" },
  json: { id: LANGUAGE_ID.json, name: "json", wasm: "tree-sitter-json.wasm" },
  toml: { id: LANGUAGE_ID.toml, name: "toml", wasm: "tree-sitter-toml.wasm" },
  yaml: { id: LANGUAGE_ID.yaml, name: "yaml", wasm: null },
  markdown: { id: LANGUAGE_ID.markdown, name: "markdown", wasm: null },
  html: { id: LANGUAGE_ID.html, name: "html", wasm: "tree-sitter-html.wasm" },
  css: { id: LANGUAGE_ID.css, name: "css", wasm: "tree-sitter-css.wasm" },
  vue: { id: LANGUAGE_ID.vue, name: "vue", wasm: "tree-sitter-vue.wasm" },
};

const EXTENSION_LANGUAGE: Record<string, LanguageName> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "jsx",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".cs": "csharp",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".rb": "ruby",
  ".php": "php",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".json": "json",
  ".toml": "toml",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".md": "markdown",
  ".mdx": "markdown",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".vue": "vue",
};

/** Расширения, которые вообще попадают в индекс. */
export const INDEXED_EXTENSIONS: readonly string[] = Object.keys(EXTENSION_LANGUAGE);

export function languageForPath(filePath: string): LanguageDescriptor {
  const lower = filePath.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const extension = dot >= 0 ? lower.slice(dot) : "";
  const name = EXTENSION_LANGUAGE[extension];
  return name ? DESCRIPTORS[name] : DESCRIPTORS.unknown;
}

export function descriptorForName(name: string): LanguageDescriptor | undefined {
  return (DESCRIPTORS as Record<string, LanguageDescriptor | undefined>)[name];
}

/** Имя языка для отчётов/статуса без раскрытия путей. */
export function languageNameOf(langId: number): LanguageName {
  for (const descriptor of Object.values(DESCRIPTORS)) {
    if (descriptor.id === langId) return descriptor.name;
  }
  return "unknown";
}

export type PathTier = 0 | 1 | 2 | 3;

const TEST_SEGMENT = /^(?:__tests__|__mocks__|__snapshots__|tests?|e2e|spec|specs)$/u;
const FIXTURE_SEGMENT = /^(?:fixtures?|__fixtures__|examples?|samples?|dev-docs)$/u;
const DOC_SEGMENT = /^(?:docs?|documentation|config|configs|\.github)$/u;

/**
 * `path_tier` определяет де-бустинг шумных директорий при поиске:
 * 0 — продакшн-исходники, 1 — документация/конфиги, 2 — тесты/спеки, 3 — фикстуры/скиллы/генераты.
 */
export function pathTierOf(relPath: string): PathTier {
  const segments = relPath.toLowerCase().split("/");
  if (segments.includes(".agents") || segments.includes("skills")) return 3;
  if (segments.some((segment) => FIXTURE_SEGMENT.test(segment))) return 3;
  if (
    /(?:^|\/)[^/]*\.(?:min|bundle)\.[a-z]+$/u.test(relPath) ||
    /(?:^|\/)generated\//u.test(relPath)
  )
    return 3;
  if (segments.some((segment) => TEST_SEGMENT.test(segment))) return 2;
  const base = segments.at(-1) ?? "";
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(base) || /_test\.(?:go|py|rs)$/u.test(base)) return 2;
  if (segments.some((segment) => DOC_SEGMENT.test(segment))) return 1;
  if (/\.(?:md|mdx|ya?ml|toml|json|ini)$/u.test(base)) return 1;
  return 0;
}
