/**
 * Декларативные правила извлечения символов/ссылок по языкам.
 *
 * Имена узлов взяты не из документации, а из фактического разбора грамматиками
 * `tree-sitter-wasms@0.1.13` (см. `docs/architecture/stage4-3-code-intelligence-benchmark.md`,
 * раздел «Проверка грамматик»). Примеры подтверждённых структур:
 *  - typescript: `program` → `export_statement` → `class_declaration[Foo]` / `interface_declaration[Iface]`
 *    / `type_alias_declaration[T]` / `function_declaration[top]` / `lexical_declaration`;
 *  - go: `source_file` → `type_declaration`→`type_spec[S]`, `method_declaration[M]`, `function_declaration[Top]`;
 *  - rust: `source_file` → `struct_item[S]`, `impl_item`, `trait_item[T]`, `function_item[top]`;
 *  - python: `module` → `function_definition[foo]`, `class_definition[Foo]` (body — `block`);
 *  - java: `program` → `class_declaration[C]`/`interface_declaration[I]` (наследование: `superclass`, `super_interfaces`);
 *  - c: `translation_unit` → `function_definition` (имя внутри `function_declarator`), `struct_specifier[S]`;
 *  - bash: `program` → `function_definition[foo]`.
 */

export type SymbolKindCode = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
/** 1 class, 2 interface, 3 type, 4 function, 5 method, 6 variable/const, 7 enum, 8 module/namespace */
export const SYMBOL_KIND = {
  class: 1,
  interface: 2,
  type: 3,
  function: 4,
  method: 5,
  variable: 6,
  enum: 7,
  module: 8,
} as const;

export const SYMBOL_KIND_NAME: Record<number, string> = {
  1: "class",
  2: "interface",
  3: "type",
  4: "function",
  5: "method",
  6: "variable",
  7: "enum",
  8: "module",
};

export const EDGE_RELATION = {
  defines: 1,
  references: 2,
  calls: 3,
  imports: 4,
  extends: 5,
  implements: 6,
} as const;

export const EDGE_RELATION_NAME: Record<number, string> = {
  1: "defines",
  2: "references",
  3: "calls",
  4: "imports",
  5: "extends",
  6: "implements",
};

export interface DefinitionRule {
  /** Тип узла, объявляющий символ. */
  node: string;
  kind: SymbolKindCode;
  /** Поле с именем; `null` — имя вычисляется правилом `nameFrom`. */
  nameField?: string;
  /** Для C/C++: имя лежит внутри `function_declarator`/`declarator`. */
  declaratorName?: boolean;
  /** Поле тела объявления: по нему строятся вложенные чанки. */
  bodyField?: string;
  /** Типы узлов, которые внутри тела объявления трактуются как методы. */
  memberNode?: string;
  exported?: "modifier" | "always" | "capitalized";
}

export interface LanguageRule {
  /** Тип корневого узла (для проверки, что грамматика соответствует правилу). */
  root: string;
  definitions: DefinitionRule[];
  /** Типы узлов-вызовов. */
  callNodes: string[];
  /** Типы узлов-импортов. */
  importNodes: string[];
  /** Поле/узел, дающий строковый литерал спецификатора импорта. */
  importSourceField?: string;
  /** Узлы наследования. */
  extendsNodes: string[];
  implementsNodes: string[];
}

const TS_LIKE: LanguageRule = {
  root: "program",
  definitions: [
    {
      node: "class_declaration",
      kind: SYMBOL_KIND.class,
      nameField: "name",
      bodyField: "body",
      memberNode: "method_definition",
      exported: "modifier",
    },
    {
      node: "abstract_class_declaration",
      kind: SYMBOL_KIND.class,
      nameField: "name",
      bodyField: "body",
      memberNode: "method_definition",
      exported: "modifier",
    },
    {
      node: "class",
      kind: SYMBOL_KIND.class,
      nameField: "name",
      bodyField: "body",
      memberNode: "method_definition",
      exported: "modifier",
    },
    {
      node: "interface_declaration",
      kind: SYMBOL_KIND.interface,
      nameField: "name",
      bodyField: "body",
      exported: "modifier",
    },
    {
      node: "type_alias_declaration",
      kind: SYMBOL_KIND.type,
      nameField: "name",
      exported: "modifier",
    },
    {
      node: "enum_declaration",
      kind: SYMBOL_KIND.enum,
      nameField: "name",
      bodyField: "body",
      exported: "modifier",
    },
    {
      node: "function_declaration",
      kind: SYMBOL_KIND.function,
      nameField: "name",
      bodyField: "body",
      exported: "modifier",
    },
    {
      node: "generator_function_declaration",
      kind: SYMBOL_KIND.function,
      nameField: "name",
      bodyField: "body",
      exported: "modifier",
    },
    {
      node: "method_definition",
      kind: SYMBOL_KIND.method,
      nameField: "name",
      bodyField: "body",
    },
    {
      node: "lexical_declaration",
      kind: SYMBOL_KIND.variable,
      bodyField: "body",
      exported: "modifier",
    },
    {
      node: "variable_declaration",
      kind: SYMBOL_KIND.variable,
      bodyField: "body",
      exported: "modifier",
    },
    {
      node: "module",
      kind: SYMBOL_KIND.module,
      nameField: "name",
      bodyField: "body",
      exported: "modifier",
    },
    { node: "internal_module", kind: SYMBOL_KIND.module, nameField: "name", bodyField: "body" },
  ],
  callNodes: ["call_expression", "new_expression"],
  importNodes: ["import_statement", "export_statement", "import_alias"],
  importSourceField: "source",
  extendsNodes: ["class_heritage", "extends_clause", "class_declaration"],
  implementsNodes: ["implements_clause"],
};

