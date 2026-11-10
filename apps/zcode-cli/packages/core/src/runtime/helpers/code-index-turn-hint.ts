import type { CodeIntelligencePort, TraceContext } from "@zcode/contracts";

export const CODE_INDEX_TURN_HINT_TIMEOUT_MS = 800;
const HINT_HITS = 4;
const HINT_CHAR_BUDGET = 12_000;

export async function buildCodeIndexTurnHint(input: {
  port: CodeIntelligencePort | undefined;
  query: string;
  signal: AbortSignal;
  trace?: TraceContext;
}): Promise<string | null> {
  const query = input.query.trim().slice(0, 500);
  if (!input.port || query.length < 2 || input.signal.aborted) return null;

  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  input.signal.addEventListener("abort", onParentAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, CODE_INDEX_TURN_HINT_TIMEOUT_MS);
    timer.unref?.();
  });
  const work = collectHint(input.port, query, controller.signal, input.trace).catch(() => null);
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    input.signal.removeEventListener("abort", onParentAbort);
  }
}

async function collectHint(
  port: CodeIntelligencePort,
  query: string,
  signal: AbortSignal,
  trace?: TraceContext,
): Promise<string | null> {
  const status = await port.query({ action: "status" }, { signal, trace });
  if (status.action !== "status" || status.status.state !== "ready") return null;
  const search = await port.query(
    { action: "search", query, limit: HINT_HITS, lexicalOnly: true },
    { signal, trace },
  );
  if (search.action !== "search" || search.results.length === 0) return null;
  const lines = search.results.slice(0, HINT_HITS).map((hit) => {
    const title = `${hit.path}:${hit.startLine}-${hit.endLine}${hit.symbolName ? ` ${hit.symbolName}` : ""}${hit.excerptTruncated ? " excerpt-truncated" : ""}`;
    return `${title}\n${hit.excerpt}`;
  });
  const body = [
    "Local code-index hint. This is not a second source of truth and does not replace CodeIndex. Answer from these excerpts and path:startLine-endLine when the fact is already here. Read a range only to edit, open a test, or when the excerpt is truncated or missing the needed text. Use offset = startLine and a limit for that range.",
    ...lines,
  ].join("\n\n");
  return body.length <= HINT_CHAR_BUDGET ? body : `${body.slice(0, HINT_CHAR_BUDGET)}\n[hint truncated]`;
}
