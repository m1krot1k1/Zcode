import type { LogContext } from "@zcode/contracts";
import type { RunUncensoredTakeoverInput, TakeoverTerminal } from "./contract.js";
import { buildTakeoverMessages, buildTakeoverRequestBody } from "./context.js";
import { detectRefusal, detectTextRefusal, stripRefusalMarker } from "./detect.js";
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
    provider.models.filter((model) => model.enabled).map((model) => ({ provider, model })),
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
    if (provider.providerId && input.generate) {
      // Preferred path: the mirrored normal provider/model that also works in chat.
      try {
        const generated = await input.generate.generate({
          providerId: provider.providerId,
          // Thinking-суффикс здесь не снимается: registry ищет модель по полному id.
          // Серверное обдумывание отключает `reasoning_effort: "none"` из mirror option map.
          modelId: model.id,
          messages: buildTakeoverMessages({
            itemIndex: input.itemIndex,
            itemText: input.itemText,
            fragments: input.fragments,
          }),
          ...(input.signal ? { signal: input.signal } : {}),
        });
        const durationMs = Date.now() - startedAt;
        // `hasToolCalls` — измеренный факт, а не литерал: если инструменты уже сработали,
        // ответ нельзя объявить текстовым отказом и уйти на следующую модель, выбросив работу.
        const refusal =
          detectRefusal({ finishReason: generated.finishReason }) ??
          detectTextRefusal(generated.text, {
            hasToolCalls: (generated.toolsExecuted ?? 0) > 0,
          });
        if (refusal) {
          input.logger?.info?.(
            "Uncensored takeover attempt refused",
            logContext(input, {
              providerId: provider.providerId,
              modelId: model.id,
              status: "failed",
              reason: refusal,
              durationMs,
            }),
          );
          last = {
            status: "refused",
            providerId: provider.providerId,
            providerName: provider.name,
            modelId: model.id,
            output: "",
            reason: refusal,
          };
          continue;
        }
        // Пустой текст сам по себе не значит «пустой ответ»: модель, ответившая вызовом
        // инструмента, присылает `finish_reason: "tool_calls"` и ПУСТОЙ `content` — это
        // измеренная форма, а не сбой. Факт `toolsExecuted` уже читается выше (строка с
        // `hasToolCalls`); здесь он обязан решать так же, иначе выполненная работа
        // объявляется ошибкой и уходит на следующего провайдера, который строит запрос из
        // ИСХОДНОГО пункта и повторяет те же инструменты — двойной побочный эффект.
        const toolsExecuted = generated.toolsExecuted ?? 0;
        if (!generated.text.trim()) {
          if (toolsExecuted > 0) {
            input.logger?.info?.(
              "Uncensored takeover completed work without closing text",
              logContext(input, {
                providerId: provider.providerId,
                modelId: model.id,
                status: "completed",
                toolsExecuted,
                durationMs,
              }),
            );
            return {
              status: "done",
              providerId: provider.providerId,
              providerName: provider.name,
              modelId: model.id,
              output: "",
              toolsExecuted,
            };
          }
          last = {
            status: "error",
            providerId: provider.providerId,
            providerName: provider.name,
            modelId: model.id,
            output: "",
            reason: "empty-response",
          };
          continue;
        }
        input.logger?.info?.(
          "Uncensored takeover attempt completed",
          logContext(input, {
            providerId: provider.providerId,
            modelId: model.id,
            status: "completed",
            durationMs,
          }),
        );
        return {
          status: "done",
          providerId: provider.providerId,
          providerName: provider.name,
          modelId: model.id,
          // The token can come back from the model (it sees the host prompt), never show it.
          output: stripRefusalMarker(generated.text),
          // Без этого поля пустой `text` доезжает до рендера и в durable-строку без факта,
          // и оба объявляют выполненную работу ошибкой.
          ...(generated.toolsExecuted === undefined
            ? {}
            : { toolsExecuted: generated.toolsExecuted }),
        };
      } catch (error) {
        // A mirrored provider can be unresolvable in this runtime (registry view, model id).
        // Keep the reason bounded in the card and fall through to the raw endpoint below when
        // the provider still has its URL, so the attempt is not silently dropped.
        const message = error instanceof Error ? error.message : String(error);
        const reason = `generate: ${message.slice(0, 200)}`;
        input.logger?.warn?.(
          "Uncensored takeover mirrored generate failed",
          logContext(input, {
            providerId: provider.providerId,
            modelId: model.id,
            status: "failed",
            reason,
          }),
        );
        last = {
          status: "error",
          providerId: provider.providerId,
          providerName: provider.name,
          modelId: model.id,
          output: "",
          reason,
        };
        if (!provider.apiUrl) continue;
      }
    }
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
      // 修复原因：legacy raw 分支之前只看 finish reason 与空内容。供应商用普通 `stop`
      // 返回文本拒绝时会被当作 done，最终文本被二级模型的拒绝覆盖。这里与 mirror 分支
      // 共用同一个 detectTextRefusal，文本拒绝必须落到 refused。
      const textRefusal = detectTextRefusal(outcome.content, {
        hasToolCalls: false,
        ignoreMarker: true,
      });
      if (textRefusal) {
        input.logger?.info?.(
          "Uncensored takeover attempt refused",
          logContext(input, {
            providerId: provider.id,
            modelId: model.id,
            status: "failed",
            reason: textRefusal,
            durationMs,
          }),
        );
        last = {
          status: "refused",
          providerId: provider.id,
          providerName: provider.name,
          modelId: model.id,
          output: "",
          reason: textRefusal,
        };
        continue;
      }
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
        output: stripRefusalMarker(outcome.content),
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
