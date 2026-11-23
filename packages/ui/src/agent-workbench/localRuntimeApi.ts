import type {
  CodeIntelligenceService,
  LocalEmbeddingInstallResult,
  LocalEmbeddingPullResult,
  LocalEmbeddingRuntimeStatus,
} from "./contract.js";

/** The managed Ollama runtime as callable from UI. */
export interface LocalRuntimeApi {
  getStatus(): Promise<LocalEmbeddingRuntimeStatus>;
  install(): Promise<LocalEmbeddingInstallResult>;
  start(): Promise<boolean>;
  pull(model: string): Promise<LocalEmbeddingPullResult>;
}

/**
 * RPC exposes only top-level function properties. The nested `localEmbeddings` object is
 * still accepted for direct service tests and older Hosts, but a renderer proxy turns it
 * into a function, so prefer the flat `localRuntime(request)` surface.
 */
export function resolveLocalRuntimeApi(
  service: CodeIntelligenceService | null | undefined,
): LocalRuntimeApi | null {
  if (!service) return null;
  if (typeof service.localRuntime === "function") {
    const call = service.localRuntime.bind(service);
    return {
      getStatus: async () => {
        const result = await call({ action: "status" });
        if (result.action !== "status") throw new Error("Unexpected local runtime response");
        return result.status;
      },
      install: async () => {
        const result = await call({ action: "install" });
        if (result.action !== "install") throw new Error("Unexpected local runtime response");
        return result.result;
      },
      start: async () => {
        const result = await call({ action: "start" });
        if (result.action !== "start") throw new Error("Unexpected local runtime response");
        return result.running;
      },
      pull: async (model) => {
        const result = await call({ action: "pull", model });
        if (result.action !== "pull") throw new Error("Unexpected local runtime response");
        return result.result;
      },
    };
  }
  const nested = service.localEmbeddings;
  if (
    nested &&
    typeof nested.getStatus === "function" &&
    typeof nested.install === "function" &&
    typeof nested.pull === "function"
  ) {
    return {
      ...nested,
      start: typeof nested.start === "function" ? () => nested.start() : async () => false,
    };
  }
  return null;
}