const PYTHON: LanguageRule = {
  root: "module",
  definitions: [
    {
      node: "class_definition",
      kind: SYMBOL_KIND.class,
      nameField: "name",
      bodyField: "body",
      memberNode: "function_definition",
      exported: "capitalized",
    },
    {
      node: "function_definition",
      kind: SYMBOL_KIND.function,
      nameField: "name",
      bodyField: "body",
      exported: "capitalized",
    },
    { node: "decorated_definition", kind: SYMBOL_KIND.function, bodyField: "definition" },
  ],
  callNodes: ["call"],
  importNodes: ["import_statement", "import_from_statement"],
  extendsNodes: ["argument_list"],
  implementsNodes: [],
};

const GO: LanguageRule = {
  root: "source_file",
  definitions: [
    // `type_declaration` не объявляется символом: имя и границы принадлежат вложенному
    // `type_spec` (проверено разбором грамматики), иначе один тип попадал в индекс дважды.
    { node: "type_spec", kind: SYMBOL_KIND.type, nameField: "name", bodyField: "type" },
    {
      node: "function_declaration",
      kind: SYMBOL_KIND.function,
      nameField: "name",
      bodyField: "body",
      exported: "capitalized",
    },
    {
      node: "method_declaration",
      kind: SYMBOL_KIND.method,
      nameField: "name",
      bodyField: "body",
      exported: "capitalized",
    },
    {
      node: "const_declaration",
      kind: SYMBOL_KIND.variable,
      bodyField: "body",
      exported: "capitalized",
    },
    {
      node: "var_declaration",
      kind: SYMBOL_KIND.variable,
      bodyField: "body",
      exported: "capitalized",
    },
  ],
  callNodes: ["call_expression"],
  importNodes: ["import_declaration"],
  extendsNodes: [],
  implementsNodes: [],
};

const RUST: LanguageRule = {
  root: "source_file",
  definitions: [
    { node: "struct_item", kind: SYMBOL_KIND.class, nameField: "name", exported: "modifier" },
    { node: "enum_item", kind: SYMBOL_KIND.enum, nameField: "name", exported: "modifier" },
    { node: "trait_item", kind: SYMBOL_KIND.interface, nameField: "name", exported: "modifier" },
    { node: "type_item", kind: SYMBOL_KIND.type, nameField: "name", exported: "modifier" },
    { node: "union_item", kind: SYMBOL_KIND.class, nameField: "name", exported: "modifier" },
    {
      node: "impl_item",
      kind: SYMBOL_KIND.module,
      bodyField: "body",
      memberNode: "function_item",
    },
    {
      node: "function_item",
      kind: SYMBOL_KIND.function,
      nameField: "name",
      bodyField: "body",
      exported: "modifier",
    },
    { node: "mod_item", kind: SYMBOL_KIND.module, nameField: "name", bodyField: "body" },
  ],
  callNodes: ["call_expression", "macro_invocation"],
  importNodes: ["use_declaration", "extern_crate_declaration"],
  extendsNodes: ["impl_item"],
  implementsNodes: ["impl_item"],
};

