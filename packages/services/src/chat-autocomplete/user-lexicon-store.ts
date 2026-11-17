import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CHAT_AUTOCOMPLETE_LEXICON_MAX_BYTES,
  CHAT_AUTOCOMPLETE_LEXICON_MAX_PHRASES,
  chatAutocompleteLexiconProfileSchema,
  detectLexiconLanguage,
  sanitizeForLexicon,
  type ChatAutocompleteLexiconLanguage,
  type ChatAutocompleteLexiconProfile,
} from "@zcode/shared";
import { getAppConfigDir } from "../paths.js";

/**
 * Персистентный профиль стиля и словаря пользователя (`v2/user-lexicon.json`).
 *
 * Владелец профиля — этот файл: ни UI, ни настройки не держат вторую копию.
 * Хранятся только агрегаты и словарь; любой текст проходит через
 * `sanitizeForLexicon`, поэтому секреты, письма и домашние пути не попадают
 * ни в файл, ни в промпт автодополнения.
 *
 * Запись атомарная (temp + rename) и сериализована очередью, чтобы параллельные
 * `Tab`-принятия и отправки сообщений не перетирали друг друга.
 */

/** Минимальная файловая абстракция: тесты подменяют её без реального диска. */
export interface LexiconFileBackend {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

const EMA_ALPHA = 0.35;
const MIN_PHRASE_LENGTH = 3;
const MAX_PHRASE_LENGTH = 120;
const IMPERATIVE_PATTERNS: readonly RegExp[] = [
  /^(?:сделай|добавь|исправь|проверь|перепиши|убери|реализуй|настрой)\b/iu,
  /^(?:add|fix|implement|update|remove|refactor|check|write|make)\b/iu,
  /^(?:添加|修复|实现|更新|删除|重构|检查|编写)\b/u,
];

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "это",
  "как",
  "что",
  "для",
  "или",
  "已经",
  "我们",
]);

export function userLexiconPath(): string {
  return join(getAppConfigDir(), "user-lexicon.json");
}

function createNodeBackend(): LexiconFileBackend {
  return {
    async read(path) {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
        throw error;
      }
    },
    async write(path, content) {
      await mkdir(dirname(path), { recursive: true });
      // Атомарная замена: читатель не увидит половину JSON при параллельном чтении.
      const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tempPath, content, "utf8");
      await rename(tempPath, path);
    },
    async remove(path) {
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error?.code === "ENOENT") return;
        throw error;
      });
    },
  };
}

function emptyProfile(): ChatAutocompleteLexiconProfile {
  return chatAutocompleteLexiconProfileSchema.parse({});
}

function mergePhrase(
  phrases: ChatAutocompleteLexiconProfile["frequentPhrases"],
  phrase: string,
): ChatAutocompleteLexiconProfile["frequentPhrases"] {
  const existing = phrases.find((item) => item.text === phrase);
  if (existing) {
    existing.weight = existing.weight * (1 - EMA_ALPHA) + 1;
    return phrases;
  }
  phrases.push({ text: phrase, weight: 1 });
  return phrases;
}

