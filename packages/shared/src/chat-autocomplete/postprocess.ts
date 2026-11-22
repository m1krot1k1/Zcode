import {
  CHAT_AUTOCOMPLETE_MAX_SUGGESTION_CHARS,
  type ChatAutocompleteLexiconLanguage,
} from "./contract.js";

/**
 * Чистые пост-обработчики ghost-подсказки и фильтр приватности профиля лексики.
 *
 * Выделены из `contract.ts`, чтобы контракт оставался компактным. Модуль по-прежнему
 * чистый: без IO и без обращения к модели.
 */

/**
 * Адаптивный дебаунс ghost-подсказки.
 *
 * База приходит из настроек (250 мс по умолчанию). Если пользователь печатает
 * заметно быстрее человеческой медианы (~220 мс), ожидание растёт до ~700 мс:
 * это и экономит токены, и убирает «мигание» подсказок между нажатиями.
 */
export function resolveAdaptiveGhostDebounceMs(
  baseMs: number,
  recentIntervalsMs: readonly number[],
): number {
  const floor = Math.max(100, Math.min(1_000, baseMs));
  const humanIntervals = recentIntervalsMs.filter((value) => value > 0 && value < 1_500);
  if (humanIntervals.length < 2) return floor;
  const sorted = [...humanIntervals].sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)] ?? floor;
  if (median >= 220) return floor;
  const growth = Math.round((220 - median) * 2.2);
  return Math.min(700, floor + growth);
}

const MULTILINE_CUT = /[\r\n]/;

/**
 * Срезает продолжение до первой строки и отбрасывает строки-комментарии кода:
 * ghost-текст должен оставаться коротким однострочным продолжением мысли.
 */
