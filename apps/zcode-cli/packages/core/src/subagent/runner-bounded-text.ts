// Subagent runner: bounded-текст и UTF-8 усечение для DAG/WorkResult.

import { type AgentCompletedOutput } from "@zcode/contracts";
import { Buffer } from "node:buffer";

export function truncateUtf8(value: string, maxBytes: number, marker = "…[truncated]"): string {
  if (utf8ByteLength(value) <= maxBytes) return value;
  const markerBytes = utf8ByteLength(marker);
  const contentBudget = Math.max(0, maxBytes - markerBytes);
  let result = "";
  let usedBytes = 0;
  for (const codePoint of value) {
    const codePointBytes = utf8ByteLength(codePoint);
    if (usedBytes + codePointBytes > contentBudget) break;
    result += codePoint;
    usedBytes += codePointBytes;
  }
  return markerBytes <= maxBytes ? `${result}${marker}` : result;
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function collectBoundedText(
  chunks: Iterable<string>,
  maxBytes: number,
): { text: string; truncated: boolean } {
  let text = "";
  let usedBytes = 0;
  let truncated = false;
  let index = 0;
  for (const chunk of chunks) {
    const separator = index > 0 ? "\n" : "";
    const separatorBytes = utf8ByteLength(separator);
    if (usedBytes + separatorBytes > maxBytes) {
      truncated = true;
      break;
    }
    text += separator;
    usedBytes += separatorBytes;
    const remaining = maxBytes - usedBytes;
    if (utf8ByteLength(chunk) > remaining) {
      text += truncateUtf8(chunk, remaining);
      truncated = true;
      break;
    }
    text += chunk;
    usedBytes += utf8ByteLength(chunk);
    index += 1;
  }
  return { text, truncated };
}

export function* agentOutputTextChunks(output: AgentCompletedOutput): Generator<string> {
  for (const block of output.content) {
    if (block.text) yield block.text;
  }
}

