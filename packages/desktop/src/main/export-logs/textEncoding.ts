// 文本文件编码识别：脱敏必须按真实编码解码与回写，否则 UTF-16 日志会被当成二进制原样复制，
// 敏感字段就绕过了上面的脱敏规则。
import type { SupportedTextEncoding, TextFileEncodingInfo } from "./types.js";

export const TEXT_DETECTION_SAMPLE_BYTES = 64 * 1024;
const EMPTY_BOM = Buffer.alloc(0);

interface TextDecodingScore {
  preferredCharRatio: number;
  invalidCharRatio: number;
}

function detectUtf16EncodingByNullPattern(sample: Buffer): SupportedTextEncoding | null {
  if (sample.length < 4) {
    return null;
  }

  let evenByteCount = 0;
  let oddByteCount = 0;
  let evenNullCount = 0;
  let oddNullCount = 0;

  for (let index = 0; index < sample.length; index += 1) {
    if (index % 2 === 0) {
      evenByteCount += 1;
      if (sample[index] === 0) {
        evenNullCount += 1;
      }
      continue;
    }

    oddByteCount += 1;
    if (sample[index] === 0) {
      oddNullCount += 1;
    }
  }

  const evenNullRatio = evenNullCount / Math.max(evenByteCount, 1);
  const oddNullRatio = oddNullCount / Math.max(oddByteCount, 1);
  const likelyUtf16Ratio = 0.3;
  const noiseThreshold = 0.1;
  if (oddNullRatio >= likelyUtf16Ratio && evenNullRatio <= noiseThreshold) {
    return "utf-16le";
  }
  if (evenNullRatio >= likelyUtf16Ratio && oddNullRatio <= noiseThreshold) {
    return "utf-16be";
  }
  return null;
}

function isLikelyAsciiTextByte(byteValue: number): boolean {
  return (
    byteValue === 0x09 ||
    byteValue === 0x0a ||
    byteValue === 0x0d ||
    (byteValue >= 0x20 && byteValue <= 0x7e)
  );
}

function isPreferredTextCodePoint(codePoint: number): boolean {
  if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d || codePoint === 0x20) {
    return true;
  }
  if (codePoint >= 0x20 && codePoint <= 0x7e) {
    return true;
  }
  if (codePoint >= 0x4e00 && codePoint <= 0x9fff) {
    return true;
  }
  if (codePoint >= 0x3400 && codePoint <= 0x4dbf) {
    return true;
  }
  if (codePoint >= 0x3000 && codePoint <= 0x303f) {
    return true;
  }
  if (codePoint >= 0xff00 && codePoint <= 0xffef) {
    return true;
  }
  if (codePoint >= 0x3040 && codePoint <= 0x30ff) {
    return true;
  }
  if (codePoint >= 0xac00 && codePoint <= 0xd7af) {
    return true;
  }
  return false;
}

function scoreDecodedTextForEncodingDetection(decodedText: string): TextDecodingScore {
  let totalCodePointCount = 0;
  let preferredCodePointCount = 0;
  let invalidCodePointCount = 0;

  for (const character of decodedText) {
    totalCodePointCount += 1;
    const codePoint = character.codePointAt(0) ?? 0;

    if (
      codePoint === 0xfffd ||
      codePoint === 0 ||
      codePoint === 0x7f ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      (codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)
    ) {
      invalidCodePointCount += 1;
      continue;
    }
    if (isPreferredTextCodePoint(codePoint)) {
      preferredCodePointCount += 1;
    }
  }

  const denominator = Math.max(totalCodePointCount, 1);
  return {
    preferredCharRatio: preferredCodePointCount / denominator,
    invalidCharRatio: invalidCodePointCount / denominator,
  };
}

function detectUtf16EncodingByDecodedTextScore(sample: Buffer): SupportedTextEncoding | null {
  if (sample.length < 4) {
    return null;
  }

  const normalizedSampleLength = sample.length - (sample.length % 2);
  if (normalizedSampleLength < 4) {
    return null;
  }
  const normalizedSample = sample.subarray(0, normalizedSampleLength);

  const utf16LeScore = scoreDecodedTextForEncodingDetection(
    new TextDecoder("utf-16le").decode(normalizedSample),
  );
  const utf16BeScore = scoreDecodedTextForEncodingDetection(
    new TextDecoder("utf-16be").decode(normalizedSample),
  );

  const minimumPreferredCharRatio = 0.55;
  const maximumInvalidCharRatio = 0.2;
  const minimumPreferredCharRatioGap = 0.08;

  const utf16LeQualified =
    utf16LeScore.preferredCharRatio >= minimumPreferredCharRatio &&
    utf16LeScore.invalidCharRatio <= maximumInvalidCharRatio;
  const utf16BeQualified =
    utf16BeScore.preferredCharRatio >= minimumPreferredCharRatio &&
    utf16BeScore.invalidCharRatio <= maximumInvalidCharRatio;

  if (utf16LeQualified && !utf16BeQualified) {
    return "utf-16le";
  }
  if (utf16BeQualified && !utf16LeQualified) {
    return "utf-16be";
  }
  if (!utf16LeQualified && !utf16BeQualified) {
    return null;
  }

  const preferredRatioGap = Math.abs(
    utf16LeScore.preferredCharRatio - utf16BeScore.preferredCharRatio,
  );
  if (preferredRatioGap >= minimumPreferredCharRatioGap) {
    return utf16LeScore.preferredCharRatio > utf16BeScore.preferredCharRatio
      ? "utf-16le"
      : "utf-16be";
  }

  return utf16LeScore.invalidCharRatio <= utf16BeScore.invalidCharRatio ? "utf-16le" : "utf-16be";
}

