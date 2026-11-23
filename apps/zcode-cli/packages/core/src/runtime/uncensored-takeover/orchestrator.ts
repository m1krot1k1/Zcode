import type { LogContext } from "@zcode/contracts";
import type { RunUncensoredTakeoverInput, TakeoverTerminal } from "./contract.js";
import { buildTakeoverRequestBody } from "./context.js";
import { attemptTakeoverModel, defaultTakeoverFetch } from "./http.js";

function logContext(input: RunUncensoredTakeoverInput, extra: Record<string, unknown>): LogContext {
  return { module: "core.runtime", taskId: input.taskId, itemIndex: input.itemIndex, ...extra };
}

function errorTerminal(reason: string): TakeoverTerminal {
  return {
    status: "error",
    providerId: null,
    providerName: null,
    modelId: null,
    output: "",
    reason,
  };
}

/**
 * Providers and their enabled models in configuration order, exactly one attempt each. A
 * refusal or error advances to the next enabled model, then to the next provider; success
 * stops routing. No enabled models anywhere or a null configuration make zero fetch calls.
 * When every attempt fails the last attempt status is terminal.
 */
export async function runUncensoredTakeover(
  input: RunUncensoredTakeoverInput,
): Promise<TakeoverTerminal> {
  let config: Awaited<ReturnType<RunUncensoredTakeoverInput["configPort"]["getConfig"]>>;
  try {
    config = await input.configPort.getConfig(input.workspace);
  } catch {
    input.logger?.warn?.(
      "Uncensored takeover config read failed",
      logContext(input, { status: "error" }),
    );
    return errorTerminal("config");
  }
  if (!config) {
    input.logger?.warn?.(
      "Uncensored takeover config is unavailable",
      logContext(input, { status: "error" }),
    );
    return errorTerminal("config");
  }
  const routes = config.providers.flatMap((provider) =>
    provider.models
      .filter((model) => model.enabled)
      .map((model) => ({ provider, model })),
  );
  if (routes.length === 0) {
    input.logger?.info?.(
      "Uncensored takeover has no enabled models",
      logContext(input, { status: "no-enabled-models" }),
    );
    return {
      status: "no-enabled-models",
      providerId: null,
      providerName: null,
      modelId: null,
      output: "",
    };
  }
  const fetchImpl = input.fetch ?? defaultTakeoverFetch;
  let last: TakeoverTerminal = errorTerminal("config");
  for (const { provider, model } of routes) {
    if (input.signal?.aborted) {
      return {
        status: "error",
        providerId: provider.id,
        providerName: provider.name,
        modelId: model.id,
        output: "",
        reason: "cancelled",
      };
    }
    const startedAt = Date.now();
    const body = buildTakeoverRequestBody({
      modelId: model.id,
      itemIndex: input.itemIndex,
      itemText: input.itemText,
      fragments: input.fragments,
    });
    const outcome = await attemptTakeoverModel({
      apiUrl: provider.apiUrl,
      apiKey: provider.apiKey,
      modelId: model.id,
      body,
      fetch: fetchImpl,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const durationMs = Date.now() - startedAt;
    if (outcome.kind === "done") {
      input.logger?.info?.(
        "Uncensored takeover attempt completed",
        logContext(input, {
          providerId: provider.id,
          modelId: model.id,
          status: "completed",
          durationMs,
        }),
      );
      return {
        status: "done",
        providerId: provider.id,
        providerName: provider.name,
        modelId: model.id,
        output: outcome.content,
      };
    }
    if (outcome.kind === "refused") {
      input.logger?.info?.(
        "Uncensored takeover attempt refused",
        logContext(input, {
          providerId: provider.id,
          modelId: model.id,
          status: "failed",
          reason: outcome.reason,
          durationMs,
        }),
      );
      last = {
        status: "refused",
        providerId: provider.id,
        providerName: provider.name,
        modelId: model.id,
        output: "",
        reason: outcome.reason,
      };
      continue;
    }
    input.logger?.warn?.(
      "Uncensored takeover attempt failed",
      logContext(input, {
        providerId: provider.id,
        modelId: model.id,
        status: "failed",
        reason: outcome.reason,
        durationMs,
      }),
    );
    last = {
      status: "error",
      providerId: provider.id,
      providerName: provider.name,
      modelId: model.id,
      output: "",
      reason: outcome.reason,
    };
  }
  return last;
}
