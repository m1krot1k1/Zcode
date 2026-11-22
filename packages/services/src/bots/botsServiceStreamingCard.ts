import type { BotTaskStreamRun } from "./botsServiceTaskStreamTypes.js";
import type { BotsServiceContext } from "./botsServicePorts.js";
import {
  FEISHU_STREAMING_CARD_FAILURE_BACKOFF_BASE_MS,
  FEISHU_STREAMING_CARD_FAILURE_CIRCUIT_THRESHOLD,
  FEISHU_STREAMING_CARD_MIN_UPDATE_INTERVAL_MS,
  FEISHU_STREAMING_CARD_REQUEST_TIMEOUT_MS,
  botsLogger,
  isRecord,
} from "./botsServiceSupport.js";
import type { BotStreamingReplyCardBlock } from "./providers/types.js";
import { type BotReplyToolCallState, formatBotToolCallSummaryLine } from "./replyFormatter.js";
import { type Locale, isFeishuBotProvider } from "@zcode/shared";

export function createBotsServiceStreamingCard(ctx: BotsServiceContext, run: BotTaskStreamRun) {
  return {
    supportsStreamingCardReply: () => {
      const adapter = ctx.providers[run.bot.provider];
      return (
        run.getMode() === "streaming_card" &&
        isFeishuBotProvider(run.bot.provider) &&
        Boolean(adapter?.createStreamingReplyCard) &&
        Boolean(adapter?.updateStreamingReplyCard)
      );
    },

    buildStreamingToolSummaryTitle: (locale: Locale | undefined): string =>
      ctx.msg(locale, "streamingToolSummaries"),

    appendStreamingCardMessageChunk: (content: string): void => {
      if (!content) {
        return;
      }
      const lastBlock = run.streamingCardBlocks.at(-1);
      if (lastBlock?.type === "message") {
        lastBlock.text += content;
        return;
      }
      run.streamingCardBlocks.push({ type: "message", text: content });
    },

    appendStreamingCardMessages: (messages: readonly string[]): void => {
      for (const message of messages.map((item) => item.trim()).filter(Boolean)) {
        const lastBlock = run.streamingCardBlocks.at(-1);
        if (lastBlock?.type === "message" && lastBlock.text.trim()) {
          lastBlock.text = `${lastBlock.text.trim()}\n\n${message}`;
        } else {
          run.streamingCardBlocks.push({ type: "message", text: message });
        }
      }
    },

    hasStreamingCardMessageText: (): boolean =>
      run.streamingCardBlocks.some(
        (block) => block.type === "message" && block.text.trim().length > 0,
      ),

    appendStreamingCardTool: (toolId: string): void => {
      const existingBlock = run.streamingCardBlocks.find(
        (block) => block.type === "tools" && block.toolIds.includes(toolId),
      );
      if (existingBlock) {
        return;
      }
      const lastBlock = run.streamingCardBlocks.at(-1);
      if (lastBlock?.type === "tools") {
        lastBlock.toolIds.push(toolId);
        return;
      }
      run.streamingCardBlocks.push({ type: "tools", toolIds: [toolId] });
    },

    buildStreamingCardBlocks: (locale: Locale | undefined): BotStreamingReplyCardBlock[] => {
      const toolSummaryTitle = run.buildStreamingToolSummaryTitle(locale);
      const latestToolBlockIndex = run.streamingCardBlocks.reduce(
        (latestIndex, block, index) => (block.type === "tools" ? index : latestIndex),
        -1,
      );
      const blocks: BotStreamingReplyCardBlock[] = [];
      for (const [index, block] of run.streamingCardBlocks.entries()) {
        if (block.type === "message") {
          const text = block.text.trim();
          if (text) {
            blocks.push({ type: "message", text });
          }
          continue;
        }
        const summaries = block.toolIds
          .map((toolId) => run.toolCalls.get(toolId))
          .filter((toolCall): toolCall is BotReplyToolCallState => Boolean(toolCall))
          .map((toolCall) =>
            formatBotToolCallSummaryLine(toolCall, {
              workspacePath: run.context.workspacePath,
              locale,
            }),
          );
        if (summaries.length === 0) {
          continue;
        }
        blocks.push({
          type: "tools",
          title: toolSummaryTitle,
          summaries,
          expanded: run.streamingCardStatus === "running" && index === latestToolBlockIndex,
        });
      }
      if (blocks.length === 0) {
        blocks.push({
          type: "message",
          text: ctx.msg(locale, "streamingWorking"),
        });
      }
      return blocks;
    },

    syncStreamingCardReply: async (trigger: string, force = false): Promise<void> => {
      if (
        !run.supportsStreamingCardReply() ||
        (run.persistentPrivate && run.privateCardDeliveryUnknown)
      ) {
        return;
      }
      const now = Date.now();
      // Bugfix：旧实现只在成功后更新时间基准，Feishu 失败时每个 stream event 都会真实发请求；
      // force 路径还会绕过普通节流。失败退避和熔断必须先于 force 判断，避免单次 400 被放大成风暴。
      if (run.streamingCardCircuitOpen || now < run.streamingCardNextAttemptAt) {
        return;
      }
      if (
        run.streamingCardHandle &&
        !force &&
        now - run.streamingCardLastUpdateAt < FEISHU_STREAMING_CARD_MIN_UPDATE_INTERVAL_MS
      ) {
        return;
      }
      const adapter = ctx.providers[run.bot.provider];
      const locale = await ctx.readMessageLocale();
      const state = {
        providerUserId: run.actor.providerUserId,
        locale,
        blocks: run.buildStreamingCardBlocks(locale),
        status: run.streamingCardStatus,
      };
      const states = adapter?.splitStreamingReplyCardStates?.(state) ?? [state];
      run.streamingCardQueue = run.streamingCardQueue
        .catch(() => undefined)
        .then(async () => {
          if (run.disposed || !(await run.isPrivateAuthorized())) return;
          let operation = run.streamingCardHandle ? "update" : "create";
          const requestController = new AbortController();
          ctx.streamingCardRequestControllers.add(requestController);
          const timeoutId = setTimeout(() => {
            requestController.abort(new Error("Feishu streaming card request timed out."));
          }, FEISHU_STREAMING_CARD_REQUEST_TIMEOUT_MS);
          try {
            for (
              let index = Math.min(run.streamingCardSegmentIndex, states.length - 1);
              index < states.length;
              index += 1
            ) {
              if (run.disposed || !(await run.isPrivateAuthorized())) return;
              const segmentState = states[index]!;
              operation = run.streamingCardHandle ? "update" : "create";
              const request = !run.streamingCardHandle
                ? adapter?.createStreamingReplyCard?.(
                    run.bot,
                    segmentState,
                    requestController.signal,
                  )
                : adapter?.updateStreamingReplyCard?.(
                    run.bot,
                    run.streamingCardHandle,
                    segmentState,
                    requestController.signal,
                  );
              const result = await Promise.race([
                request,
                new Promise<never>((_, reject) => {
                  requestController.signal.addEventListener(
                    "abort",
                    () => reject(requestController.signal.reason),
                    { once: true },
                  );
                }),
              ]);
              if (!run.streamingCardHandle) {
                run.streamingCardHandle = result ?? null;
                if (!run.streamingCardHandle) {
                  // Bug 根因：飞书创建接口可能 code=0 却不返回 message_id。若把这种静默失败
                  // 当成成功推进 segmentIndex，未投递的中间段会被永久跳过；必须统一进入退避重试。
                  throw new Error("Feishu create streaming card returned no message_id.");
                }
              }
              if (index < states.length - 1) {
                // 修复原因：当前卡片达到飞书元素预算后必须保留为 sealed 历史段，
                // 后续 block 只写入新卡片，不能把已展示内容再次发送或继续更新旧 message_id。
                run.streamingCardSegmentIndex = index + 1;
                run.streamingCardHandle = null;
              }
            }
            if (run.persistentPrivate) run.privateDeliveryFailed = false;
            run.streamingCardLastUpdateAt = Date.now();
            run.streamingCardConsecutiveFailures = 0;
            run.streamingCardNextAttemptAt = 0;
          } catch (error) {
            // Bugfix: 第三方卡片只是 best-effort 展示，超时/失败不能阻塞 task_complete、
            // task_error 或 typing 清理等生命周期事件。
            if (run.persistentPrivate) {
              run.privateDeliveryFailed = true;
              run.privateCardDeliveryUnknown = !isRecord(error) || error.deliveryRejected !== true;
            }
            run.streamingCardConsecutiveFailures += 1;
            const errorMessage = error instanceof Error ? error.message : String(error);
            ctx.onDeliveryResult(run.bot, errorMessage);
            if (
              run.streamingCardConsecutiveFailures >=
              FEISHU_STREAMING_CARD_FAILURE_CIRCUIT_THRESHOLD
            ) {
              run.streamingCardCircuitOpen = true;
              botsLogger.warn(
                undefined,
                `Feishu streaming card circuit opened task=${run.context.activeTaskId} trigger=${trigger} operation=${operation} failures=${run.streamingCardConsecutiveFailures}: ${errorMessage}`,
              );
            } else {
              const retryDelayMs =
                FEISHU_STREAMING_CARD_FAILURE_BACKOFF_BASE_MS *
                2 ** (run.streamingCardConsecutiveFailures - 1);
              run.streamingCardNextAttemptAt = Date.now() + retryDelayMs;
              botsLogger.warn(
                undefined,
                `Feishu streaming card sync failed task=${run.context.activeTaskId} trigger=${trigger} operation=${operation} failures=${run.streamingCardConsecutiveFailures} retryDelayMs=${retryDelayMs}: ${errorMessage}`,
              );
            }
          } finally {
            clearTimeout(timeoutId);
            ctx.streamingCardRequestControllers.delete(requestController);
          }
        });
      await run.streamingCardQueue;
    },

    sealStreamingCardReply: async (): Promise<void> => {
      if (!run.streamingCardHandle) {
        return;
      }
      // 修复原因：阻塞交互前的 Agent 输出与交互后的 continuation 属于两个可读段落。
      // 旧实现继续复用同一 message_id，导致问题/Plan 卡夹在中间但后续正文回写到旧卡。
      run.streamingCardStatus = "sealed";
      await run.syncStreamingCardReply("seal", true);
      run.streamingCardHandle = null;
      run.streamingCardSegmentIndex = 0;
      run.streamingCardBlocks.length = 0;
      run.streamingCardStatus = "running";
      run.streamingCardLastUpdateAt = 0;
    },
  };
}
