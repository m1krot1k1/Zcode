import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every production `new AgentRuntime(...)` must hand the child runtime the declared model
 * facts (`modelFacts`).
 *
 * Почему этот тест существует отдельно от `workflow-child-model-facts.test.ts`: три шва
 * перехвата отказа (workflow-facade, script-workflow-child, subagent/port) чинились поимённо,
 * а их охраняющие тесты называли по файлу и проверяли `toContain("modelFacts: deps.modelFacts")`.
 * Такая проверка привязана к написанию в двух известных файлах: четвёртый конструктор,
 * добавленный завтра, пройдёт молча — и владелец снова увидит «стала или нет? не стала».
 *
 * Что доказывает тест: население производственных конструкторов перечислено из файловой
 * системы, и в каждом регионе deps модель-факты присутствуют — либо в самом литерале, либо
 * в построителе, который этот литерал возвращает (общая форма `createRuntimeDeps(...)`).
 * Что НЕ доказывает: что факты в рантайме не `undefined` (это доказывает поведенческий тест
 * на живом child runtime) и что новый построитель-обёртка в другом файле не съест их снова.
 * Граница прямо названа: тест ловит добавление нового call site, а не произвольную обёртку.
 */
const SOURCE_ROOT = new URL("../../", import.meta.url).pathname;

function collectProductionTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "tests" || entry.name === "__tests__") continue;
      collectProductionTs(full, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Balanced-paren argument split for one call starting at its opening '(' index. */
function callArguments(source: string, openParenIndex: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = openParenIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      if (depth > 1) current += ch;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) {
        args.push(current);
        return args;
      }
      current += ch;
      continue;
    }
    if (ch === "," && depth === 1) {
      args.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  return args;
}

interface ConstructorSite {
  readonly file: string;
  readonly deps: string;
  readonly source: string;
}

function productionConstructorSites(): ConstructorSite[] {
  const sites: ConstructorSite[] = [];
  for (const file of collectProductionTs(SOURCE_ROOT)) {
    const source = readFileSync(file, "utf8");
    let from = 0;
    for (;;) {
      const at = source.indexOf("new AgentRuntime(", from);
      if (at < 0) break;
      from = at + 1;
      // Комментарии называют конструктор в прозе (например, progress-sink объясняет, какой
      // runtime получает порт). Такой текст — не call site: смотрим на начало строки до
      // совпадения. Строки не переписываем, поэтому литералы и URL не портятся.
      const lineStart = source.lastIndexOf("\n", at) + 1;
      const linePrefix = source.slice(lineStart, at);
      const trimmed = linePrefix.trimStart();
      if (linePrefix.includes("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
        continue;
      }
      const args = callArguments(source, at + "new AgentRuntime".length);
      // Третий аргумент — deps. Разбор обязан дать хотя бы три, иначе утверждение ниже
      // проверяло бы не тот регион.
      if (args.length < 3) {
        throw new Error(`unparsed AgentRuntime constructor in ${file}`);
      }
      sites.push({ deps: args[2] ?? "", file, source });
    }
  }
  return sites;
}

describe("every production AgentRuntime constructor carries modelFacts", () => {
  it("enumerates the real population and finds each child runtime fed", () => {
    const sites = productionConstructorSites();

    // Население не пустое: иначе тест зеленел бы на пустом списке.
    expect(sites.length).toBeGreaterThanOrEqual(4);

    const missing = sites
      .filter((site) => {
        const deps = site.deps.trim();
        // Литерал deps: факты обязаны быть в нём самом, либо в развёрнутом построителе,
        // определённом в том же файле. Проверять файл целиком нельзя: объявление
        // интерфейса тоже содержит это слово, и тест зеленел бы при пустой передаче.
        if (!deps.startsWith("{")) {
          // Прямой вызов построителя вне литерала: его тело в этом файле обязано нести факты.
          return !site.source.includes("modelFacts");
        }
        if (deps.includes("modelFacts")) return false;
        const spread = /\{\s*\.\.\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(deps);
        if (spread) {
          // Регион определения развёрнутого построителя — от `function name(` до конца файла.
          const marker = `function ${spread[1]}(`;
          const at = site.source.indexOf(marker);
          if (at >= 0) return !site.source.slice(at).includes("modelFacts");
        }
        return true;
      })
      .map((site) => site.file.replace(SOURCE_ROOT, ""));

    expect(missing).toEqual([]);
  });
});
