/** A local embedding runtime managed by the Host (currently Ollama). */
export interface LocalEmbeddingRuntimeStatus {
  readonly runtime: "ollama";
  readonly installed: boolean;
  readonly running: boolean;
  readonly version?: string;
  /** Host RAM used for local model recommendations; optional for older Hosts. */
  readonly totalMemoryBytes?: number;
  readonly models: ReadonlyArray<{ readonly id: string; readonly sizeBytes?: number }>;
  readonly recommended: {
    readonly model: string;
    readonly dimensions: number;
    readonly downloadBytes: number;
    readonly reason: string;
  };
}

export type LocalEmbeddingInstallResult =
  | { readonly status: "installed" | "already-installed"; readonly version?: string }
  | { readonly status: "failed"; readonly diagnostic: string };

export type LocalEmbeddingPullResult =
  | { readonly status: "installed"; readonly model: string }
  | { readonly status: "failed"; readonly model: string; readonly diagnostic: string };

/** Sub-capability of the code index: one managed local embedding runtime. */
export interface LocalEmbeddingPort {
  getStatus(): Promise<LocalEmbeddingRuntimeStatus>;
  install(): Promise<LocalEmbeddingInstallResult>;
  pull(model: string): Promise<LocalEmbeddingPullResult>;
}
