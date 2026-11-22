/**
 * LexicalChatInput 首帧就绪打点。
 *
 * Lexical 编辑器初始化、slash/mention plugin 和外部 portal 分属不同组件。
 * 这里等浏览器下一帧再打点，才能和 composer shell 首帧、toolbar portal ready 对齐。
 */
import { useEffect, useRef } from "react";
import type { ZCodeProvider } from "@zcode/shared";
import { logger } from "@/logger.js";

export interface LexicalChatInputReadyLogOptions {
  activeTaskProvider: ZCodeProvider;
  disabled: boolean;
  promptHistoryLength: number;
  submitDisabled: boolean;
  taskId: string | null;
  triggerPanelContainer?: HTMLElement | null;
  workspaceIdentity?: string;
  workspacePath: string;
}

export function useLexicalChatInputReadyLog({
  activeTaskProvider,
  disabled,
  promptHistoryLength,
  submitDisabled,
  taskId,
  triggerPanelContainer,
  workspaceIdentity,
  workspacePath,
}: LexicalChatInputReadyLogOptions) {
  const inputMountedAtRef = useRef(Date.now());
  const lastReadyLogKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const readyLogKey = [
      workspaceIdentity ?? workspacePath,
      taskId ?? "draft",
      activeTaskProvider,
      triggerPanelContainer ? "trigger-ready" : "trigger-missing",
    ].join("|");
    if (lastReadyLogKeyRef.current === readyLogKey) {
      return;
    }
    lastReadyLogKeyRef.current = readyLogKey;

    let frameId: number | null = null;
    const logReady = () => {
      logger.info("[LexicalChatInput] 输入编辑器首帧完成", {
        durationMs: Date.now() - inputMountedAtRef.current,
        activeTaskProvider,
        disabled,
        hasPromptHistory: promptHistoryLength > 0,
        submitDisabled,
        taskId,
        triggerPanelReady: Boolean(triggerPanelContainer),
        workspaceIdentity: workspaceIdentity ?? null,
        workspacePath,
      });
    };

    if (typeof requestAnimationFrame === "function") {
      frameId = requestAnimationFrame(logReady);
    } else {
      logReady();
    }

    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [
    activeTaskProvider,
    disabled,
    promptHistoryLength,
    submitDisabled,
    taskId,
    triggerPanelContainer,
    workspaceIdentity,
    workspacePath,
  ]);
}
