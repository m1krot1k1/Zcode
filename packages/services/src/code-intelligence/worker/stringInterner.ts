import type { IndexDatabase } from "./store.js";

/**
 * Интернирование строк в таблицу `strings(string_id, value)` со `UNIQUE` по значению.
 *
 * Причина: в схеме v2 `chunks.scope_header` занимал 14.84 МБ при 106 661 уникальном значении,
 * а `unresolved_refs.target_name` — 9.91 МБ при 65 016 уникальных. Около 90 % этих байтов
 * были повторами. UNIQUE-индекс дедуплицирует значения, а ссылка целым числом занимает 1–3 байта.
 *
 * Контракт кеша: отображение `value → id` живёт в памяти в пределах транзакции записи файла и
 * очищается методом `reset()` между транзакциями, поэтому устаревший id не переиспользуется.
 *
 * `id = 0` зарезервирован за «пустым» значением: `refs.spec_id = 0` означает отсутствие
 * спецификатора и не требует строки в `strings`.
 */
export class StringInterner {
  private readonly known = new Map<string, number>();
  /** Последний выданный id: восстанавливается из БД при первом обращении. */
  private nextId: number;

  constructor(private readonly db: IndexDatabase) {
    const row = this.db.prepare("SELECT COALESCE(MAX(string_id), 0) AS top FROM strings").get() as
      | { top?: number }
      | undefined;
    this.nextId = Number(row?.top ?? 0);
  }

  /** Возвращает id значения, вставляя его при первом обращении. */
  intern(value: string): number {
    if (!value) return 0;
    const cached = this.known.get(value);
    if (cached !== undefined) return cached;
    // `strings` объявлена `WITHOUT ROWID` с первичным ключом по `value`, поэтому вставка
    // без явного `string_id` невозможна. Идентификатор выделяется монотонным счётчиком.
    this.nextId += 1;
    const candidate = this.nextId;
    this.db
      .prepare("INSERT INTO strings(value, string_id) VALUES(?, ?) ON CONFLICT(value) DO NOTHING")
      .run(value, candidate);
    const row = this.db.prepare("SELECT string_id FROM strings WHERE value = ?").get(value) as
      | { string_id?: number }
      | undefined;
    const id = Number(row?.string_id ?? 0);
    if (id > 0) {
      this.known.set(value, id);
      if (id >= this.nextId) this.nextId = id;
    }
    return id;
  }

  /** Массовое заполнение кеша: один `SELECT` на пачку вместо запроса на каждое значение. */
  preload(values: Iterable<string>): void {
    const unique = [...new Set([...values].filter((value) => value.length > 0))];
    for (let offset = 0; offset < unique.length; offset += 400) {
      const batch = unique.slice(offset, offset + 400);
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT string_id, value FROM strings WHERE value IN (${placeholders})`)
        .all(...batch) as Array<{ string_id: number; value: string }>;
      for (const row of rows) this.known.set(String(row.value), Number(row.string_id));
    }
  }

  reset(): void {
    this.known.clear();
  }
}

