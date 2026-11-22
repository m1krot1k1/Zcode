import type { CursorCliModelDescriptor } from "../contract.js";

const MODEL_ID_PATTERN = /^[a-zA-Z0-9._:/-]+$/u;
const LINE_MARKERS = /[*>\u2713\u2714\u2190\u2192]/gu;
const CURRENT_SUFFIX = /\s*\((?:current|default|active)\)\s*$/iu;
const HEADER_LINE = /^(?:model(?:s| id)?|id|name|available models?)\b/iu;
const PROVIDER_HEADER_LINE = /^[a-zA-Z][\w .-]*:\s*$/u;
// `cursor-agent models` заканчивает вывод строкой-подсказкой (`Tip: ...`). Без этого
// фильтра первый токен `Tip:` проходил MODEL_ID_PATTERN (двоеточие допустимо) и попадал
// в каталог как отдельная модель.
const INSTRUCTIONAL_LINE = /^(?:tips?|notes?|hints?|usage|docs?|documentation)\s*:/iu;
const SEPARATOR_LINE = /^[-=_\s]+$/u;

/**
 * Разбирает текстовый вывод `cursor-agent models` / `cursor-agent --list-models`.
 * Терпим к заголовкам секций, пустым строкам, маркерам `*`, `>`, `✓` и суффиксу `(current)`.
 * `modelId` — первый токен строки, `name` — остаток; дубликаты отбрасываются по первому вхождению.
 */
export function parseCursorModelCatalog(output: string): CursorCliModelDescriptor[] {
  const models = new Map<string, CursorCliModelDescriptor>();

  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.replace(LINE_MARKERS, " ").replace(CURRENT_SUFFIX, "").trim();
    if (!line || SEPARATOR_LINE.test(line)) continue;
    if (HEADER_LINE.test(line) || PROVIDER_HEADER_LINE.test(line) || INSTRUCTIONAL_LINE.test(line))
      continue;

    const [modelId, ...rest] = line.split(/\s+/u);
    if (!modelId || modelId.endsWith(":") || !MODEL_ID_PATTERN.test(modelId)) continue;
    if (models.has(modelId)) continue;

    // Разделитель после id (`-`, `:`, `—`) не является частью имени модели.
    const name =
      rest
        .join(" ")
        .replace(/^[-:–—]+\s*/u, "")
        .trim() || modelId;
    models.set(modelId, Object.freeze({ modelId, name, source: "cli" as const }));
  }

  return [...models.values()];
}