const JAVA: LanguageRule = {
  root: "program",
  definitions: [
    {
      node: "class_declaration",
      kind: SYMBOL_KIND.class,
      nameField: "name",
      bodyField: "body",
      memberNode: "method_declaration",
    },
    {
      node: "interface_declaration",
      kind: SYMBOL_KIND.interface,
      nameField: "name",
      bodyField: "body",
      memberNode: "method_declaration",
    },
    {
      node: "enum_declaration",
      kind: SYMBOL_KIND.enum,
      nameField: "name",
      bodyField: "body",
      memberNode: "method_declaration",
    },
    { node: "record_declaration", kind: SYMBOL_KIND.class, nameField: "name", bodyField: "body" },
    { node: "method_declaration", kind: SYMBOL_KIND.method, nameField: "name", bodyField: "body" },
    {
      node: "constructor_declaration",
      kind: SYMBOL_KIND.method,
      nameField: "name",
      bodyField: "body",
    },
  ],
  callNodes: ["method_invocation", "object_creation_expression"],
  importNodes: ["import_declaration", "package_declaration"],
  extendsNodes: ["superclass"],
  implementsNodes: ["super_interfaces"],
};

const KOTLIN: LanguageRule = {
  root: "source_file",
  definitions: [
    {
      node: "class_declaration",
      kind: SYMBOL_KIND.class,
      bodyField: "class_body",
      memberNode: "function_declaration",
    },
    { node: "object_declaration", kind: SYMBOL_KIND.class, bodyField: "class_body" },
    { node: "function_declaration", kind: SYMBOL_KIND.function, bodyField: "function_body" },
    { node: "property_declaration", kind: SYMBOL_KIND.variable },
  ],
  callNodes: ["call_expression"],
  importNodes: ["import_header", "import_list"],
  extendsNodes: ["delegation_specifier"],
  implementsNodes: ["delegation_specifier"],
};

const C_LIKE: LanguageRule = {
  root: "translation_unit",
  definitions: [
    {
      node: "function_definition",
      kind: SYMBOL_KIND.function,
      declaratorName: true,
      bodyField: "body",
    },
    { node: "struct_specifier", kind: SYMBOL_KIND.class, nameField: "name", bodyField: "body" },
    { node: "enum_specifier", kind: SYMBOL_KIND.enum, nameField: "name", bodyField: "body" },
    { node: "type_definition", kind: SYMBOL_KIND.type, declaratorName: true },
    {
      node: "namespace_definition",
      kind: SYMBOL_KIND.module,
      nameField: "name",
      bodyField: "body",
    },
    {
      node: "class_specifier",
      kind: SYMBOL_KIND.class,
      nameField: "name",
      bodyField: "body",
      memberNode: "function_definition",
    },
  ],
  callNodes: ["call_expression"],
  importNodes: ["preproc_include"],
  extendsNodes: ["base_class_clause"],
  implementsNodes: [],
};

const CSHARP: LanguageRule = {
  root: "compilation_unit",
  definitions: [
    {
      node: "namespace_declaration",
      kind: SYMBOL_KIND.module,
      nameField: "name",
      bodyField: "body",
    },
    { node: "file_scoped_namespace_declaration", kind: SYMBOL_KIND.module, nameField: "name" },
    {
      node: "class_declaration",
      kind: SYMBOL_KIND.class,
      nameField: "name",
      bodyField: "body",
      memberNode: "method_declaration",
    },
    {
      node: "interface_declaration",
      kind: SYMBOL_KIND.interface,
      nameField: "name",
      bodyField: "body",
      memberNode: "method_declaration",
    },
    {
      node: "enum_declaration",
      kind: SYMBOL_KIND.enum,
      nameField: "name",
      bodyField: "body",
    },
    {
      node: "struct_declaration",
      kind: SYMBOL_KIND.class,
      nameField: "name",
      bodyField: "body",
      memberNode: "method_declaration",
    },
    {
      node: "record_declaration",
      kind: SYMBOL_KIND.class,
      nameField: "name",
      bodyField: "body",
      memberNode: "method_declaration",
    },
    { node: "method_declaration", kind: SYMBOL_KIND.method, nameField: "name", bodyField: "body" },
    { node: "property_declaration", kind: SYMBOL_KIND.variable, nameField: "name" },
  ],
  callNodes: ["invocation_expression", "object_creation_expression"],
  importNodes: ["using_directive"],
  extendsNodes: ["base_list"],
  implementsNodes: ["base_list"],
};

const RUBY: LanguageRule = {
  root: "program",
  definitions: [
    {
      node: "class",
      kind: SYMBOL_KIND.class,
      nameField: "name",
      bodyField: "body",
      memberNode: "method",
    },
    { node: "module", kind: SYMBOL_KIND.module, nameField: "name", bodyField: "body" },
    { node: "method", kind: SYMBOL_KIND.method, nameField: "name", bodyField: "body" },
    { node: "singleton_method", kind: SYMBOL_KIND.method, nameField: "name", bodyField: "body" },
  ],
  callNodes: ["call", "method_call"],
  importNodes: ["call"],
  extendsNodes: ["superclass"],
  implementsNodes: [],
};

