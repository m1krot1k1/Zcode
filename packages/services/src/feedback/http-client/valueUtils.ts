export function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeFeedbackTime(
  value: number | string | null | undefined,
  fallback?: string,
): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  const stringValue = readString(value);
  if (!stringValue) {
    return fallback ?? new Date().toISOString();
  }
  if (/^\d+$/.test(stringValue)) {
    return new Date(Number(stringValue) * 1000).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(stringValue) && !/(?:Z|[+-]\d{2}:?\d{2})$/.test(stringValue)) {
    return `${stringValue}Z`;
  }
  return stringValue;
}

export function toStableNumericId(value: unknown, fallbackId: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const text = readString(value);
  if (!text) {
    return fallbackId;
  }
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash || fallbackId;
}
