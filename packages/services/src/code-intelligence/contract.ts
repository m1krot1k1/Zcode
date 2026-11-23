import { ServiceChannels } from "@zcode/shared";
import type {
  ZCodeUncensoredGetConfigResult,
  ZCodeUncensoredSettingsStatus,
  ZCodeUncensoredSettingsWrite,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type {
  LocalEmbeddingInstallResult,
  LocalEmbeddingPort,
  LocalEmbeddingPullResult,
  LocalEmbeddingRuntimeStatus,
} from "./localEmbeddingContract.js";

export type CodeIndexState = "unindexed" | "indexing" | "ready" | "degraded";
export type CodeIndexMatchKind = "lexical" | "semantic";
export type EmbeddingProvider = "ollama" | "openai-compatible";
export type EmbeddingPhase = "not-configured" | "pending" | "building" | "ready" | "failed";
export type EmbeddingErrorCode =
  | "request-failed"
  | "timeout"
  | "invalid-response"
  | "authentication"
  | "not-found"
  | "rate-limited"
  | "provider-error";

export type LocalRuntimeRequest =
  | { readonly action: "status" }
  | { readonly action: "install" }
  | { readonly action: "start" }
  | { readonly action: "pull"; readonly model: string };

export type LocalRuntimeResult =
  | { readonly action: "status"; readonly status: LocalEmbeddingRuntimeStatus }
  | { readonly action: "install"; readonly result: LocalEmbeddingInstallResult }
  | { readonly action: "start"; readonly running: boolean }
  | { readonly action: "pull"; readonly result: LocalEmbeddingPullResult };

export interface CodeWorkspaceRef {
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * Workspace identity for the uncensored takeover settings next to the index.
 * The storage key repeats the code-intelligence rule:
 * `workspaceIdentity?.trim() || workspacePath`, hashed with sha256.
 */
export interface UncensoredSettingsWorkspace {
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * Host-only persistence port for `uncensored-settings.json`.
 *
 * The single implementation lives in `uncensoredSettings.ts`. `readTakeoverConfig`
 * is the only method that reads the credential secret, and only for the trusted
 * CLI reverse-RPC response; the renderer-facing service never receives it.
 */
export interface UncensoredSettingsStore {
  /** Status without the secret; corrupt or missing JSON degrades to defaults. */
  read(workspace: UncensoredSettingsWorkspace): Promise<ZCodeUncensoredSettingsStatus>;
  /** Full replacement of one workspace record; returns the persisted status. */
  write(
    workspace: UncensoredSettingsWorkspace,
    write: ZCodeUncensoredSettingsWrite,
  ): Promise<ZCodeUncensoredSettingsStatus>;
  /** Host-only read that resolves the secret right before building the answer. */
  readTakeoverConfig(
    workspace: UncensoredSettingsWorkspace,
  ): Promise<ZCodeUncensoredGetConfigResult>;
}

export interface CodeIndexStatus {
  state: CodeIndexState;
  partial?: boolean;
  generation: number;
  updatedAt?: number;
  counts: { files: number; chunks: number; symbols: number; edges: number };
  progress?: {
    discoveredFiles: number;
    indexedFiles: number;
    embedding?: { completed: number; total: number };
  };
  embedding: {
    configured: boolean;
    provider?: EmbeddingProvider;
    endpoint?: string;
    model?: string;
    apiKeyConfigured?: boolean;
    available: boolean;
    phase: EmbeddingPhase;
    lastError?: { code: EmbeddingErrorCode; httpStatus?: number };
  };
  diagnostics: string[];
  /** Размер локальной БД на диске (включая WAL); `undefined` до первого успешного открытия. */
  databaseBytes?: number;
  /** Версия схемы SQLite (`2` для целочисленной схемы с FTS5). */
  schemaVersion?: number;
  /** `true`, если при открытии была выполнена миграция со схемы v1. */
  migratedFromV1?: boolean;
  /** Размер старой БД v1 на момент миграции — для проверяемого отчёта, а не для UI. */
  legacySizeBytes?: number;
  /** Файлы, разобранные структурным текстовым чанкером (грамматика недоступна). */
  textFallbackFiles?: number;
  /** Распределение файлов по языкам: `{ typescript: 120, python: 14 }`. */
  languages?: Record<string, number>;
}

export interface CodeIndexSpanNode {
  name: string;
  path: string;
  startLine: number;
  endLine?: number;
  excerpt?: string;
  excerptTruncated?: boolean;
}

export interface CodeSearchResult {
  path: string;
  startLine: number;
  endLine: number;
  symbolName?: string;
  symbolKind?: string;
  excerpt: string;
  excerptTruncated?: boolean;
  match: CodeIndexMatchKind;
  score: number;
}

export interface CodeSymbolContext {
  symbol: {
    id: string;
    name: string;
    kind: string;
    path: string;
    startLine: number;
    endLine: number;
    excerpt?: string;
    excerptTruncated?: boolean;
  };
  callers: Array<CodeIndexSpanNode>;
  dependencies: Array<CodeIndexSpanNode>;
  partial: boolean;
}

export interface CodeGraphNode {
  id: string;
  name: string;
  kind: string;
  path: string;
  startLine: number;
  degree: number;
}

export interface CodeGraphEdge {
  source: string;
  target: string;
  relation: "calls" | "imports" | "contains";
}

export interface CodeGraphOverview {
  nodes: CodeGraphNode[];
  edges: CodeGraphEdge[];
  focusId?: string;
  partial: boolean;
}

export interface CodeImpactResult {
  changedPaths: string[];
  affectedSymbols: Array<CodeIndexSpanNode & { distance: number }>;
  partial: boolean;
}

export interface CodeTraceResult {
  found: boolean;
  path: Array<CodeIndexSpanNode & { relation: string }>;
  partial: boolean;
}

export interface EmbeddingTestResult {
  ok: boolean;
  errorCode?: "invalid-config" | EmbeddingErrorCode;
  /** Sanitized HTTP status only; provider response bodies are never returned. */
  httpStatus?: number;
  dimensions?: number;
  elapsedMs: number;
}

export interface CodeIntelligenceService {
  /** Read the committed index state and any in-process progress for this workspace. */
  getStatus(params: CodeWorkspaceRef): Promise<CodeIndexStatus>;

  /**
   * Arm a Host-owned watcher and reconcile changes since the last activation.
   * With `autoIndexOnOpen` (default) an absent index is built in the background instead of
   * staying `unindexed` forever.
   */
  watchWorkspace(params: CodeWorkspaceRef & { autoIndexOnOpen?: boolean }): Promise<void>;

  /** Scan and atomically publish a complete generation; preserves the prior one on failure. */
  indexWorkspace(params: CodeWorkspaceRef & { force?: boolean }): Promise<CodeIndexStatus>;

  /**
   * Incrementally reconcile exact paths (create/modify/delete) without a full rescan.
   * Fed by watcher batches and by committed file transactions (Increment 4.2).
   */
  notifyFilesMutated(
    params: CodeWorkspaceRef & { changed?: string[]; removed?: string[] },
  ): Promise<CodeIndexStatus>;

  /** Search indexed code; lexical search works offline, semantic ranking is optional. */
  search(
    params: CodeWorkspaceRef & {
      query: string;
      limit?: number;
      lexicalOnly?: boolean;
      /** Token budget for the packed result; the response is never byte-truncated. */
      maxTokens?: number;
      /** Files open in the editor or relevant to the current turn (proximity boost). */
      activeFiles?: string[];
      /** Files from the current diff (proximity boost). */
      changedFiles?: string[];
    },
  ): Promise<{
    results: CodeSearchResult[];
    semantic: boolean;
    partial: boolean;
    /** Packer telemetry: always present, so consumers can report truncation honestly. */
    budget?: {
      usedTokens: number;
      budgetTokens: number;
      dropped: number;
      collapsed: number;
      candidateCount: number;
      truncated: boolean;
    };
  }>;

  /** Resolve one symbol and its locally known callers/dependencies. */
  getSymbolContext(
    params: CodeWorkspaceRef & { symbol: string },
  ): Promise<CodeSymbolContext | null>;

  /** Return a bounded high-degree overview or one symbol's immediate neighborhood. */
  getGraphOverview(
    params: CodeWorkspaceRef & {
      focus?: { symbol?: string; path?: string; startLine?: number };
      limit?: number;
    },
  ): Promise<CodeGraphOverview>;

  /** Find symbols that depend on changed workspace-relative paths. */
  getImpact(params: CodeWorkspaceRef & { changedPaths: string[] }): Promise<CodeImpactResult>;

  /** Return a shortest known dependency/call path between two symbols. */
  trace(
    params: CodeWorkspaceRef & { fromSymbol: string; toSymbol: string },
  ): Promise<CodeTraceResult>;

  /** Probe a draft provider using one fixed string; does not save config or index content. */
  testEmbeddingConfig(
    params: CodeWorkspaceRef & {
      provider: EmbeddingProvider;
      endpoint: string;
      model: string;
      /** Omitted/empty uses the currently saved token; the draft is never persisted. */
      apiKey?: string;
    },
  ): Promise<EmbeddingTestResult>;

  /** Managed local embedding runtime attached to this code index, when the Host supports it. */
  readonly localEmbeddings?: LocalEmbeddingPort;
  /**
   * Flat RPC surface for the managed Ollama runtime.
   *
   * `ProxyChannel` maps only top-level function properties; a nested
   * `localEmbeddings.getStatus` turns into a function in the renderer. This function-typed
   * property avoids growing the contract method surface while staying callable over RPC.
   */
  readonly localRuntime?: (request: LocalRuntimeRequest) => Promise<LocalRuntimeResult>;

  /** Set/clear an embedding provider without returning or persisting API-key material in the index. */
  setEmbeddingConfig(
    params: CodeWorkspaceRef & {
      provider?: EmbeddingProvider | null;
      endpoint?: string | null;
      model?: string | null;
      /** Empty/omitted preserves a saved key; null removes it. */
      apiKey?: string | null;
    },
  ): Promise<CodeIndexStatus>;

  /** Delete only the identity-scoped local index for this workspace. */
  clearIndex(params: CodeWorkspaceRef): Promise<void>;
}

export const ICodeIntelligenceService = createServiceDescriptor<CodeIntelligenceService>(
  ServiceChannels.CodeIntelligence,
);
