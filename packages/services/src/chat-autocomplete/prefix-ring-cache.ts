import { CHAT_AUTOCOMPLETE_CACHE_ENTRIES, type ChatAutocompleteSource } from "@zcode/shared";

/**
 * Трёхрежимный кольцевой кэш префиксов.
 *
 * Назначение — не дать ghost-подсказке «мигать» при повторном вводе и отдавать
 * одинаковый префикс мгновенно (< 2 мс) без обращения к модели:
 *
 * - `exact` — префикс уже спрашивали, отдаём сохранённую подсказку как есть;
 * - `partial_typing` — пользователь дописал продолжение уже показанной подсказки,
 *   оставшийся хвост берём из кэша, не выходя в IPC;
 * - `backward_deletion` — после `Backspace` возвращаем ранее отданный хвост.
 *
 * Кэш ограничен `limit` записями на workspace (`Map` хранит порядок вставки,
 * поэтому первая запись — самая старая).
 */

export interface PrefixCacheEntry {
  /** Префикс, на который была получена подсказка. */
  prefix: string;
  /** Полная подсказка для этого префикса. */
  suggestion: string;
  recordedAt: number;
}

export interface PrefixCacheHit {
  suggestion: string;
  source: Exclude<ChatAutocompleteSource, "model_stream">;
}

export class PrefixRingCache {
  readonly #byWorkspace = new Map<string, Map<string, PrefixCacheEntry>>();
  readonly #limit: number;
  readonly #now: () => number;

  constructor(options: { limit?: number; now?: () => number } = {}) {
    this.#limit = Math.max(1, options.limit ?? CHAT_AUTOCOMPLETE_CACHE_ENTRIES);
    this.#now = options.now ?? (() => Date.now());
  }

  /** Точное попадание: тот же префикс уже отдавал подсказку. */
  lookupExact(workspaceKey: string, prefix: string): PrefixCacheHit | null {
    const entry = this.#getBucket(workspaceKey)?.get(prefix);
    return entry ? { suggestion: entry.suggestion, source: "prefix_cache_exact" } : null;
  }

  /**
   * Пользователь дописал символы, совпадающие с началом показанной подсказки:
   * возвращаем остаток и обновляем запись под новый префикс.
   */
  lookupPartialTyping(workspaceKey: string, prefix: string): PrefixCacheHit | null {
    const bucket = this.#getBucket(workspaceKey);
    if (!bucket) return null;
    for (const [cachedPrefix, entry] of bucket) {
      if (prefix.length <= cachedPrefix.length) continue;
      if (!prefix.startsWith(cachedPrefix)) continue;
      const typedTail = prefix.slice(cachedPrefix.length);
      if (!typedTail || !entry.suggestion.startsWith(typedTail)) continue;
      const rest = entry.suggestion.slice(typedTail.length);
      if (!rest) continue;
      this.record(workspaceKey, prefix, rest);
      return { suggestion: rest, source: "prefix_cache_partial" };
    }
    return null;
  }

  /**
   * После `Backspace` восстанавливаем подсказку из записи более длинного префикса.
   *
   * Продолжение для короткого префикса = удалённый пользователем хвост + уже
   * известное продолжение. Именно так ghost-текст «стоит как влитой» при удалении.
   */
  lookupBackwardDeletion(workspaceKey: string, prefix: string): PrefixCacheHit | null {
    const bucket = this.#getBucket(workspaceKey);
    if (!bucket) return null;
    for (const [cachedPrefix, entry] of bucket) {
      if (cachedPrefix.length <= prefix.length) continue;
      if (!cachedPrefix.startsWith(prefix)) continue;
      const removedTail = cachedPrefix.slice(prefix.length);
      if (!removedTail) continue;
      return {
        suggestion: `${removedTail}${entry.suggestion}`,
        source: "prefix_cache_backspace",
      };
    }
    return null;
  }

  /** Полный поиск: exact → partial_typing → backward_deletion. */
  lookup(workspaceKey: string, prefix: string): PrefixCacheHit | null {
    return (
      this.lookupExact(workspaceKey, prefix) ??
      this.lookupPartialTyping(workspaceKey, prefix) ??
      this.lookupBackwardDeletion(workspaceKey, prefix)
    );
  }

  /** Записать подсказку; пустая не кэшируется, иначе ghost-текст «оживает» на пустом месте. */
  record(workspaceKey: string, prefix: string, suggestion: string): void {
    if (!prefix || !suggestion) return;
    const bucket = this.#getBucketOrCreate(workspaceKey);
    bucket.delete(prefix);
    bucket.set(prefix, { prefix, suggestion, recordedAt: this.#now() });
    while (bucket.size > this.#limit) {
      const oldest = bucket.keys().next();
      if (oldest.done) break;
      bucket.delete(oldest.value);
    }
  }

  /** Сброс кэша workspace (смена workspace/настроек). */
  clear(workspaceKey?: string): void {
    if (workspaceKey) {
      this.#byWorkspace.delete(workspaceKey);
      return;
    }
    this.#byWorkspace.clear();
  }

  size(workspaceKey: string): number {
    return this.#getBucket(workspaceKey)?.size ?? 0;
  }

  #getBucket(workspaceKey: string): Map<string, PrefixCacheEntry> | undefined {
    return this.#byWorkspace.get(workspaceKey);
  }

  #getBucketOrCreate(workspaceKey: string): Map<string, PrefixCacheEntry> {
    const existing = this.#byWorkspace.get(workspaceKey);
    if (existing) return existing;
    const created = new Map<string, PrefixCacheEntry>();
    this.#byWorkspace.set(workspaceKey, created);
    return created;
  }
}
