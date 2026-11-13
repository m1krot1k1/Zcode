// PreviewPane 拆分（max-lines）：代码评论的新增 / 删除。
// 评论同时存在于 Composer 附件通道和预览 store；两处必须同步增删。
import { useCallback } from "react";
import { nanoid } from "nanoid";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import {
  dispatchCodeCommentAddToChat,
  dispatchCodeCommentRemoveFromChat,
  isCodeCommentMarkedRemoved,
  type CodeCommentPreview,
  type CodeCommentRange,
} from "@/lib/codeCommentContext.js";

export interface PreviewPaneCodeCommentActionsOptions {
  source: CodeViewerSource | null;
  sourceWorkspacePath?: string;
  intl: IntlInstance;
  addCodeCommentPreview: (params: {
    workspacePath: string;
    workspaceIdentity?: string;
    sourcePath: string;
    comment: CodeCommentPreview;
  }) => void;
  removeCodeCommentPreview: (params: {
    workspacePath: string;
    workspaceIdentity?: string;
    sourcePath: string;
    id: string;
  }) => void;
}

export interface PreviewPaneCodeCommentActions {
  onSubmitCodeComment: (params: {
    range: CodeCommentRange;
    selectedText: string;
    comment: string;
  }) => void;
  onDeleteCodeComment: (commentId: string) => void;
}

export function usePreviewPaneCodeCommentActions({
  source,
  sourceWorkspacePath,
  intl,
  addCodeCommentPreview,
  removeCodeCommentPreview,
}: PreviewPaneCodeCommentActionsOptions): PreviewPaneCodeCommentActions {
  const handleSubmitCodeComment = useCallback(
    (params: { range: CodeCommentRange; selectedText: string; comment: string }) => {
      if (!source?.path || !sourceWorkspacePath) {
        return;
      }

      const normalizedComment = params.comment.trim();
      const commentId = nanoid();
      dispatchCodeCommentAddToChat({
        id: commentId,
        workspacePath: sourceWorkspacePath,
        workspaceIdentity: source.workspaceIdentity,
        sourcePath: source.path,
        sourceTitle: source.title,
        startLine: params.range.startLine,
        endLine: params.range.endLine,
        selectedText: params.selectedText,
        comment: normalizedComment,
        contextLabel: intl.formatMessage({
          id: "codeViewer.comment.contextLabel",
        }),
        commentLabel: intl.formatMessage({
          id: "codeViewer.comment.commentLabel",
        }),
      });
      if (
        isCodeCommentMarkedRemoved({
          id: commentId,
          workspacePath: sourceWorkspacePath,
          workspaceIdentity: source.workspaceIdentity,
        })
      ) {
        return;
      }
      addCodeCommentPreview({
        workspacePath: sourceWorkspacePath,
        workspaceIdentity: source.workspaceIdentity,
        sourcePath: source.path,
        comment: {
          id: commentId,
          sourcePath: source.path,
          sourceTitle: source.title,
          startLine: params.range.startLine,
          endLine: params.range.endLine,
          selectedText: params.selectedText,
          comment: normalizedComment,
        },
      });
    },
    [addCodeCommentPreview, intl, source, sourceWorkspacePath],
  );

  const handleDeleteCodeComment = useCallback(
    (commentId: string) => {
      if (!source?.path || !sourceWorkspacePath) {
        return;
      }
      removeCodeCommentPreview({
        workspacePath: sourceWorkspacePath,
        workspaceIdentity: source.workspaceIdentity,
        sourcePath: source.path,
        id: commentId,
      });
      dispatchCodeCommentRemoveFromChat({
        id: commentId,
        workspacePath: sourceWorkspacePath,
        workspaceIdentity: source.workspaceIdentity,
      });
    },
    [removeCodeCommentPreview, source, sourceWorkspacePath],
  );

  return {
    onSubmitCodeComment: handleSubmitCodeComment,
    onDeleteCodeComment: handleDeleteCodeComment,
  };
}