/** Извлекает устойчивые фразы: слова и биграммы без стоп-слов. */
export function extractLexiconPhrases(value: string): string[] {
  const sanitized = sanitizeForLexicon(value);
  if (!sanitized) return [];
  const words = sanitized
    .split(/[^\p{L}\p{N}_+#.-]+/u)
    .map((word) => word.trim())
    .filter((word) => word.length >= MIN_PHRASE_LENGTH && word.length <= MAX_PHRASE_LENGTH)
    .filter((word) => !STOP_WORDS.has(word.toLocaleLowerCase()));
  const phrases = new Set<string>();
  for (const word of words) phrases.add(word);
  for (let index = 0; index < words.length - 1; index += 1) {
    const pair = `${words[index]} ${words[index + 1]}`;
    if (pair.length <= MAX_PHRASE_LENGTH) phrases.add(pair);
  }
  return [...phrases];
}

export function extractImperativePattern(value: string): string | null {
  const sanitized = sanitizeForLexicon(value);
  if (!sanitized) return null;
  for (const pattern of IMPERATIVE_PATTERNS) {
    const match = pattern.exec(sanitized);
    if (match) return match[0].toLocaleLowerCase();
  }
  return null;
}

/**
 * Чистое обновление профиля: агрегаты и словарь, без обращения к диску.
 * Экспортируется отдельно, чтобы правила EMA и приватности покрывались тестами.
 */
export function applyObservation(
  current: ChatAutocompleteLexiconProfile,
  observation: { text: string; now: number },
): ChatAutocompleteLexiconProfile {
  const phrases = [...current.frequentPhrases];
  for (const phrase of extractLexiconPhrases(observation.text)) mergePhrase(phrases, phrase);
  phrases.sort((left, right) => right.weight - left.weight);
  const imperativePatterns = [...current.imperativePatterns];
  const imperative = extractImperativePattern(observation.text);
  if (imperative && !imperativePatterns.includes(imperative)) {
    imperativePatterns.unshift(imperative);
  }
  const samples = current.samples + 1;
  const detected: ChatAutocompleteLexiconLanguage = detectLexiconLanguage(observation.text);
  return chatAutocompleteLexiconProfileSchema.parse({
    version: 1,
    preferredLanguage:
      detected === "unknown" && current.samples > 0 ? current.preferredLanguage : detected,
    frequentPhrases: phrases.slice(0, CHAT_AUTOCOMPLETE_LEXICON_MAX_PHRASES),
    imperativePatterns: imperativePatterns.slice(0, 30),
    averageMessageChars: Math.round(
      (current.averageMessageChars * current.samples + observation.text.length) / samples,
    ),
    samples,
    updatedAt: observation.now,
  });
}

export interface UserLexiconStoreOptions {
  path?: string;
  backend?: LexiconFileBackend;
  now?: () => number;
}

export class UserLexiconStore {
  readonly #path: string;
  readonly #backend: LexiconFileBackend;
  readonly #now: () => number;
  /** Последовательная очередь записи: профиль — единственный владелец файла. */
  #queue: Promise<void> = Promise.resolve();

  constructor(options: UserLexiconStoreOptions = {}) {
    this.#path = options.path ?? userLexiconPath();
    this.#backend = options.backend ?? createNodeBackend();
    this.#now = options.now ?? (() => Date.now());
  }

  get path(): string {
    return this.#path;
  }

  async read(): Promise<ChatAutocompleteLexiconProfile | null> {
    const raw = await this.#backend.read(this.#path);
    if (!raw) return null;
    // Файл мог быть обрезан вручную: повреждённый профиль не должен ронять автодополнение.
    try {
      const parsed = chatAutocompleteLexiconProfileSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** Записать наблюдение (отправленное сообщение или принятую подсказку). */
  async observe(text: string): Promise<ChatAutocompleteLexiconProfile> {
    return this.#enqueue(async () => {
      const current = (await this.read()) ?? emptyProfile();
      const next = applyObservation(current, { text, now: this.#now() });
      await this.#write(next);
      return next;
    });
  }

  async clear(): Promise<void> {
    await this.#enqueue(async () => {
      await this.#backend.remove(this.#path);
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(operation, operation);
    // Очередь не должна накапливать отклонённые промисы: следующая запись продолжает работу.
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #write(profile: ChatAutocompleteLexiconProfile): Promise<void> {
    let serialized = JSON.stringify(profile);
    if (Buffer.byteLength(serialized, "utf8") > CHAT_AUTOCOMPLETE_LEXICON_MAX_BYTES) {
      // Лимит файла: урезаем словарь, а не пишем молча за пределы бюджета.
      const trimmed = {
        ...profile,
        frequentPhrases: profile.frequentPhrases.slice(0, 40),
        imperativePatterns: profile.imperativePatterns.slice(0, 10),
      };
      serialized = JSON.stringify(trimmed);
    }
    await this.#backend.write(this.#path, serialized);
  }
}
