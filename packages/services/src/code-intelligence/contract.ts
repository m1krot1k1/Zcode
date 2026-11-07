import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export type CodeIndexState = "unindexed" | "indexing" | "ready" | "degraded";
export type CodeIndexMatchKind = "lexical" | "semantic";

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
  progress?: { discoveredFiles: number; indexedFiles: number };
  embedding: { configured: boolean; endpoint?: string; model?: string; available: boolean };
  diagnostics: string[];
}

export interface CodeSearchResult {
  path: string;
  startLine: number;
  endLine: number;
  symbolName?: string;
  symbolKind?: string;
  excerpt: string;
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
  };
  callers: Array<{ name: string; path: string; startLine: number }>;
  dependencies: Array<{ name: string; path: string; startLine: number }>;
  partial: boolean;
}

export interface CodeImpactResult {
  changedPaths: string[];
  affectedSymbols: Array<{ name: string; path: string; startLine: number; distance: number }>;
  partial: boolean;
}

export interface CodeTraceResult {
  found: boolean;
  path: Array<{ name: string; path: string; startLine: number; relation: string }>;
  partial: boolean;
}

export interface CodeIntelligenceService {
  /** Read the committed index state and any in-process progress for this workspace. */
  getStatus(params: CodeWorkspaceRef): Promise<CodeIndexStatus>;

  /** Scan and atomically publish a complete generation; preserves the prior one on failure. */
  indexWorkspace(params: CodeWorkspaceRef & { force?: boolean }): Promise<CodeIndexStatus>;

  /** Search indexed code; lexical search works offline, semantic ranking is optional. */
  search(
    params: CodeWorkspaceRef & { query: string; limit?: number },
  ): Promise<{ results: CodeSearchResult[]; semantic: boolean; partial: boolean }>;

  /** Resolve one symbol and its locally known callers/dependencies. */
  getSymbolContext(
    params: CodeWorkspaceRef & { symbol: string },
  ): Promise<CodeSymbolContext | null>;

  /** Find symbols that depend on changed workspace-relative paths. */
  getImpact(params: CodeWorkspaceRef & { changedPaths: string[] }): Promise<CodeImpactResult>;

  /** Return a shortest known dependency/call path between two symbols. */
  trace(
    params: CodeWorkspaceRef & { fromSymbol: string; toSymbol: string },
  ): Promise<CodeTraceResult>;

  /** Set/clear a local HTTP embedding endpoint and model; does not download models. */
  setEmbeddingConfig(
    params: CodeWorkspaceRef & { endpoint?: string | null; model?: string | null },
  ): Promise<CodeIndexStatus>;

  /** Delete only the identity-scoped local index for this workspace. */
  clearIndex(params: CodeWorkspaceRef): Promise<void>;
}

export const ICodeIntelligenceService = createServiceDescriptor<CodeIntelligenceService>(
  ServiceChannels.CodeIntelligence,
);
