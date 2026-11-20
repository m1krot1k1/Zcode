/**
 * `_meta.json` metadata-кеш Host skills service.
 *
 * Кеш хранит только разобранные поля `_meta.json` по абсолютному пути и паре
 * mtimeMs+sizeBytes. Тело `SKILL.md`, enabled-map (`config.skills`) и plugin-state
 * (`config.plugins`) здесь не кешируются: discovery читает их на каждый вызов.
 * Ограничен по числу записей и дедуплицирует одновременные чтения одного файла.
 */
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SkillMetadata } from "@zcode/shared";
import { readSkillMetadata } from "./skillFrontmatter.js";

const SKILL_META_FILE_NAME = "_meta.json";
const DEFAULT_SKILL_METADATA_CACHE_MAX_ENTRIES = 512;

export interface SkillMetadataCache {
  /** Возвращает metadata из `_meta.json` рядом с `skillPath`; отсутствие файла не кешируется. */
  read(skillPath: string): Promise<SkillMetadata | undefined>;
}

export interface SkillMetadataCacheOptions {
  /** Общий лимит записей; при переполнении вытесняется самая давно использованная. */
  maxEntries?: number;
  /** Тестовый шов: production-путь читает и разбирает реальный `_meta.json`. */
  readMetadata?: (skillPath: string) => Promise<SkillMetadata | undefined>;
}

interface SkillMetadataCacheEntry {
  mtimeMs: number;
  sizeBytes: number;
  metadata: SkillMetadata | undefined;
}

/** Версия `_meta.json`, снятая через `stat`: ключ инвалидации и in-flight. */
interface SkillMetadataStamp {
  mtimeMs: number;
  sizeBytes: number;
}

async function readMetaStamp(metaPath: string): Promise<SkillMetadataStamp | undefined> {
  try {
    const info = await stat(metaPath);
    return info.isFile() ? { mtimeMs: info.mtimeMs, sizeBytes: info.size } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Создаёт экземпляр кеша. Владелец — `createSkillsService`: один кеш на сервис,
 * поэтому `list` и `setEnabled` одного Host разделяют записи, а разные сервисы — нет.
 */
export function createSkillMetadataCache(
  options: SkillMetadataCacheOptions = {},
): SkillMetadataCache {
  const maxEntries = normalizeMaxEntries(options.maxEntries);
  const readMetadata = options.readMetadata ?? readSkillMetadata;
  const entries = new Map<string, SkillMetadataCacheEntry>();
  const inFlight = new Map<string, Promise<SkillMetadataCacheEntry>>();

  const store = (metaPath: string, entry: SkillMetadataCacheEntry): void => {
    // LRU на Map: свежая запись в конец, при переполнении вытесняется первая.
    entries.delete(metaPath);
    entries.set(metaPath, entry);
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  };

  return {
    async read(skillPath: string): Promise<SkillMetadata | undefined> {
      const metaPath = join(dirname(skillPath), SKILL_META_FILE_NAME);

      const stamp = await readMetaStamp(metaPath);
      if (!stamp) {
        // Файла нет или он недоступен: отрицательный результат не кешируем.
        // Следующий вызов снова сделает stat и подхватит позже появившийся `_meta.json`.
        entries.delete(metaPath);
        return undefined;
      }

      const cached = entries.get(metaPath);
      if (cached && cached.mtimeMs === stamp.mtimeMs && cached.sizeBytes === stamp.sizeBytes) {
        entries.delete(metaPath);
        entries.set(metaPath, cached);
        return cloneMetadata(cached.metadata);
      }

      // Bug 原因：inFlight раньше группировался только по пути, а stamp снимался до
      // await. Читатель, увидевший новый stat, присоединялся к чтению старого stamp и
      // получал устаревшие метаданные. Ключ по версии файла разделяет такие чтения.
      const flightKey = `${metaPath}:${stamp.mtimeMs}:${stamp.sizeBytes}`;
      let pending = inFlight.get(flightKey);
      if (!pending) {
        // single-flight: конкурентные list/setEnabled с одним skill делят одно чтение.
        pending = readMetadata(skillPath)
          .then(async (metadata) => {
            const entry: SkillMetadataCacheEntry = {
              ...stamp,
              // Копия нужна, чтобы мутация результата одним потребителем не меняла кеш.
              metadata: metadata ? { ...metadata } : undefined,
            };
            // Bug 原因：чтение удерживает stamp, снятый до await. Если файл изменился,
            // результат относится к старой версии: его нельзя записывать в кеш как
            // актуальный (следующий вызов должен перечитать `_meta.json`), иначе он
            // перезапишет более новую запись конкурентного читателя.
            const after = await readMetaStamp(metaPath);
            if (after && after.mtimeMs === stamp.mtimeMs && after.sizeBytes === stamp.sizeBytes) {
              store(metaPath, entry);
            }
            return entry;
          })
          .finally(() => {
            inFlight.delete(flightKey);
          });
        inFlight.set(flightKey, pending);
      }

      return cloneMetadata((await pending).metadata);
    },
  };
}

function cloneMetadata(metadata: SkillMetadata | undefined): SkillMetadata | undefined {
  return metadata ? { ...metadata } : undefined;
}

function normalizeMaxEntries(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.trunc(value))
    : DEFAULT_SKILL_METADATA_CACHE_MAX_ENTRIES;
}
