import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, stat, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { SQLInputValue } from "node:sqlite";
import {
  CONNECTION_PRAGMAS,
  INITIALIZE_PRAGMAS,
  LEGACY_TABLES,
  REQUIRED_COLUMNS,
  SCHEMA_VERSION,
  SCHEMA_V3_SQL,
  type SchemaProbe,
} from "./storeSchema.js";

const requireFromHere = createRequire(import.meta.url);
const { DatabaseSync } = requireFromHere("node:sqlite") as typeof import("node:sqlite");

export type IndexDatabase = InstanceType<typeof DatabaseSync>;

export interface Row extends Record<string, unknown> {
  [key: string]: unknown;
}

export interface OpenOutcome {
  db: IndexDatabase;
  created: boolean;
  /** `true`, если схема v1 была реально заменена схемой v2 (запись об этом идёт в лог/диагностику). */
  migratedFromV1: boolean;
  legacySizeBytes: number;
}

function tableExists(db: IndexDatabase, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
    .get(name) as Row | undefined;
  return Boolean(row);
}

/**
 * Проверяет, что в существующей базе есть все обязательные колонки v2.
 * Причина: база, созданная промежуточной сборкой, имеет `schema_version = 2`, но без новых
 * колонок. Молча продолжать работу нельзя — запись упала бы на «no such column» уже
 * в процессе индексации. Найденный дрейф трактуется как требование пересоздания кэша.
 */
export function schemaDriftOf(db: IndexDatabase): string[] {
  const available = new Map<string, Map<string, string>>();
  const drift: string[] = [];
  for (const { table, column, type } of REQUIRED_COLUMNS) {
    let columns = available.get(table);
    if (!columns) {
      columns = new Map<string, string>();
      try {
        const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name?: unknown;
          type?: unknown;
        }>;
        for (const row of rows) {
          if (typeof row.name === "string") {
            columns.set(row.name, typeof row.type === "string" ? row.type.toUpperCase() : "");
          }
        }
      } catch {
        // Таблицы нет — все её колонки считаются отсутствующими.
      }
      available.set(table, columns);
    }
    const actual = columns.get(column);
    if (actual === undefined) {
      drift.push(`${table}.${column}`);
      continue;
    }
    // Проверка типа нужна для колонок, чей тип менялся между сборками (сжатие `chunks.content`).
    if (type && actual !== type) drift.push(`${table}.${column}:${type}`);
  }
  return drift;
}

/** Читает признак версии схемы без модификации файла. */
export function probeSchema(filePath: string): SchemaProbe {
  let db: IndexDatabase | undefined;
  try {
    // Проверка существования до открытия: `new DatabaseSync` создаёт пустой файл, а пустая
    // база получает page_size по умолчанию (4096), после чего `PRAGMA page_size` уже не
    // действует и целевой размер страницы недостижим. Отсутствующий файл — «схемы нет».
    if (!existsSync(filePath)) return { version: 0, legacy: false, exists: false };
    db = new DatabaseSync(filePath);
    const legacy = tableExists(db, "index_meta");
    const hasFiles = tableExists(db, "files");
    if (!hasFiles && !legacy) return { version: 0, legacy: false, exists: true };
    if (legacy) return { version: 1, legacy: true, exists: true };
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | Row
      | undefined;
    return { version: Number(row?.value ?? 0), legacy: false, exists: true };
  } catch {
    return { version: 0, legacy: false, exists: false };
  } finally {
    try {
      db?.close();
    } catch {
      // Файл мог быть закрыт ниже; здесь важно лишь не потерять исходную ошибку.
    }
  }
}

/**
 * Открывает БД актуальной схемы (v3).
 *
 * Миграция выполняется **явно** и имеет три источника:
 *  - схема v1 (`index_meta` + текстовые ключи) — пересоздание с записью `migrated_from=v1@<size>`;
 *  - схема v2 (406.7 МБ, `unresolved_refs`, `symbols_fts`, `chunks.content`) — пересоздание с
 *    записью `migrated_from=v2@<size>`. Данные v2 не переносятся построчно намеренно: это
 *    локальный кеш, а построчный перенос потребовал бы распаковки 164 000 чанков и пересборки
 *    FTS ради тех же самых значений. Переиндексация идёт в фоне и даёт идентичный результат;
 *  - дрейф колонок внутри одной версии (промежуточная сборка) — пересоздание с перечислением
 *    отсутствующих колонок в `migrated_from`.
 *
 * Пользовательские данные (файлы на диске) не затрагиваются. После пересоздания выполняется
 * `VACUUM`: он применяет `page_size` из `INITIALIZE_PRAGMAS` (для существующего файла размер
 * страницы меняется только так) и возвращает место, занятое старой схемой.
 */
