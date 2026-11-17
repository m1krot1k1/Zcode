import { describe, expect, it } from "vitest";
import { parseFile } from "../../src/code-intelligence/ast/parseFile.js";
import { languageForPath, pathTierOf } from "../../src/code-intelligence/ast/languageRegistry.js";
import { parseWithTextChunker } from "../../src/code-intelligence/ast/textChunker.js";
import { splitCodeIdentifiers, searchTokensOf } from "../../src/code-intelligence/ast/tokenizer.js";
import { SYMBOL_KIND } from "../../src/code-intelligence/ast/languageRules.js";

const TS_SOURCE = [
  'import { helper } from "./helper.js";',
  "",
  "export class WorkspaceIndexer {",
  "  private state: string = 'idle';",
  "",
  "  async indexWorkspace(path: string): Promise<number> {",
  "    return helper(path);",
  "  }",
  "",
  "  async search(query: string): Promise<string[]> {",
  "    return this.indexWorkspace(query) ? [] : [];",
  "  }",
  "}",
  "",
  "export interface IndexOptions {",
  "  force?: boolean;",
  "}",
  "",
  "export type IndexState = 'idle' | 'ready';",
  "",
  "export function buildIndexer(path: string): WorkspaceIndexer {",
  "  return new WorkspaceIndexer();",
  "}",
  "",
].join("\n");

const PYTHON_SOURCE = [
  '"""Fixture module."""',
  "",
  "from app.helper import helper",
  "",
  "",
  "class WorkspaceService:",
  '    """Owns the index lifecycle."""',
  "",
  "    def __init__(self, root: str) -> None:",
  "        self.root = root",
  "",
  "    def index_workspace(self, force: bool = False) -> int:",
  "        return helper(self.root) if force else 0",
  "",
  "",
  "def build_service(root: str) -> WorkspaceService:",
  "    return WorkspaceService(root)",
  "",
].join("\n");

const GO_SOURCE = [
  "package main",
  "",
  'import "fmt"',
  "",
  "type WorkspaceIdentity struct {",
  "  Raw string",
  "}",
  "",
  "func (w WorkspaceIdentity) Normalized() string {",
  "  return trimSpace(w.Raw)",
  "}",
  "",
  "func trimSpace(value string) string {",
  "  return value",
  "}",
  "",
  "func main() {",
  '  fmt.Println(WorkspaceIdentity{Raw: trimSpace("x")}.Normalized())',
  "}",
  "",
].join("\n");

const RUST_SOURCE = [
  "pub struct WorkspaceIdentity {",
  "    pub raw: String,",
  "}",
  "",
  "pub trait IdentityResolver {",
  "    fn resolve(&self) -> String;",
  "}",
  "",
  "impl WorkspaceIdentity {",
  "    pub fn normalized(&self) -> String {",
  "        self.raw.trim().to_string()",
  "    }",
  "}",
  "",
  "pub fn resolve_identity(value: &str) -> String {",
  "    value.trim().to_string()",
  "}",
  "",
].join("\n");

