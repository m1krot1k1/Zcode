#!/usr/bin/env node
// Проверка «протухших» inline-исключений max-lines.
//
// Файл, который укладывается в лимит 800 эффективных строк, не должен глушить
// правило через `/* eslint-disable max-lines */` / `/* oxlint-disable eslint(max-lines) */`:
// такие комментарии скрывают, что файл уже безопасен, и мешают заметить деградацию.
//
// Скрипт намеренно не трогает тесты и i18n-локали: для них max-lines отключён
// конфигурацией, и inline-disable там не является долгом.
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SCAN_ROOTS = ["apps", "packages"];
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-node", "dist-types", "build", ".turbo", "coverage"]);
const MAX_EFFECTIVE_LINES = 800;
const DISABLE_PATTERN = /\/\*\s*(?:eslint|oxlint)-disable\s+([^*]*?)\*\//u;

function isExempt(file) {
  return (
    /\.(?:test|spec)\.tsx?$/u.test(file) ||
    file.includes("/i18n/locales/") ||
    file.endsWith(".d.ts")
  );
}

function effectiveLines(text) {
  let count = 0;
  let inBlockComment = false;
  for (const rawLine of text.split("\n")) {
    let line = rawLine.trim();
    if (!line) continue;
    if (inBlockComment) {
      const end = line.indexOf("*/");
      if (end === -1) continue;
      inBlockComment = false;
      line = line.slice(end + 2).trim();
      if (!line) continue;
    }
    if (line.startsWith("/*")) {
      const end = line.indexOf("*/", 2);
      if (end === -1) {
        inBlockComment = true;
        continue;
      }
      line = line.slice(end + 2).trim();
      if (!line) continue;
    }
    if (line.startsWith("//")) continue;
    count += 1;
  }
  return count;
}

function disablesMaxLines(text) {
  for (const line of text.split("\n")) {
    const match = DISABLE_PATTERN.exec(line);
    if (!match) continue;
    const rulePart = match[1].split("--")[0];
    const rules = rulePart
      .split(",")
      .map((rule) => rule.trim())
      .filter(Boolean);
    // Интересует только явное отключение max-lines. Пустой список правил —
    // это `eslint-disable` для всего файла (генераторы, записанные фикстуры),
    // такие случаи не являются протухшим max-lines-исключением.
    if (rules.some((rule) => rule.includes("max-lines"))) return true;
  }
  return false;
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else if (/\.tsx?$/u.test(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

const stale = [];
for (const root of SCAN_ROOTS) {
  for await (const file of walk(join(ROOT, root))) {
    if (isExempt(file)) continue;
    const text = await readFile(file, "utf8");
    if (!disablesMaxLines(text)) continue;
    const lines = effectiveLines(text);
    if (lines <= MAX_EFFECTIVE_LINES) stale.push({ file: relative(ROOT, file), lines });
  }
}

if (stale.length) {
  console.error(
    `[max-lines] ${stale.length} файл(ов) глушат max-lines, хотя укладываются в ${MAX_EFFECTIVE_LINES} строк:`,
  );
  for (const { file, lines } of stale) console.error(`  ${lines}\t${file}`);
  console.error("[max-lines] удалите устаревший inline-disable.");
  process.exit(1);
}
console.log("[max-lines] OK: протухших inline-исключений нет");