export async function openStore(filePath: string): Promise<OpenOutcome> {
  await mkdir(dirname(filePath), { recursive: true });
  let legacySizeBytes = 0;
  try {
    const info = await stat(filePath);
    legacySizeBytes = info.size;
  } catch {
    legacySizeBytes = 0;
  }
  const probe = probeSchema(filePath);
  // `page_size` и `auto_vacuum` действуют только до первой записи в файл, поэтому для
  // отсутствующего файла pragmas выставляются сразу после создания — ДО создания любой
  // таблицы и ДО включения WAL. Иначе база фиксирует page_size=4096 по умолчанию, и
  // целевой размер страницы уже не применить без пересоздания.
  const openFresh = (): IndexDatabase => {
    const fresh = new DatabaseSync(filePath);
    for (const pragma of INITIALIZE_PRAGMAS) {
      try {
        fresh.exec(pragma);
      } catch {
        // pagma уровня файла применима к новому файлу всегда; защита от экзотических сборок.
      }
    }
    for (const pragma of CONNECTION_PRAGMAS) fresh.exec(pragma);
    return fresh;
  };
  const openExisting = (): IndexDatabase => {
    const existing = new DatabaseSync(filePath);
    for (const pragma of CONNECTION_PRAGMAS) existing.exec(pragma);
    return existing;
  };
  let db = probe.exists ? openExisting() : openFresh();

  let migratedFromV1 = false;
  let created = false;
  // Дрейф имеет смысл только для уже существующей схемы: у новой БД таблиц ещё нет,
  // и любая проверка колонок дала бы ложное «требуется пересоздание».
  const hasSchema = probe.legacy || tableExists(db, "files");
  const drift = hasSchema ? schemaDriftOf(db) : [];
  // Дрейф колонок и смена версии одинаково требуют пересоздания: это локальный кеш.
  const versionMismatch =
    !probe.legacy && hasSchema && probe.version > 0 && probe.version !== SCHEMA_VERSION;
  const needsRebuild = probe.legacy || (hasSchema && drift.length > 0) || versionMismatch;

  if (hasSchema && needsRebuild) {
    const from =
      probe.legacy && probe.version === 1
        ? `v1@${legacySizeBytes}`
        : versionMismatch
          ? `v${probe.version}@${legacySizeBytes}`
          : `v${probe.version || 2}-drift@${drift.join(",")}`;
    // Пересоздание файла вместо `DROP` + `VACUUM`.
    //
    // Причина: `PRAGMA page_size` и `auto_vacuum` действуют только на уровне файла и не
    // применяются к уже открытой базе — `VACUUM` подхватывает page_size лишь в некоторых
    // сборках SQLite, поэтому полагаться на него нельзя (проверено: после VACUUM размер
    // страницы оставался 4096). Кроме того, VACUUM 426 МБ занимает минуты и требует
    // удвоенного свободного места.
    //
    // Индекс — восстановимый кеш, единственный владелец которого этот сервис, поэтому
    // старый файл удаляется целиком и создаётся заново с целевыми параметрами страницы.
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      await rm(`${filePath}${suffix}`, { force: true });
    }
    db = openFresh();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(SCHEMA_V3_SQL);
      writeMeta(db, "schema_version", String(SCHEMA_VERSION));
      writeMeta(db, "migrated_from", from);
      writeMeta(db, "migrated_at", String(Date.now()));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      db.close();
      throw error;
    }
    migratedFromV1 = probe.legacy;
  } else if (!hasSchema) {
    // Новая база: pragmas уровня файла уже выставлены в `openFresh` до первого DDL.
    db.exec(SCHEMA_V3_SQL);
    writeMeta(db, "schema_version", String(SCHEMA_VERSION));
    created = true;
  } else {
    // Схема актуальна: DDL идемпотентен и добавляет отсутствующие объекты (например,
    // индекс `idx_chunks_symbol` в базе, созданной сборкой без него).
    db.exec(SCHEMA_V3_SQL);
    if (readMeta(db, "schema_version") !== String(SCHEMA_VERSION)) {
      writeMeta(db, "schema_version", String(SCHEMA_VERSION));
    }
  }
  return { db, created, migratedFromV1, legacySizeBytes };
}

/**
 * Возвращает освободившиеся страницы файлу.
 *
 * `auto_vacuum = INCREMENTAL` включается только для новых БД, поэтому в мигрированной базе
 * вызов является no-op. Функция всё равно нужна: после массовых удалений (удаление файлов,
 * очистка индекса) она возвращает место, если incremental-режим активен.
 */
export function compactDatabase(db: IndexDatabase): void {
  try {
    db.exec("PRAGMA incremental_vacuum");
  } catch {
    // Best-effort: невозможность вернуть страницы не делает индекс нерабочим.
  }
}

export function readMeta(db: IndexDatabase, key: string): string | undefined {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
    return typeof row?.value === "string" ? row.value : undefined;
  } catch {
    return undefined;
  }
}

export function writeMeta(db: IndexDatabase, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function allRows<T extends Row>(
  db: IndexDatabase,
  sql: string,
  ...parameters: SQLInputValue[]
): T[] {
  return db.prepare(sql).all(...parameters) as T[];
}

export function firstRow<T extends Row>(
  db: IndexDatabase,
  sql: string,
  ...parameters: SQLInputValue[]
): T | undefined {
  return db.prepare(sql).get(...parameters) as T | undefined;
}

export function countOf(db: IndexDatabase, table: string): number {
  const row = firstRow<Row>(db, `SELECT COUNT(*) AS value FROM ${table}`);
  return Number(row?.value ?? 0);
}

/** Размер БД на диске вместе с WAL — то, что реально занимает место у пользователя. */
export async function databaseSizeBytes(filePath: string): Promise<number> {
  let total = 0;
  for (const suffix of ["", "-wal"]) {
    try {
      total += (await stat(`${filePath}${suffix}`)).size;
    } catch {
      // Отсутствующий WAL — нормальное состояние после checkpoint.
    }
  }
  return total;
}

export { SCHEMA_VERSION };
