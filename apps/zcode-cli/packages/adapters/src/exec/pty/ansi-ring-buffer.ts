/**
 * ANSI/CSI-разбор и кольцевой буфер с монотонными seq.
 *
 * Парсер не «вырезает мусор» регуляркой: он распознаёт escape-последовательности
 * по ECMA-48, чтобы корректно пережить разрезанный между чанками `ESC [` и
 * не потерять обычные байты. Незавершённая последовательность сохраняется и
 * дополняется следующим чанком.
 */
import type { PtyChunk } from "./contract.js";

/** Распознанная escape-последовательность и её границы. */
export interface ParsedAnsi {
  /** Текст без управляющих последовательностей. */
  text: string;
  /** Найденные последовательности в порядке появления. */
  sequences: string[];
  /**
   * Незавершённый хвост (`ESC`, `ESC [`, `ESC [ 1 ;`) — переносится в следующий чанк.
   * Без этого SGR, разрезанный между двумя `onData`, теряется или протекает в текст.
   */
  pending: string;
}

const ESC = "\u001b";
const BEL = "\u0007";

/**
 * Разбирает поток ANSI. Поддерживаются:
 * - CSI (`ESC [ ... <final 0x40–0x7E>`) — SGR, курсор, очистка;
 * - OSC (`ESC ] ... BEL | ESC \`) — заголовки терминала;
 * - двухбайтовые (`ESC <single>`) и простые управляющие (`\r`, `\b`).
 */
