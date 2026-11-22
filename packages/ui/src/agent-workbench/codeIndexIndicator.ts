import type { CodeIndexStatus } from "./contract.js";

/**
 * Presentation tone for the local code index. This is intentionally derived from
 * the service status projection and never persisted; see
 * docs/specs/code-index-indicator.md for the product contract.
 */
type CodeIndexIndicatorTone = "neutral" | "indexing" | "ready" | "partial" | "degraded";

type CodeIndexIndicatorStatus = Pick<CodeIndexStatus, "state" | "partial">;

// 修复原因：`bg-muted-foreground` / `text-muted-foreground` / `bg-muted` 不是本项目
// styles.css 定义的语义 token，Tailwind 不会生成对应规则，neutral 圆点因此没有背景色。
// 改用已定义的语义 token：foreground-subtle 在四套主题下都生成可见的中性灰。
const DOT_CLASS: Record<CodeIndexIndicatorTone, string> = {
  neutral: "bg-foreground-subtle",
  indexing: "bg-warning animate-pulse",
  ready: "bg-success",
  partial: "bg-warning",
  degraded: "bg-destructive",
};

// 与仓库既有的中性标签约定一致（bg-tag + text-foreground-subtle），两个 token
// 均由 styles.css 定义并在 light/dark/zai-light/zai-dark 中解析。
const PILL_CLASS: Record<CodeIndexIndicatorTone, string> = {
  neutral: "bg-tag text-foreground-subtle",
  indexing: "bg-warning-surface text-warning-surface-foreground",
  ready: "bg-success-surface text-success-surface-foreground",
  partial: "bg-warning-surface text-warning-surface-foreground",
  degraded: "bg-destructive-surface text-destructive-surface-foreground",
};

/**
 * `ready` with `partial` coverage is presented as its own tone because the index is
 * usable but incomplete. There is no stale field in the service contract: freshness
 * is `state === "ready" && partial !== true`; generation/updatedAt stay informational.
 */
export function codeIndexTone(
  status: CodeIndexIndicatorStatus | null | undefined,
): CodeIndexIndicatorTone {
  if (!status) return "neutral";
  if (status.state === "ready") return status.partial === true ? "partial" : "ready";
  if (status.state === "indexing") return "indexing";
  if (status.state === "degraded") return "degraded";
  return "neutral";
}

/**
 * Single source of truth for the localized status label. Both the composer badge and
 * the Workbench pill resolve their text through this helper so the tone and the text
 * cannot disagree: `state === "ready"` with `partial === true` must never read "Ready".
 *
 * The `degraded` tone intentionally does not reuse `codeGraph.state.degraded`, whose
 * English copy is "Partial index" and would collide with the partial tone.
 */
export function codeIndexStateKey(status: CodeIndexIndicatorStatus | null | undefined): string {
  if (!status) return "codeIndex.loadingStatus";
  switch (codeIndexTone(status)) {
    case "partial":
      return "agentWorkbench.statePartial";
    case "ready":
      return "agentWorkbench.stateReady";
    case "indexing":
      return "agentWorkbench.stateIndexing";
    case "degraded":
      return "agentWorkbench.stateDegraded";
    default:
      return "agentWorkbench.stateUnindexed";
  }
}

export function codeIndexDotClassName(tone: CodeIndexIndicatorTone): string {
  return DOT_CLASS[tone];
}

export function codeIndexPillClassName(tone: CodeIndexIndicatorTone): string {
  return PILL_CLASS[tone];
}

type CodeIndexSkipReason = { key: string; count?: number };

const SKIP_DEFAULTS: Record<string, string> = {
  "codeIndex.skip.secret": "A file was left out because it looks like a secret.",
  "codeIndex.skip.size": "A file was left out because it is larger than 8 MiB.",
  "codeIndex.skip.limit": "Indexing stopped at the file safety limit.",
  "codeIndex.skip.other": "{count} other files were left out of the index.",
};

export function codeIndexSkipDefault(key: string): string {
  return SKIP_DEFAULTS[key] ?? "A file was left out of the index.";
}

// 扫描器写入的是稳定英文诊断句。这里只映射已知的覆盖缺口，原始句子不进界面。
const SECRET_DIAGNOSTIC = "secret patterns";
const SIZE_DIAGNOSTIC = "MiB indexing limit";
const LIMIT_DIAGNOSTIC = "safety limit";

export function codeIndexSkipReasons(diagnostics: readonly string[]): CodeIndexSkipReason[] {
  const reasons: CodeIndexSkipReason[] = [];
  const seen = new Set<string>();
  let other = 0;
  for (const diagnostic of diagnostics) {
    const key = diagnostic.includes(SECRET_DIAGNOSTIC)
      ? "codeIndex.skip.secret"
      : diagnostic.includes(SIZE_DIAGNOSTIC)
        ? "codeIndex.skip.size"
        : diagnostic.includes(LIMIT_DIAGNOSTIC)
          ? "codeIndex.skip.limit"
          : undefined;
    if (key) {
      if (!seen.has(key)) {
        seen.add(key);
        reasons.push({ key });
      }
      continue;
    }
    if (
      diagnostic.startsWith("Embedding generation failed") ||
      diagnostic.startsWith("Indexing failed") ||
      diagnostic.startsWith("The local code index could not") ||
      diagnostic.startsWith("Workspace file watching")
    ) {
      continue;
    }
    other += 1;
  }
  if (other > 0) reasons.push({ key: "codeIndex.skip.other", count: other });
  return reasons;
}
