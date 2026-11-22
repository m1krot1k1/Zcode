/* mock 网关对 Anthropic messages 请求体的宽松读取：字段缺失或类型不符时返回 undefined/false。 */

export function parseMockRequestJson(requestBody: Buffer): unknown {
  try {
    return JSON.parse(requestBody.toString("utf8"));
  } catch {
    return {};
  }
}

export function readRequestString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

export function readRequestNumber(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

export function readRequestBoolean(value: unknown, key: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as Record<string, unknown>)[key] === true;
}
