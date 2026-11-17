import type { PromptEnhanceContextSource, PromptEnhanceRequest } from "@zcode/shared";
import { PROMPT_ENHANCE_CONTEXT_BUDGET_MS } from "@zcode/shared";

/**
 * Сборщик контекста репозитория для улучшения промптов.
 *
 * Жёсткий инвариант производительности: весь сбор укладывается в
 * `PROMPT_ENHANCE_CONTEXT_BUDGET_MS`. Каждый источник имеет собственный таймаут, а
 * `Promise.allSettled` гарантирует, что сбой или зависание одного источника не блокирует
 * улучшение. Источники не бросают: ошибка превращается в отсутствие секции.
 */

/** Гибридный поиск (Increment 4.3). Порт опционален: без индекса улучшение всё равно работает. */
export interface PromptEnhanceCodeSearchPort {
  search(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    query: string;
    limit?: number;
    maxTokens?: number;
    activeFiles?: string[];
    changedFiles?: string[];
    signal?: AbortSignal;
  }): Promise<{
    results: Array<{
      path: string;
      startLine: number;
      symbolName?: string;
      score: number;
    }>;
  }>;
}

/** Минимальная поверхность Git, нужная для сводки диффа; ничего не мутирует. */
export interface PromptEnhanceGitPort {
  getChanges(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    signal?: AbortSignal;
  }): Promise<ReadonlyArray<{ path: string }>>;
}

/** Чтение файлов правил проекта; возвращает `null`, если файла нет. */
export interface PromptEnhanceFilePort {
  readTextFile(params: { path: string; signal?: AbortSignal }): Promise<{ content: string } | null>;
}

/** Последние сообщения сессии для разрешения местоимений («этот компонент»). */
export interface PromptEnhanceHistoryPort {
  readRecentMessages(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionId: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<ReadonlyArray<{ role: "user" | "assistant"; text: string }>>;
}

export interface PromptEnhanceContextPorts {
  codeSearch?: PromptEnhanceCodeSearchPort;
  git?: PromptEnhanceGitPort;
  files?: PromptEnhanceFilePort;
  history?: PromptEnhanceHistoryPort;
}

export interface CollectedPromptEnhanceContext {
  /** Готовые секции для пользовательского сообщения — в детерминированном порядке. */
  sections: string[];
  /** Провенанс для UI: только пути и имена символов, без содержимого. */
  sources: PromptEnhanceContextSource[];
}

const MAX_DIFF_PATHS = 15;
const MAX_HISTORY_MESSAGES = 6;
const MAX_HISTORY_CHARS_PER_MESSAGE = 400;
const MAX_RULES_CHARS = 2_400;
const MAX_SEARCH_RESULTS = 5;
const MAX_SEARCH_TOKENS = 900;

/** Файлы правил проекта, из которых извлекаются только релевантные строки. */
const PROJECT_RULE_FILES = ["AGENTS.md", "DESIGN.md", "CONTEXT.md"] as const;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("prompt-enhance-context-timeout")), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/** Отбирает из файла правил строки, релевантные черновику, с жёстким лимитом символов. */
export function selectRelevantRuleLines(
  content: string,
  draftText: string,
  maxChars = MAX_RULES_CHARS,
): string {
  const tokens = new Set(
    draftText
      .toLowerCase()
      .split(/[^a-z0-9\u0450-\u04ff_-]+/u)
      .filter((token) => token.length >= 4),
  );
  const lines = content.split(/\r?\n/u);
  const scored: Array<{ index: number; text: string; score: number }> = [];
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const lower = trimmed.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (lower.includes(token)) score += 1;
    }
    // Заголовки и маркеры правил важнее прозы: они задают инварианты, а не объясняют их.
    if (trimmed.startsWith("#") || trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      score += 0.5;
    }
    if (score > 0) scored.push({ index, text: trimmed, score });
  }
  if (scored.length === 0) return "";
  const picked = scored
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 12)
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.text);
  const joined = picked.join("\n");
  return joined.length > maxChars ? `${joined.slice(0, maxChars - 1)}…` : joined;
}

async function collectCodeIndex(
  ports: PromptEnhanceContextPorts,
  request: PromptEnhanceRequest,
  signal: AbortSignal,
): Promise<{ section: string | null; source: PromptEnhanceContextSource | null }> {
  if (!ports.codeSearch) return { section: null, source: null };
  const result = await ports.codeSearch.search({
    workspacePath: request.workspacePath,
    ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
    query: request.draftText,
    limit: MAX_SEARCH_RESULTS,
    maxTokens: MAX_SEARCH_TOKENS,
    activeFiles: [...request.activeFilePaths],
    signal,
  });
  if (result.results.length === 0) return { section: null, source: null };
  const items = result.results.map((hit) => {
    const symbol = hit.symbolName ? `${hit.symbolName} ` : "";
    return `${symbol}${hit.path}:${hit.startLine}`;
  });
  return {
    section: ["<code_index>", ...items.map((item) => `- ${item}`), "</code_index>"].join("\n"),
    source: { kind: "code_index", items },
  };
}

