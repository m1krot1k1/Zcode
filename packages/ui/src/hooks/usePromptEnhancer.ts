import { useCallback, useEffect, useRef, useState } from "react";
import type { PromptEnhancerService } from "@zcode/services";
import type { IDisposable } from "@zcode/rpc";
import {
  type PromptEnhanceRequest,
  type PromptEnhanceResult,
  type PromptEnhanceStyle,
  type PromptEnhanceTarget,
} from "@zcode/shared";
import { logger } from "../logger.js";

/**
 * Хук композера для нативного `Enhance Prompt`.
 *
 * Не знает о `window.zcode`: сервис приходит из `useServices()` (Local Host, SSH Server
 * или Web Remote). Dialog 4.6 смонтирует кнопку поверх этого хука; сам хук уже даёт
 * полный жизненный цикл: старт, отмена, стрим, ошибки и «применить/откатить».
 */

export interface UsePromptEnhancerOptions {
  promptEnhancerService: PromptEnhancerService;
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId?: string;
  target?: PromptEnhanceTarget;
  style?: PromptEnhanceStyle;
  collaborationMode?: string;
  /** Активные файлы: максимум 10 путей, только подсказка близости. */
  activeFilePaths?: readonly string[];
}

export interface PromptEnhanceState {
  status: "idle" | "running" | "ready" | "error" | "cancelled";
  result?: PromptEnhanceResult;
  /** Накопленный текст стрима; UI показывает его до финального результата. */
  streamingText: string;
  error?: { code: string; message: string };
  /** Исходный черновик, чтобы «Undo Enhance» восстановил байт-в-байт. */
  previousDraft?: string;
}

const INITIAL_STATE: PromptEnhanceState = { status: "idle", streamingText: "" };

type PromptEnhancerStreamSubscription = IDisposable | (() => void);

function releaseStreamSubscription(
  subscription: PromptEnhancerStreamSubscription | undefined,
): void {
  if (!subscription) {
    return;
  }
  if (typeof subscription === "function") {
    subscription();
    return;
  }
  subscription.dispose();
}

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `enh_${Date.now().toString(36)}_${requestCounter}`;
}

export function usePromptEnhancer(options: UsePromptEnhancerOptions) {
  const [state, setState] = useState<PromptEnhanceState>(INITIAL_STATE);
  const activeRequestId = useRef<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Хук исчез из дерева (смена композера) — незавершённый запрос не должен жить в Host.
      const requestId = activeRequestId.current;
      if (requestId) {
        void options.promptEnhancerService.cancel({ requestId }).catch(() => {});
        activeRequestId.current = null;
      }
    };
  }, [options.promptEnhancerService]);

  useEffect(() => {
    // Bug 原因：本地服务返回函数式取消订阅，而经过 ProxyChannel 的远程服务
    // 按 Event 合同返回 IDisposable；两种形态都必须能安全释放，否则卸载时
    // 调用对象会抛 “t is not a function” 并被错误边界捕获。
    let unsubscribe: PromptEnhancerStreamSubscription | undefined;
    try {
      unsubscribe = options.promptEnhancerService.onStreamDelta((event) => {
        if (event.requestId !== activeRequestId.current || !mounted.current) return;
        setState((previous) => ({ ...previous, streamingText: event.accumulated }));
      });
    } catch (error) {
      logger.warn("Prompt enhancer stream subscription failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return () => releaseStreamSubscription(unsubscribe);
  }, [options.promptEnhancerService]);

  const enhance = useCallback(
    async (draftText: string): Promise<PromptEnhanceResult | null> => {
      const trimmed = draftText.trim();
      if (trimmed.length < 2) {
        setState({
          status: "error",
          streamingText: "",
          error: { code: "invalid_request", message: "Draft is too short to enhance." },
        });
        return null;
      }
      const request: PromptEnhanceRequest = {
        requestId: nextRequestId(),
        workspacePath: options.workspacePath,
        ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        target: options.target ?? "chat_user_prompt",
        style: options.style ?? "structured_engineering",
        draftText: trimmed,
        preservedMentions: [],
        activeFilePaths: [...(options.activeFilePaths ?? [])].slice(0, 10),
        ...(options.collaborationMode ? { collaborationMode: options.collaborationMode } : {}),
      };
      activeRequestId.current = request.requestId;
      setState({ status: "running", streamingText: "", previousDraft: draftText });
      try {
        const result = await options.promptEnhancerService.enhance(request);
        if (!mounted.current) return result;
        activeRequestId.current = null;
        setState({
          status: "ready",
          result,
          streamingText: result.enhancedText,
          previousDraft: draftText,
        });
        return result;
      } catch (error) {
        if (!mounted.current) return null;
        activeRequestId.current = null;
        const code =
          error && typeof error === "object" && "code" in error
            ? String((error as { code: unknown }).code)
            : "model_failed";
        const message = error instanceof Error ? error.message : String(error);
        // Отмена — не ошибка пользователя: состояние отдельное, чтобы UI не показывал красный toast.
        setState({
          status: code === "aborted" ? "cancelled" : "error",
          streamingText: "",
          error: { code, message },
          previousDraft: draftText,
        });
        logger.warn("Prompt enhancement failed", { code });
        return null;
      }
    },
    [
      options.promptEnhancerService,
      options.workspacePath,
      options.workspaceIdentity,
      options.sessionId,
      options.target,
      options.style,
      options.collaborationMode,
      options.activeFilePaths,
    ],
  );

  const cancel = useCallback(async (): Promise<void> => {
    const requestId = activeRequestId.current;
    if (!requestId) return;
    try {
      await options.promptEnhancerService.cancel({ requestId });
    } catch (error) {
      logger.warn("Prompt enhancer cancel failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [options.promptEnhancerService]);

  const reset = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  /** Возвращает исходный черновик для «Undo Enhance» без обращения к Host. */
  const undo = useCallback((): string | undefined => {
    const previous = state.previousDraft;
    setState(INITIAL_STATE);
    return previous;
  }, [state.previousDraft]);

  return {
    status: state.status,
    result: state.result,
    streamingText: state.streamingText,
    error: state.error,
    isRunning: state.status === "running",
    enhance,
    cancel,
    reset,
    undo,
  } as const;
}