export function parseAnsi(input: string, carry = ""): ParsedAnsi {
  const source = carry + input;
  let text = "";
  const sequences: string[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index]!;
    if (char !== ESC) {
      // Одиночный CR в PTY-потоке — возврат каретки; LF остаётся переводом строки.
      if (char === "\r") {
        const next = source[index + 1];
        if (next === "\n") {
          text += "\r\n";
          index += 2;
          continue;
        }
        text += "\r";
        index += 1;
        continue;
      }
      text += char;
      index += 1;
      continue;
    }

    const next = source[index + 1];
    if (next === undefined) {
      return { text, sequences, pending: source.slice(index) };
    }

    if (next === "[") {
      // CSI: параметры 0x30–0x3F, промежуточные 0x20–0x2F, финальный 0x40–0x7E.
      let cursor = index + 2;
      while (cursor < source.length && /[\d;?<=>:]/.test(source[cursor]!)) cursor += 1;
      while (cursor < source.length && /[ !"#$%&'()*+,\-./]/.test(source[cursor]!)) cursor += 1;
      const final = source[cursor];
      if (final === undefined) {
        return { text, sequences, pending: source.slice(index) };
      }
      sequences.push(source.slice(index, cursor + 1));
      index = cursor + 1;
      continue;
    }

    if (next === "]") {
      // OSC завершается BEL или ST (ESC \).
      let cursor = index + 2;
      while (cursor < source.length) {
        if (source[cursor] === BEL) {
          cursor += 1;
          break;
        }
        if (source[cursor] === ESC && source[cursor + 1] === "\\") {
          cursor += 2;
          break;
        }
        cursor += 1;
      }
      if (cursor >= source.length && source[cursor - 1] !== BEL && source[cursor - 1] !== "\\") {
        return { text, sequences, pending: source.slice(index) };
      }
      sequences.push(source.slice(index, cursor));
      index = cursor;
      continue;
    }

    // Двухбайтовые ESC-последовательности (например, `ESC ( B`, `ESC M`).
    const consume = next === "(" || next === ")" ? 3 : 2;
    if (index + consume > source.length) {
      return { text, sequences, pending: source.slice(index) };
    }
    sequences.push(source.slice(index, index + consume));
    index += consume;
  }

  return { text, sequences, pending: "" };
}

/** Полностью вычищает ANSI из строки, если незавершённый хвост не важен. */
export function stripAnsi(input: string): string {
  return parseAnsi(input).text;
}

interface StoredChunk {
  seq: number;
  text: string;
  controlSequences: string[];
  at: number;
  bytes: number;
}

/**
 * Кольцевой буфер с монотонными seq.
 *
 * Владелец памяти — буфер: при переполнении вытесняются самые старые чанки, а
 * `truncatedBytes`/`firstSeq` показывают, что именно потеряно. `read(sinceSeq)`
 * возвращает только новые чанки и флаг `truncatedFrom`, если запрошенная позиция
 * уже вытеснена.
 */
export class AnsiRingBuffer {
  private readonly chunks: StoredChunk[] = [];
  private pendingAnsi = "";
  private bytes = 0;
  private nextSeq = 1;
  private truncatedBytesTotal = 0;
  private lastActivityAt = 0;

  constructor(private readonly maxBytes: number) {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new Error("AnsiRingBuffer requires a positive maxBytes");
    }
  }

  /** Добавляет сырой чанк из PTY; возвращает сохранённый чанк (или `undefined`). */
  append(raw: string): StoredChunk | undefined {
    if (raw.length === 0) return undefined;
    const parsed = parseAnsi(raw, this.pendingAnsi);
    this.pendingAnsi = parsed.pending;
    // Текст пуст, но последовательности были — сохраняем факт, не создавая чанк.
    if (parsed.text.length === 0 && parsed.sequences.length === 0) return undefined;

    const stored: StoredChunk = {
      seq: this.nextSeq++,
      text: parsed.text,
      controlSequences: parsed.sequences,
      at: Date.now(),
      bytes: Buffer.byteLength(parsed.text, "utf8"),
    };
    this.chunks.push(stored);
    this.bytes += stored.bytes;
    this.lastActivityAt = stored.at;
    this.evict();
    return stored;
  }

  /** Вытесняет старые чанки, пока не влезет в бюджет. */
  private evict(): void {
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      const removed = this.chunks.shift()!;
      this.bytes -= removed.bytes;
      this.truncatedBytesTotal += removed.bytes;
    }
    // Одиночный чанк больше бюджета: режем его хвостом, чтобы не терять свежий вывод.
    const head = this.chunks[0];
    if (head && this.bytes > this.maxBytes) {
      const buffer = Buffer.from(head.text, "utf8");
      const kept = buffer.subarray(buffer.length - this.maxBytes).toString("utf8");
      const dropped = buffer.length - Buffer.byteLength(kept, "utf8");
      head.text = kept;
      head.bytes = Buffer.byteLength(kept, "utf8");
      this.bytes = head.bytes;
      this.truncatedBytesTotal += dropped;
    }
  }

  read(sinceSeq = 0): { chunks: StoredChunk[]; truncatedFrom?: number } {
    const firstSeq = this.chunks[0]?.seq;
    const truncatedFrom =
      firstSeq === undefined || sinceSeq + 1 >= firstSeq ? undefined : firstSeq - 1;
    const chunks =
      sinceSeq <= 0 ? [...this.chunks] : this.chunks.filter((chunk) => chunk.seq > sinceSeq);
    return { chunks, ...(truncatedFrom !== undefined ? { truncatedFrom } : {}) };
  }

  /** Снимок для внешнего контракта: копии, чтобы вызывающий не мутировал буфер. */
  readAsChunks(sinceSeq = 0): { chunks: PtyChunk[]; truncatedFrom?: number } {
    const { chunks, truncatedFrom } = this.read(sinceSeq);
    return {
      chunks: chunks.map((chunk) => ({
        seq: chunk.seq,
        text: chunk.text,
        controlSequences: [...chunk.controlSequences],
        at: chunk.at,
      })),
      ...(truncatedFrom !== undefined ? { truncatedFrom } : {}),
    };
  }

  /** Склеенный текст после `sinceSeq` — удобно для проверки pattern. */
  textSince(sinceSeq = 0): string {
    return this.read(sinceSeq)
      .chunks.map((chunk) => chunk.text)
      .join("");
  }

  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  get firstSeq(): number {
    return this.chunks[0]?.seq ?? this.nextSeq;
  }

  get truncatedBytes(): number {
    return this.truncatedBytesTotal;
  }

  get storedBytes(): number {
    return this.bytes;
  }

  get idleSince(): number {
    return this.lastActivityAt;
  }

  /** Освобождает память; seq продолжает расти, чтобы не ломать `sinceSeq`. */
  clear(): void {
    this.chunks.length = 0;
    this.bytes = 0;
    this.pendingAnsi = "";
  }
}