async function collectGitDiff(
  ports: PromptEnhanceContextPorts,
  request: PromptEnhanceRequest,
  signal: AbortSignal,
): Promise<{ section: string | null; source: PromptEnhanceContextSource | null }> {
  if (!ports.git) return { section: null, source: null };
  const changes = await ports.git.getChanges({
    workspacePath: request.workspacePath,
    ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
    signal,
  });
  if (changes.length === 0) return { section: null, source: null };
  // Порядок стабилен: Git уже сортирует пути, но фиксируем контракт явно.
  const paths = [...new Set(changes.map((change) => change.path))].sort().slice(0, MAX_DIFF_PATHS);
  return {
    section: [
      "<uncommitted_changes>",
      ...paths.map((path) => `- ${path}`),
      "</uncommitted_changes>",
    ].join("\n"),
    source: { kind: "git_diff", items: paths },
  };
}

async function collectProjectRules(
  ports: PromptEnhanceContextPorts,
  request: PromptEnhanceRequest,
  signal: AbortSignal,
): Promise<{ section: string | null; source: PromptEnhanceContextSource | null }> {
  if (!ports.files) return { section: null, source: null };
  const read = await Promise.allSettled(
    PROJECT_RULE_FILES.map(async (name) => {
      const path = `${request.workspacePath.replace(/[\\/]+$/u, "")}/${name}`;
      const file = await ports.files!.readTextFile({ path, signal });
      return file
        ? { name, excerpt: selectRelevantRuleLines(file.content, request.draftText) }
        : null;
    }),
  );
  const excerpts = read
    .flatMap((outcome) => (outcome.status === "fulfilled" && outcome.value ? [outcome.value] : []))
    .filter((entry) => entry.excerpt.length > 0);
  if (excerpts.length === 0) return { section: null, source: null };
  return {
    section: [
      "<project_rules>",
      ...excerpts.map((entry) => `## ${entry.name}\n${entry.excerpt}`),
      "</project_rules>",
    ].join("\n"),
    source: { kind: "agents_md", items: excerpts.map((entry) => entry.name) },
  };
}

async function collectHistory(
  ports: PromptEnhanceContextPorts,
  request: PromptEnhanceRequest,
  signal: AbortSignal,
): Promise<{ section: string | null; source: PromptEnhanceContextSource | null }> {
  if (!ports.history || !request.sessionId) return { section: null, source: null };
  const messages = await ports.history.readRecentMessages({
    workspacePath: request.workspacePath,
    ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
    sessionId: request.sessionId,
    limit: MAX_HISTORY_MESSAGES,
    signal,
  });
  if (messages.length === 0) return { section: null, source: null };
  const lines = messages.map(
    (message) =>
      `- ${message.role}: ${message.text.replace(/\s+/gu, " ").slice(0, MAX_HISTORY_CHARS_PER_MESSAGE)}`,
  );
  return {
    section: ["<recent_conversation>", ...lines, "</recent_conversation>"].join("\n"),
    source: { kind: "session_history", items: [`last ${messages.length} messages`] },
  };
}

/**
 * Собирает контекст параллельно. Порядок секций фиксирован, поэтому один и тот же
 * репозиторий и черновик дают побайтово одинаковый контекст.
 */
export async function collectPromptEnhanceContext(
  ports: PromptEnhanceContextPorts,
  request: PromptEnhanceRequest,
  options: { budgetMs?: number; signal?: AbortSignal } = {},
): Promise<CollectedPromptEnhanceContext> {
  const budgetMs = Math.max(1, options.budgetMs ?? PROMPT_ENHANCE_CONTEXT_BUDGET_MS);
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  options.signal?.addEventListener("abort", abortFromParent, { once: true });
  const signal = controller.signal;
  try {
    const collectors = [
      collectCodeIndex,
      collectGitDiff,
      collectProjectRules,
      collectHistory,
    ] as const;
    const settled = await Promise.allSettled(
      collectors.map((collector) => withTimeout(collector(ports, request, signal), budgetMs)),
    );
    const sections: string[] = [];
    const sources: PromptEnhanceContextSource[] = [];
    for (const outcome of settled) {
      if (outcome.status !== "fulfilled") continue;
      if (outcome.value.section) sections.push(outcome.value.section);
      if (outcome.value.source) sources.push(outcome.value.source);
    }
    return { sections, sources };
  } finally {
    controller.abort();
    options.signal?.removeEventListener("abort", abortFromParent);
  }
}
