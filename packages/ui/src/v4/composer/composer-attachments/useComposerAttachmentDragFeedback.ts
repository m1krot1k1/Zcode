/**
 * composer 拖拽反馈：dragover 预览态、延迟复位与窗口级拖拽结束清理。
 * 只持有视觉状态，真正的附件接纳仍交给审批过的 addAttachmentFiles。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { WORKSPACE_FILE_DRAG_MIME } from "@/lib/workspaceFileDrag.js";

export interface ComposerAttachmentDragFeedback {
  composerDragKind: "attachment" | "workspace" | null;
  isDraggingOverComposer: boolean;
  handleDragOverComposer: (event: React.DragEvent<HTMLElement>) => void;
  handleDragLeaveComposer: (event: React.DragEvent<HTMLElement>) => void;
  handleDropComposer: (event: React.DragEvent<HTMLElement>) => void;
}

export function useComposerAttachmentDragFeedback(
  addAttachmentFiles: (files: File[]) => string[],
): ComposerAttachmentDragFeedback {
  const [composerDragKind, setComposerDragKind] = useState<"attachment" | "workspace" | null>(null);
  const isDraggingOverComposer = composerDragKind !== null;
  const dragFeedbackTimerRef = useRef<number | null>(null);

  const clearDragFeedbackTimer = useCallback(() => {
    if (dragFeedbackTimerRef.current !== null) {
      window.clearTimeout(dragFeedbackTimerRef.current);
      dragFeedbackTimerRef.current = null;
    }
  }, []);
  const resetComposerDragFeedback = useCallback(() => {
    clearDragFeedbackTimer();
    setComposerDragKind(null);
  }, [clearDragFeedbackTimer]);
  const scheduleComposerDragFeedbackReset = useCallback(() => {
    clearDragFeedbackTimer();
    dragFeedbackTimerRef.current = window.setTimeout(resetComposerDragFeedback, 300);
  }, [clearDragFeedbackTimer, resetComposerDragFeedback]);

  useEffect(() => {
    const handleDocumentDragLeave = (event: DragEvent) => {
      if (event.relatedTarget === null) resetComposerDragFeedback();
    };
    window.addEventListener("dragend", resetComposerDragFeedback);
    window.addEventListener("drop", resetComposerDragFeedback);
    window.addEventListener("blur", resetComposerDragFeedback);
    document.addEventListener("dragleave", handleDocumentDragLeave);
    return () => {
      clearDragFeedbackTimer();
      window.removeEventListener("dragend", resetComposerDragFeedback);
      window.removeEventListener("drop", resetComposerDragFeedback);
      window.removeEventListener("blur", resetComposerDragFeedback);
      document.removeEventListener("dragleave", handleDocumentDragLeave);
    };
  }, [clearDragFeedbackTimer, resetComposerDragFeedback]);

  const handleDragOverComposer = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      const types = Array.from(event.dataTransfer.types);
      const hasFiles = Array.from(event.dataTransfer.items ?? []).some(
        (item) => item.kind === "file",
      );
      if (!hasFiles && !types.includes("Files") && !types.includes(WORKSPACE_FILE_DRAG_MIME)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setComposerDragKind(types.includes(WORKSPACE_FILE_DRAG_MIME) ? "workspace" : "attachment");
      scheduleComposerDragFeedbackReset();
    },
    [scheduleComposerDragFeedbackReset],
  );
  const handleDragLeaveComposer = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      const nextTarget = event.relatedTarget;
      if (!(nextTarget instanceof Node && event.currentTarget.contains(nextTarget))) {
        resetComposerDragFeedback();
      }
    },
    [resetComposerDragFeedback],
  );
  const handleDropComposer = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (Array.from(event.dataTransfer.types).includes(WORKSPACE_FILE_DRAG_MIME)) {
        event.preventDefault();
        resetComposerDragFeedback();
        return;
      }
      const files = Array.from(event.dataTransfer.files);
      if (files.length > 0) {
        event.preventDefault();
        addAttachmentFiles(files);
      }
      resetComposerDragFeedback();
    },
    [addAttachmentFiles, resetComposerDragFeedback],
  );

  return {
    composerDragKind,
    isDraggingOverComposer,
    handleDragOverComposer,
    handleDragLeaveComposer,
    handleDropComposer,
  };
}