const PHP: LanguageRule = {
  root: "program",
  definitions: [
    {
      node: "namespace_definition",
      kind: SYMBOL_KIND.module,
      nameField: "name",
      bodyField: "body",
    },
    {
      node: "class_declaration",
      kind: SYMBOL_KIND.class,
      nameField: "name",
      bodyField: "body",
      memberNode: "method_declaration",
    },
    {
      node: "interface_declaration",
      kind: SYMBOL_KIND.interface,
      nameField: "name",
      bodyField: "body",
      memberNode: "method_declaration",
    },
    { node: "trait_declaration", kind: SYMBOL_KIND.class, nameField: "name", bodyField: "body" },
    { node: "enum_declaration", kind: SYMBOL_KIND.enum, nameField: "name", bodyField: "body" },
    {
      node: "function_definition",
      kind: SYMBOL_KIND.function,
      nameField: "name",
      bodyField: "body",
    },
    { node: "method_declaration", kind: SYMBOL_KIND.method, nameField: "name", bodyField: "body" },
  ],
  callNodes: ["function_call_expression", "member_call_expression", "object_creation_expression"],
  importNodes: ["namespace_use_declaration", "include_expression", "require_expression"],
  extendsNodes: ["base_clause"],
  implementsNodes: ["class_interface_clause"],
};

const BASH: LanguageRule = {
  root: "program",
  definitions: [
    {
      node: "function_definition",
      kind: SYMBOL_KIND.function,
      nameField: "name",
      bodyField: "body",
    },
    { node: "variable_assignment", kind: SYMBOL_KIND.variable, nameField: "name" },
  ],
  callNodes: ["command"],
  importNodes: ["command"],
  extendsNodes: [],
  implementsNodes: [],
};

const CONFIG_LIKE: LanguageRule = {
  root: "document",
  definitions: [],
  callNodes: [],
  importNodes: [],
  extendsNodes: [],
  implementsNodes: [],
};

const HTML: LanguageRule = {
  root: "document",
  definitions: [
    { node: "element", kind: SYMBOL_KIND.module, bodyField: "content" },
    { node: "script_element", kind: SYMBOL_KIND.module },
    { node: "style_element", kind: SYMBOL_KIND.module },
  ],
  callNodes: [],
  importNodes: [],
  extendsNodes: [],
  implementsNodes: [],
};

const CSS: LanguageRule = {
  root: "stylesheet",
  definitions: [
    { node: "rule_set", kind: SYMBOL_KIND.module, bodyField: "block" },
    { node: "media_statement", kind: SYMBOL_KIND.module, bodyField: "block" },
    { node: "keyframes_statement", kind: SYMBOL_KIND.module, bodyField: "block" },
  ],
  callNodes: [],
  importNodes: ["import_statement"],
  extendsNodes: [],
  implementsNodes: [],
};

const VUE: LanguageRule = {
  root: "component",
  definitions: [
    { node: "template_element", kind: SYMBOL_KIND.module, bodyField: "children" },
    { node: "script_element", kind: SYMBOL_KIND.module },
    { node: "style_element", kind: SYMBOL_KIND.module },
  ],
  callNodes: [],
  importNodes: [],
  extendsNodes: [],
  implementsNodes: [],
};

const RULES: Record<string, LanguageRule> = {
  typescript: TS_LIKE,
  tsx: TS_LIKE,
  javascript: TS_LIKE,
  jsx: TS_LIKE,
  python: PYTHON,
  go: GO,
  rust: RUST,
  java: JAVA,
  kotlin: KOTLIN,
  c: C_LIKE,
  cpp: C_LIKE,
  csharp: CSHARP,
  ruby: RUBY,
  php: PHP,
  bash: BASH,
  json: CONFIG_LIKE,
  toml: CONFIG_LIKE,
  html: HTML,
  css: CSS,
  vue: VUE,
};

export function rulesForLanguage(languageName: string): LanguageRule | undefined {
  return RULES[languageName];
}

/** Узлы, которые не несут смысла для чанкинга и пропускаются при обходе. */
export const TRIVIAL_NODE_TYPES = new Set([
  "comment",
  "line_comment",
  "block_comment",
  "string",
  "string_literal",
  "template_string",
  "regex",
  "jsx_text",
  "text",
]);