function isValidUtf8Sample(sample: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

function detectUtf16EncodingByAsciiPairPattern(sample: Buffer): SupportedTextEncoding | null {
  if (sample.length < 4) {
    return null;
  }

  let utf16LeRunLength = 0;
  let utf16BeRunLength = 0;
  let utf16LeAsciiRunScore = 0;
  let utf16BeAsciiRunScore = 0;

  // CJK 文本里会出现“单个码元低字节刚好是 0”的情况（如 U+4E00），
  // 直接统计 `0x00 + ASCII` 配对会把这些离散噪声误判成另一端字节序。
  // 这里改为统计“连续 ASCII-零字节 run”，只把成段英文 token（api key/header）作为有效信号。
  const flushRunScore = (runLength: number): number => (runLength >= 3 ? runLength : 0);

  for (let index = 0; index + 1 < sample.length; index += 2) {
    const leftByte = sample[index] ?? 0;
    const rightByte = sample[index + 1] ?? 0;

    if (rightByte === 0 && isLikelyAsciiTextByte(leftByte)) {
      utf16LeRunLength += 1;
      utf16BeAsciiRunScore += flushRunScore(utf16BeRunLength);
      utf16BeRunLength = 0;
      continue;
    }
    if (leftByte === 0 && isLikelyAsciiTextByte(rightByte)) {
      utf16BeRunLength += 1;
      utf16LeAsciiRunScore += flushRunScore(utf16LeRunLength);
      utf16LeRunLength = 0;
      continue;
    }

    utf16LeAsciiRunScore += flushRunScore(utf16LeRunLength);
    utf16BeAsciiRunScore += flushRunScore(utf16BeRunLength);
    utf16LeRunLength = 0;
    utf16BeRunLength = 0;
  }

  utf16LeAsciiRunScore += flushRunScore(utf16LeRunLength);
  utf16BeAsciiRunScore += flushRunScore(utf16BeRunLength);

  const minimumAsciiRunScore = 6;
  const dominanceRatio = 1.5;
  if (
    utf16LeAsciiRunScore >= minimumAsciiRunScore &&
    utf16LeAsciiRunScore >= utf16BeAsciiRunScore * dominanceRatio
  ) {
    return "utf-16le";
  }
  if (
    utf16BeAsciiRunScore >= minimumAsciiRunScore &&
    utf16BeAsciiRunScore >= utf16LeAsciiRunScore * dominanceRatio
  ) {
    return "utf-16be";
  }
  return null;
}

export function detectTextFileEncoding(sample: Buffer): TextFileEncodingInfo | null {
  if (sample.length === 0) {
    return { encoding: "utf-8", bomLength: 0, bomBytes: EMPTY_BOM };
  }

  if (sample.length >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) {
    return {
      encoding: "utf-8",
      bomLength: 3,
      bomBytes: Buffer.from([0xef, 0xbb, 0xbf]),
    };
  }

  if (sample.length >= 2 && sample[0] === 0xff && sample[1] === 0xfe) {
    return {
      encoding: "utf-16le",
      bomLength: 2,
      bomBytes: Buffer.from([0xff, 0xfe]),
    };
  }
  if (sample.length >= 2 && sample[0] === 0xfe && sample[1] === 0xff) {
    return {
      encoding: "utf-16be",
      bomLength: 2,
      bomBytes: Buffer.from([0xfe, 0xff]),
    };
  }

  if (!sample.includes(0) && isValidUtf8Sample(sample)) {
    return { encoding: "utf-8", bomLength: 0, bomBytes: EMPTY_BOM };
  }

  // CJK 占比高的 UTF-16 无 BOM 文本，空字节比例可能很低，
  // 仅靠 null-ratio 会被误判为“非文本”并走原样复制，导致敏感字段漏脱敏。
  // 这里增加“ASCII-零字节对”兜底检测（例如 `OPENAI_API_KEY=\r\n`），覆盖真实日志中的混合文本场景。
  const utf16Encoding =
    detectUtf16EncodingByAsciiPairPattern(sample) ??
    detectUtf16EncodingByNullPattern(sample) ??
    detectUtf16EncodingByDecodedTextScore(sample);
  if (!utf16Encoding) {
    // 无 BOM 且不含空字节的 UTF-16 文本，在纯 CJK 内容里经常出现。
    // 这类样本 UTF-8 fatal decode 会失败；此时按 UTF-8 处理会产生乱码并漏掉敏感字段匹配。
    // 兜底策略：UTF-8 合法则按 UTF-8，非法且无法识别成 UTF-16 时才视为二进制。
    if (isValidUtf8Sample(sample)) {
      return { encoding: "utf-8", bomLength: 0, bomBytes: EMPTY_BOM };
    }
    return null;
  }
  return { encoding: utf16Encoding, bomLength: 0, bomBytes: EMPTY_BOM };
}