export function clipGhostSuggestion(
  raw: string,
  maxChars = CHAT_AUTOCOMPLETE_MAX_SUGGESTION_CHARS,
): string {
  const trimmed = raw.replace(/^\s+/, "");
  if (!trimmed) return "";
  const newlineAt = trimmed.search(MULTILINE_CUT);
  const firstLine = newlineAt >= 0 ? trimmed.slice(0, newlineAt) : trimmed;
  const withoutCodeComment = firstLine.replace(/\s*(?:\/\/|\/\*|#).*$/, "").trimEnd();
  return withoutCodeComment.slice(0, maxChars);
}

/**
 * Устраняет дублирование недописанного слова: модель на BPE-границе повторяет
 * хвост префикса, и ghost-текст начинал бы «мигать».
 */
export function removePrefixOverlap(prefix: string, suggestion: string): string {
  if (!suggestion) return "";
  let overlap = 0;
  const maxOverlap = Math.min(prefix.length, suggestion.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (prefix.endsWith(suggestion.slice(0, size))) {
      overlap = size;
      break;
    }
  }
  const sliced = suggestion.slice(overlap);
  // Без ведущего пробела приём `ArrowRight` склеил бы слова.
  return overlap > 0 && /^[A-Za-z0-9]/.test(sliced) && !/\s$/.test(prefix) ? ` ${sliced}` : sliced;
}

/** Следующее слово для пословного принятия подсказки (`ArrowRight`). */
export function takeNextWord(suggestion: string): {
  word: string;
  rest: string;
} {
  const match = /^\s*\S+\s*/.exec(suggestion);
  if (!match) return { word: "", rest: suggestion };
  return { word: match[0], rest: suggestion.slice(match[0].length) };
}

/** Причина, по которой продолжение звучит как ответ или план ассистента. */
export type AssistantVoiceViolation =
  | "assistant_action_plan"
  | "assistant_meta_commentary"
  | "assistant_markup_plan";

interface AssistantVoicePattern {
  reason: AssistantVoiceViolation;
  pattern: RegExp;
}

/** Глаголы первого лица, которыми ассистент описывает собственные действия. */
const RU_ASSISTANT_ACTION_VERBS = [
  "изучу",
  "изучим",
  "посмотрю",
  "посмотрим",
  "проверю",
  "проверим",
  "проанализирую",
  "проанализируем",
  "исследую",
  "прочитаю",
  "прочитаем",
  "открою",
  "откроем",
  "найду",
  "найд[её]м",
  "разберусь",
  "разбер[её]мся",
  "запущу",
  "запустим",
  "выполню",
  "выполним",
  "гляну",
  "глянем",
  "начну",
  "начн[её]м",
].join("|");

const RU_SEQUENCE_MARKERS =
  "сначала|затем|потом|далее|после этого|теперь|сейчас|для начала|первым делом|в первую очередь";

/**
 * Детерминированный фильтр ассистентского голоса.
 *
 * Причина бага: модель иногда отвечает на черновик пользователя как ассистент
 * («Сначала изучу…, затем проверю»). Промпт снижает вероятность, но не гарантирует
 * голос, поэтому явные ассистентские конструкции отбрасываются на контракте.
 * Проверяется только начало подсказки: легитимные пользовательские продолжения
 * («Сначала надо проверить…», «Проверить, что…») не блокируются.
 */
const ASSISTANT_VOICE_PATTERNS: readonly AssistantVoicePattern[] = [
  {
    reason: "assistant_action_plan",
    // «Сначала изучу…», «Затем проверю…», «Далее проанализирую…».
    pattern: new RegExp(
      `^(?:${RU_SEQUENCE_MARKERS})\\s*[,:]?\\s*(?:я\\s+)?(?:${RU_ASSISTANT_ACTION_VERBS})(?![а-яёa-z])`,
      "iu",
    ),
  },
  {
    reason: "assistant_action_plan",
    // «Проверю…», «Изучу…», «Начну с…» без временного маркера.
    pattern: new RegExp(`^(?:я\\s+)?(?:${RU_ASSISTANT_ACTION_VERBS})(?![а-яёa-z])`, "iu"),
  },
  {
    reason: "assistant_action_plan",
    // «Давайте посмотрим…» — обращение к пользователю/себе.
    pattern:
      /^(?:давай|давайте)\s+(?:я\s+)?(?:посмотрим|проверим|изучим|разбер[её]мся|начн[её]м|глянем)(?![а-яёa-z])/iu,
  },
  {
    reason: "assistant_action_plan",
    // «First, I check…», «Then I will inspect…».
    pattern:
      /^(?:first|then|next)\s*,?\s*(?:i|i'll|i will|i'm going to|i am going to)\s+(?:check|review|examine|inspect|look|read|open|find|search|analy[sz]e|start|begin|implement|update|run|fix|add|write|verify|confirm)\b/i,
  },
  {
    reason: "assistant_action_plan",
    // «I'll check…», «Let me look…», «Let's start…».
    pattern:
      /^(?:i'll|i will|i'm going to|i am going to|let me|let's)\s+(?:check|review|examine|inspect|look|read|open|find|search|analy[sz]e|start|begin|implement|update|run|fix|add|write|verify|confirm)\b/i,
  },
  {
    reason: "assistant_meta_commentary",
    // «Конечно, вот…», «Понял, сейчас…», «Хорошо, я…».
    pattern:
      /^(?:конечно|разумеется|хорошо|отлично|понял|поняла|принято)\s*[,!.:]?\s*(?:вот|сейчас|давайте|я|ниже)(?![а-яёa-z])/iu,
  },
  {
    reason: "assistant_meta_commentary",
    // «Вот что…», «Ниже…», «Надеюсь…», «Как ИИ…».
    pattern:
      /^(?:вот что|вот как|ниже|итак|надеюсь|если (?:нужно|хотите|вам нужно)|дайте знать|обратите внимание|как (?:ии|ассистент|языковая модель))(?![а-яёa-z])/iu,
  },
  {
    reason: "assistant_meta_commentary",
    pattern:
      /^(?:i'm sorry|i am sorry|i cannot|i can't|as an ai|as a language model|here's|here is|below is|hope this helps|feel free|of course|absolutely|great question)\b/i,
  },
  {
    reason: "assistant_markup_plan",
    // Заголовки, code fences, цитаты и именованные планы.
    pattern: /^(?:#{1,6}\s|```|>\s|(?:план|шаги|steps?)\s*[:.-]|(?:шаг|step)\s*\d)/iu,
  },
];

/**
 * Снимает обёртки, не меняющие голос: кавычки, markdown-акценты, маркеры списка и
 * номер пункта. Нумерованный пользовательский список сам по себе не запрещён —
 * номер снимается только для распознавания начала фразы.
 */
function normalizeAssistantVoiceHead(suggestion: string): string {
  return (
    suggestion
      .trimStart()
      .replace(/^\d+[.)]\s+/, "")
      .replace(/^[-+*•·]\s+/, "")
      // Обратные кавычки не снимаем: code fence `\`\`\`` должен попасть в markup-правило.
      .replace(/^["'«»*_]+/, "")
      .trimStart()
  );
}

/**
 * Возвращает причину отказа, если продолжение звучит как ассистент, иначе `null`.
 * Чистая функция: без IO и без обращения к модели.
 */
export function detectAssistantVoiceSuggestion(suggestion: string): AssistantVoiceViolation | null {
  if (!suggestion.trim()) return null;
  const head = normalizeAssistantVoiceHead(suggestion);
  if (!head) return null;
  for (const candidate of ASSISTANT_VOICE_PATTERNS) {
    if (candidate.pattern.test(head)) return candidate.reason;
  }
  return null;
}

/**
 * Пропускает пользовательское продолжение без изменений; ассистентский голос
 * превращает в пустую строку (существующая семантика `empty_suggestion`).
 */
export function filterAssistantVoiceSuggestion(suggestion: string): string {
  return detectAssistantVoiceSuggestion(suggestion) ? "" : suggestion;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bghp_[A-Za-z0-9]{10,}/g,
  /\bgho_[A-Za-z0-9]{10,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi,
  /\bAKIA[0-9A-Z]{12,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}/g,
];
const EMAIL_PATTERN = /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g;
const LONG_PATH_PATTERN = /(?:\/Users|\/home|C:\\Users)\/[^\s"']+/g;
const PASSWORD_ASSIGNMENT_PATTERN = /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi;

/** Оценка энтропии Шеннона на символ: высокая энтропия = потенциальный секрет. */
export function shannonEntropyPerChar(value: string): number {
  if (!value) return 0;
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

const HIGH_ENTROPY_THRESHOLD = 4.2;
const HIGH_ENTROPY_MIN_LENGTH = 24;

/**
 * Фильтр приватности профиля лексики: перед записью в `user-lexicon.json`
 * вырезаются секреты, письма, домашние пути и высокоэнтропийные токены.
 * Возвращает `null`, если после очистки не осталось полезного текста.
 */
export function sanitizeForLexicon(value: string): string | null {
  let text = value;
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, " ");
  text = text
    .replace(EMAIL_PATTERN, " ")
    .replace(LONG_PATH_PATTERN, " ")
    .replace(PASSWORD_ASSIGNMENT_PATTERN, " ");
  const kept = text
    .split(/\s+/)
    .filter(
      (word) =>
        !(
          word.length >= HIGH_ENTROPY_MIN_LENGTH &&
          shannonEntropyPerChar(word) > HIGH_ENTROPY_THRESHOLD
        ),
    )
    .join(" ")
    .trim();
  return kept.length >= 3 ? kept : null;
}

/** Грубое определение языка общения по символам и частым служебным словам. */
export function detectLexiconLanguage(value: string): ChatAutocompleteLexiconLanguage {
  const text = value.trim();
  if (!text) return "unknown";
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";
  if (/[\u0400-\u04ff]/.test(text)) return "ru";
  if (/\b(?:the|and|please|add|fix|implement|update|remove|test)\b/i.test(text)) return "en";
  return "unknown";
}
