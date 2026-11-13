import { withRequestIdHeaderRecord } from "#src/providers/api/requestIdHeaders.js";

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function readResponseError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const json = JSON.parse(text) as { msg?: unknown; detail?: unknown };
    if (typeof json.msg === "string" && json.msg.trim()) {
      return json.msg;
    }
    if (typeof json.detail === "string") {
      return json.detail;
    }
  } catch {
    // ignore
  }
  return text || `HTTP ${response.status}`;
}

export function mergeFeedbackRequestHeaders(
  authHeaders: Record<string, string>,
  headers: RequestInit["headers"] | undefined,
): Record<string, string> {
  const next = { ...authHeaders };
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      next[key] = value;
    });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      next[key] = value;
    }
  } else if (headers) {
    Object.entries(headers).forEach(([key, value]) => {
      next[key] = String(value);
    });
  }
  return withRequestIdHeaderRecord(next);
}

export function getHeaderValue(headers: Record<string, string>, name: string): string | undefined {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected) {
      return value;
    }
  }
  return undefined;
}
