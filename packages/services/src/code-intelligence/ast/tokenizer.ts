/**
 * Детерминированная токенизация идентификаторов для FTS5 и локального векторного скетча.
 *
 * Проблема, которую это решает: запрос `buildCodeIndexTurnHint` не находил
 * `build_code_index_turn_hint`, а `workspaceWatcher` — `workspace-watcher`.
 * Поэтому один и тот же идентификатор индексируется в трёх формах:
 *  1. как есть в нижнем регистре (`buildcodeindexturnhint`),
 *  2. под-слова через camelCase/snake_case/kebab-case (`build code index turn hint`),
 *  3. полный путь с разделением на сегменты (`packages services src ...`).
 */

const IDENTIFIER_PARTS = /[\p{Lu}]+(?=[\p{Lu}][\p{Ll}]|\d|$)|[\p{Lu}]?[\p{Ll}\d]+|\p{N}+/gu;
const WORD = /[\p{L}\p{N}_$-]+/gu;

/** Разбивает идентификатор на под-слова: `HTTPServer` → `http server`, `a_b-c` → `a b c`. */
export function splitCodeIdentifiers(value: string): string[] {
  const parts: string[] = [];
  for (const chunk of value.split(/[^\p{L}\p{N}_$-]+/u)) {
    if (!chunk) continue;
    for (const piece of chunk.split(/[_-]+/u)) {
      if (!piece) continue;
      const matched = piece.match(IDENTIFIER_PARTS);
      if (matched) parts.push(...matched);
      else parts.push(piece);
    }
  }
  return parts.map((part) => part.toLowerCase()).filter((part) => part.length > 0);
}

/**
 * Слова с сохранением исходного регистра — обязательный вход для `splitCodeIdentifiers`.
 * Причина: без сохранения регистра `hybridSearch` уже неразделим на `hybrid`/`search`.
 * Из-за этого запрос из двух слов не находил документ, индексированный как слитный
 * идентификатор.
 */
function rawWordsOf(value: string): string[] {
  const matched = value.match(WORD);
  return matched ? matched : [];
}

/**
 * Все поисковые токены значения: полный идентификатор, его под-слова и отдельные слова.
 * Дедупликация обязательна — FTS-документ раздувается пропорционально повторам.
 */
export function searchTokensOf(value: string): string[] {
  const tokens = new Set<string>();
  for (const word of rawWordsOf(value)) {
    const lower = word.toLowerCase();
    if (lower.length < 2) continue;
    tokens.add(lower);
    for (const part of splitCodeIdentifiers(word)) {
      if (part.length >= 2) tokens.add(part);
    }
  }
  return [...tokens];
}

/** Строка для FTS5: токены через пробел, без дублей; ограничение защищает от гигантских файлов. */
export function ftsDocumentOf(tokens: Iterable<string>, limit = 4000): string {
  const unique = new Set<string>();
  for (const token of tokens) {
    if (!token) continue;
    unique.add(token);
    if (unique.size >= limit) break;
  }
  return [...unique].join(" ");
}

/** Экранирование терма для `MATCH`: FTS5 принимает quoted-фразы литерально. */
export function quoteFtsTerm(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

/**
 * Разбиение запроса на поисковые термы. Пунктуация отбрасывается, но `camelCase`
 * внутри запроса тоже разбивается — модель часто пишет `workspaceWatcher`, ожидая найти файл
 * `workspace-watcher.ts`.
 */
export function queryTermsOf(query: string, limit = 24): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const token of searchTokensOf(query)) {
    if (token.length < 2 || seen.has(token)) continue;
    seen.add(token);
    terms.push(token);
    if (terms.length >= limit) break;
  }
  return terms;
}
