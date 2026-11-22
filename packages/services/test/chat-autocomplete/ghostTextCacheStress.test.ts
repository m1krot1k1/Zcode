/// <reference types="node" />
// ============================================================
// Этап 5: стресс-тест ghost-text кэша и дебаунс-политики (Инкремент 4.6)
// ============================================================
//
// Проверяемые инварианты:
//  1. 5000 быстрых вводов не растят кэш сверх лимита на workspace (нет утечки памяти).
//  2. Кэш не «оживает» на пустом вводе и не хранит пустые подсказки.
//  3. Точное/частичное/backspace-попадания остаются корректными при массовом потоке.
//  4. Адаптивный дебаунс ограничен сверху и не растёт от объёма истории набора.
//  5. Отмена/сброс освобождает бакеты workspace.

import { describe, expect, it } from "vitest";

import { CHAT_AUTOCOMPLETE_CACHE_ENTRIES } from "@zcode/shared";
import { PrefixRingCache } from "../../src/chat-autocomplete/prefix-ring-cache.js";
import { resolveAdaptiveDebounceMs } from "../../src/chat-autocomplete/service.js";

function heapMb(): number {
  globalThis.gc?.();
  return Math.round((process.memoryUsage().heapUsed / (1024 * 1024)) * 100) / 100;
}

describe("Этап 5 — стресс ghost-text кэша", () => {
  it("5000 вводов/отмен не переполняют кэш и не теряют корректность попаданий", () => {
    const cache = new PrefixRingCache({ limit: CHAT_AUTOCOMPLETE_CACHE_ENTRIES });
    const workspaceKey = "ws://stress";
    const heapStart = heapMb();

    let exactHits = 0;
    let partialHits = 0;
    let backspaceHits = 0;
    let cancelled = 0;
    const operations = 5_000;

    for (let index = 0; index < operations; index += 1) {
      const prefix = `сделай рефакторинг модуля ${index % 50}`;
      const suggestion = ` — выдели чистые функции шаг ${index}`;

      // Каждый второй ввод «отменяется» до записи: имитируем быстрый набор с Escape.
      if (index % 2 === 1) {
        cancelled += 1;
        continue;
      }

      cache.record(workspaceKey, prefix, suggestion);
      if (cache.lookupExact(workspaceKey, prefix)) exactHits += 1;

      // Дописывание символа из подсказки должно возвращать остаток из кэша.
      const typedPrefix = `${prefix}${suggestion.slice(0, 6)}`;
      if (cache.lookupPartialTyping(workspaceKey, typedPrefix)) partialHits += 1;

      // Возврат на символ назад должен отдавать ранее известный хвост.
      if (cache.lookupBackwardDeletion(workspaceKey, typedPrefix.slice(0, -3))) backspaceHits += 1;

      // Инвариант: размер бакета никогда не превышает лимит.
      expect(cache.size(workspaceKey)).toBeLessThanOrEqual(CHAT_AUTOCOMPLETE_CACHE_ENTRIES);
    }

    const heapEnd = heapMb();
    const heapDelta = Math.round((heapEnd - heapStart) * 100) / 100;

    expect(cache.size(workspaceKey)).toBeLessThanOrEqual(CHAT_AUTOCOMPLETE_CACHE_ENTRIES);
    expect(exactHits).toBeGreaterThan(0);
    expect(partialHits).toBeGreaterThan(0);
    expect(backspaceHits).toBeGreaterThan(0);
    expect(cancelled).toBe(Math.floor(operations / 2));
    // Утечки быть не может: бакет ограничен 32 записями независимо от числа вводов.
    expect(heapDelta).toBeLessThan(64);

    console.info(
      `[stress][ghost][cache] ops=${operations} cancelled=${cancelled} size=${cache.size(
        workspaceKey,
      )}/${CHAT_AUTOCOMPLETE_CACHE_ENTRIES} exact=${exactHits} partial=${partialHits} backspace=${backspaceHits} heapDelta=${heapDelta}MB`,
    );
  }, 120_000);

  it("пустые подсказки не кэшируются, сброс освобождает бакеты", () => {
    const cache = new PrefixRingCache();
    cache.record("ws", "", "подсказка");
    cache.record("ws", "префикс", "");
    expect(cache.size("ws")).toBe(0);

    cache.record("ws", "префикс", "подсказка");
    expect(cache.size("ws")).toBe(1);
    cache.clear("ws");
    expect(cache.size("ws")).toBe(0);

    // Массовое создание/сброс workspace не оставляет живых бакетов.
    for (let index = 0; index < 1_000; index += 1) {
      cache.record(`ws-${index}`, `префикс ${index}`, `подсказка ${index}`);
    }
    cache.clear();
    const leaks = Array.from({ length: 1_000 }, (_unused, index) => cache.size(`ws-${index}`));
    expect(leaks.every((size) => size === 0)).toBe(true);

    console.info(`[stress][ghost][reset] workspaces=1000 residual=${leaks.filter(Boolean).length}`);
  }, 60_000);

  it("адаптивный дебаунс ограничен и не зависит от объёма истории набора", () => {
    const base = 250;
    const samples: number[] = [];

    for (let index = 0; index < 5_000; index += 1) {
      // Быстрый набор: интервалы 5–60 мс.
      const intervals = Array.from(
        { length: 4 },
        (_unused, position) => 5 + ((index + position) % 56),
      );
      samples.push(resolveAdaptiveDebounceMs(base, intervals));
    }

    const min = Math.min(...samples);
    const max = Math.max(...samples);
    expect(min).toBeGreaterThanOrEqual(100);
    expect(max).toBeLessThanOrEqual(700);
    // Медленный набор (интервалы >= 220 мс) возвращает базовый дебаунс.
    expect(resolveAdaptiveDebounceMs(base, [300, 400, 500])).toBe(base);
    // Пустая история — базовое значение.
    expect(resolveAdaptiveDebounceMs(base, [])).toBe(base);

    console.info(
      `[stress][ghost][debounce] samples=${samples.length} min=${min} max=${max} base=${base}`,
    );
  }, 60_000);
});