describe("structural chunking", () => {
  it("extracts TypeScript declarations with kinds and hierarchy", async () => {
    const parsed = await parseFile("src/indexer.ts", TS_SOURCE);
    expect(parsed.usedTreeSitter).toBe(true);
    expect(parsed.languageName).toBe("typescript");
    const names = parsed.symbols.map((symbol) => `${symbol.kind}:${symbol.name}`);
    expect(names).toContain(`${SYMBOL_KIND.class}:WorkspaceIndexer`);
    expect(names).toContain(`${SYMBOL_KIND.interface}:IndexOptions`);
    expect(names).toContain(`${SYMBOL_KIND.type}:IndexState`);
    expect(names).toContain(`${SYMBOL_KIND.function}:buildIndexer`);
    // Методы вложены в класс, а не висят на верхнем уровне.
    const method = parsed.symbols.find((symbol) => symbol.name === "indexWorkspace");
    expect(method?.parentIndex).not.toBeNull();
    expect(parsed.symbols[method!.parentIndex!]!.name).toBe("WorkspaceIndexer");
    // Импорт разрешён как факт графа.
    expect(parsed.imports.some((entry) => entry.specifier === "./helper.js")).toBe(true);
    // Вызов helper() внутри метода попадает в факты.
    expect(parsed.calls.some((call) => call.name === "helper")).toBe(true);
  });

  it("never splits a chunk in the middle of a line and keeps scope headers", async () => {
    const parsed = await parseFile("src/indexer.ts", TS_SOURCE);
    const lines = TS_SOURCE.split("\n");
    expect(parsed.chunks.length).toBeGreaterThan(0);
    for (const chunk of parsed.chunks) {
      expect(chunk.startLine).toBeGreaterThanOrEqual(1);
      expect(chunk.endLine).toBeLessThanOrEqual(lines.length);
      expect(chunk.scopeHeader).toContain("src/indexer.ts");
      // Содержимое чанка совпадает с точным срезом строк файла.
      expect(chunk.content).toBe(
        lines
          .slice(chunk.startLine - 1, chunk.endLine)
          .join("\n")
          .trim(),
      );
    }
  });

  it("extracts Python classes and methods", async () => {
    const parsed = await parseFile("app/service.py", PYTHON_SOURCE);
    expect(parsed.usedTreeSitter).toBe(true);
    expect(parsed.languageName).toBe("python");
    const names = parsed.symbols.map((symbol) => symbol.name);
    expect(names).toContain("WorkspaceService");
    expect(names).toContain("index_workspace");
    expect(names).toContain("build_service");
    expect(parsed.calls.some((call) => call.name === "helper")).toBe(true);
  });

  it("extracts Go types, methods and functions", async () => {
    const parsed = await parseFile("main.go", GO_SOURCE);
    expect(parsed.usedTreeSitter).toBe(true);
    expect(parsed.languageName).toBe("go");
    const names = parsed.symbols.map((symbol) => symbol.name);
    expect(names).toContain("WorkspaceIdentity");
    expect(names).toContain("Normalized");
    expect(names).toContain("trimSpace");
    expect(names).toContain("main");
    // Каждый тип объявлен ровно один раз: раньше дублировался через type_declaration.
    expect(names.filter((name) => name === "WorkspaceIdentity")).toHaveLength(1);
  });

  it("extracts Rust structs, traits, impl methods and functions", async () => {
    const parsed = await parseFile("lib.rs", RUST_SOURCE);
    expect(parsed.usedTreeSitter).toBe(true);
    expect(parsed.languageName).toBe("rust");
    const names = parsed.symbols.map((symbol) => symbol.name);
    expect(names).toContain("WorkspaceIdentity");
    expect(names).toContain("IdentityResolver");
    expect(names).toContain("normalized");
    expect(names).toContain("resolve_identity");
  });

  it("chunks Markdown by headings and YAML by keys without a grammar", () => {
    const markdown = [
      "# Title",
      "",
      "Intro paragraph.",
      "",
      "## Section A",
      "",
      "Body A.",
      "",
      "### Nested",
      "",
      "Body nested.",
      "",
      "## Section B",
      "",
      "Body B.",
      "",
    ].join("\n");
    const md = parseWithTextChunker("docs/guide.md", markdown, 19, "markdown");
    expect(md.usedTreeSitter).toBe(false);
    expect(md.chunks.length).toBeGreaterThanOrEqual(4);
    // Вложенность заголовков видна в scope_header.
    const nested = md.chunks.find((chunk) => chunk.scopeHeader.includes("Nested"));
    expect(nested?.scopeHeader).toContain("Section A");
    // Никакой чанк не разрезан посередине строки.
    const lines = markdown.split("\n");
    for (const chunk of md.chunks) {
      expect(chunk.content).toBe(
        lines
          .slice(chunk.startLine - 1, chunk.endLine)
          .join("\n")
          .trim(),
      );
    }

    const yaml = ["---", "first: 1", "nested:", "  a: 1", "  b: 2", "---", "second: 3", ""].join(
      "\n",
    );
    const parsedYaml = parseWithTextChunker("config/app.yaml", yaml, 18, "yaml");
    expect(parsedYaml.chunks.length).toBeGreaterThanOrEqual(2);
    expect(parsedYaml.symbols.map((symbol) => symbol.name)).toContain("first");
  });
});

describe("language registry and tokenizer", () => {
  it("maps extensions to languages and path tiers", () => {
    expect(languageForPath("a/b.ts").name).toBe("typescript");
    expect(languageForPath("a/b.tsx").name).toBe("tsx");
    expect(languageForPath("a/b.py").name).toBe("python");
    expect(languageForPath("a/b.go").name).toBe("go");
    expect(languageForPath("a/b.rs").name).toBe("rust");
    expect(languageForPath("a/b.unknown").name).toBe("unknown");

    expect(pathTierOf("packages/services/src/a.ts")).toBe(0);
    expect(pathTierOf("docs/arch/a.md")).toBe(1);
    expect(pathTierOf("packages/services/test/a.test.ts")).toBe(2);
    expect(pathTierOf(".agents/skills/x/SKILL.md")).toBe(3);
    expect(pathTierOf("packages/services/src/fixtures/a.ts")).toBe(3);
  });

  it("splits camelCase, snake_case and kebab-case identifiers", () => {
    expect(splitCodeIdentifiers("buildCodeIndexTurnHint")).toEqual([
      "build",
      "code",
      "index",
      "turn",
      "hint",
    ]);
    expect(splitCodeIdentifiers("workspace_watcher")).toEqual(["workspace", "watcher"]);
    expect(splitCodeIdentifiers("workspace-watcher")).toEqual(["workspace", "watcher"]);
    expect(splitCodeIdentifiers("HTTPServer")).toEqual(["http", "server"]);
    // Полный идентификатор тоже попадает в токены — модель пишет и слитно, и раздельно.
    expect(searchTokensOf("buildCodeIndexTurnHint")).toContain("buildcodeindexturnhint");
  });
});
