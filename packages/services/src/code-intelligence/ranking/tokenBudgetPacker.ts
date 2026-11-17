import type { MergedSpan } from "./rrfReranker.js";
import { estimateTokens } from "../ast/types.js";

/**
 * Паковщик выдачи под токен-бюджет.
 *
 * Устраняемый дефект: v1 сериализовала ответ через `JSON.stringify(..., null, 2)` и резала
 * строку на 24 000 байт (`strategy: "truncate"`), что обрывало JSON посередине строки —
 * модель получала невалидный JSON на 45 716-символьных ответах.
 *
 * Здесь бюджет соблюдается **до** сериализации: элементы добавляются, пока суммарная оценка
 * токенов не превысит лимит. Если элемент не влезает целиком, он ужимается по синтаксической
 * сигнатуре (`scope_header` + первая строка + указание диапазона строк) либо отбрасывается.
 * Итоговый JSON всегда валиден, потому что сериализуется уже упакованная структура.
 */

export const DEFAULT_MAX_TOKENS = 4000;
/**
 * Минимальный бюджет, при котором спан ещё осмыслен: сигнатура + заголовок области видимости.
 * Меньший бюджет не «поднимается» до этого значения молча (это скрыло бы урезание),
 * а честно приводит к пустой выдаче с `truncated = true`.
 */
const MIN_SPAN_TOKENS = 32;

export interface PackedSpan {
  path: string;
  startLine: number;
  endLine: number;
  symbolName?: string;
  symbolKind?: string;
  scopeHeader: string;
  excerpt: string;
  excerptTruncated?: boolean;
  /** `true`, если тело свёрнуто до сигнатуры — модель должна прочитать диапазон целиком. */
  signatureOnly?: boolean;
  match: "lexical" | "semantic" | "exact";
  score: number;
}

export interface PackResult {
  spans: PackedSpan[];
  /** Сколько ранжированных элементов не попало в бюджет. */
  dropped: number;
  /** Сколько элементов вошло в свёрнутом виде. */
  collapsed: number;
  usedTokens: number;
  budgetTokens: number;
  /** `true`, если выдача урезана бюджетом (потребитель показывает метрику, а не битый ответ). */
  truncated: boolean;
}

function signatureExcerpt(span: MergedSpan): string {
  const lines = span.content.split("\n");
  const header = lines[0] ?? "";
  const total = lines.length;
  return `${header}\n// ... ${Math.max(0, total - 1)} more lines omitted; read ${span.startLine}-${span.endLine}`;
}

function toPacked(
  span: MergedSpan,
  excerpt: string,
  truncated: boolean,
  signatureOnly: boolean,
): PackedSpan {
  const match: PackedSpan["match"] =
    span.members > 1 ? "exact" : span.symbolName ? "exact" : "lexical";
  return {
    path: span.relPath,
    startLine: span.startLine,
    endLine: span.endLine,
    ...(span.symbolName ? { symbolName: span.symbolName } : {}),
    scopeHeader: span.scopeHeader,
    excerpt,
    ...(truncated ? { excerptTruncated: true } : {}),
    ...(signatureOnly ? { signatureOnly: true } : {}),
    match,
    score: Number(span.score.toFixed(6)),
  };
}

/**
 * Упаковывает спаны в бюджет. `usedTokens` считается по фактическому содержимому
 * (заголовок + excerpt), поэтому оценка не «оптимистична».
 */
export function packSpans(
  spans: readonly MergedSpan[],
  maxTokens: number = DEFAULT_MAX_TOKENS,
  maxSpans = 50,
): PackResult {
  const budgetTokens = Math.max(1, Math.floor(maxTokens));
  const packed: PackedSpan[] = [];
  let usedTokens = 0;
  let dropped = 0;
  let collapsed = 0;

  for (const span of spans) {
    const fullExcerpt = span.content;
    const fullCost = estimateTokens(fullExcerpt) + estimateTokens(span.scopeHeader);
    if (
      packed.length >= maxSpans ||
      (usedTokens + fullCost > budgetTokens && budgetTokens < MIN_SPAN_TOKENS)
    ) {
      // Бюджет меньше минимально полезного спана: элементы не «подтягиваются» до лимита,
      // а честно отбрасываются, иначе урезание было бы скрыто от потребителя.
      dropped += 1;
      continue;
    }
    if (usedTokens + fullCost <= budgetTokens) {
      packed.push(toPacked(span, fullExcerpt, false, false));
      usedTokens += fullCost;
      continue;
    }
    const signature = signatureExcerpt(span);
    const signatureCost = estimateTokens(signature) + estimateTokens(span.scopeHeader);
    if (usedTokens + signatureCost <= budgetTokens) {
      packed.push(toPacked(span, signature, false, true));
      usedTokens += signatureCost;
      collapsed += 1;
      continue;
    }
    // Даже сигнатура не влезает — элемент отбрасывается целиком, JSON остаётся валидным.
    dropped += 1;
  }

  return {
    spans: packed,
    dropped,
    collapsed,
    usedTokens,
    budgetTokens,
    truncated: dropped > 0 || collapsed > 0,
  };
}

/**
 * Дополнительная страховка: сериализованный результат не должен превышать байтовый лимит.
 * Если превышает — отбрасываем последние элементы (никогда не режем строку).
 */
export function enforceByteLimit<T extends { spans: PackedSpan[] }>(
  result: T,
  maxBytes: number,
): T & { byteDropped: number } {
  let dropped = 0;
  let current: T = result;
  for (;;) {
    const bytes = Buffer.byteLength(JSON.stringify(current), "utf8");
    if (bytes <= maxBytes || current.spans.length === 0) break;
    current = { ...current, spans: current.spans.slice(0, -1) };
    dropped += 1;
  }
  return { ...current, byteDropped: dropped };
}
