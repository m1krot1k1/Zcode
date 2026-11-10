import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

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

export interface CodeWorkspaceRef {
  workspacePath: string;
  workspaceIdentity?: string;
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

  /** Arm a Host-owned filesystem watcher and reconcile changes since the last activation. */
  watchWorkspace(params: CodeWorkspaceRef): Promise<void>;

  /** Scan and atomically publish a complete generation; preserves the prior one on failure. */
  indexWorkspace(params: CodeWorkspaceRef & { force?: boolean }): Promise<CodeIndexStatus>;

  /** Search indexed code; lexical search works offline, semantic ranking is optional. */
  search(
    params: CodeWorkspaceRef & { query: string; limit?: number; lexicalOnly?: boolean },
  ): Promise<{
    results: CodeSearchResult[];
    semantic: boolean;
    partial: boolean;
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
