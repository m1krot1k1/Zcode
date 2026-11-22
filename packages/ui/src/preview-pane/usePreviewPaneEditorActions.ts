// PreviewPane 拆分（max-lines）：已安装编辑器查询、编辑器选择与「在编辑器中打开」。
import { useEffect, useMemo, useState } from "react";
import type { EditorInfo, OpenInEditorRemoteTarget } from "@zcode/shared";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { readLastSelectedEditorId } from "@/lib/editorPreference.js";
import { resolveWorkspaceEditorSelection } from "@/lib/workspaceEditorSelection.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";

export interface PreviewPaneEditorActionsOptions {
  platform: ReturnType<typeof usePlatform>;
  source: CodeViewerSource | null;
  /** 参与「按文件类型查询已安装编辑器」的路径；code-review 不参与。 */
  editorFilePath?: string;
  isRemoteSource: boolean;
  openInEditorRemoteTarget?: OpenInEditorRemoteTarget;
}

export interface PreviewPaneEditorActions {
  selectedEditor: EditorInfo | null;
  canOpenInEditor: boolean;
  handleOpenInEditor: () => Promise<void>;
}

export function usePreviewPaneEditorActions({
  platform,
  source,
  editorFilePath,
  isRemoteSource,
  openInEditorRemoteTarget,
}: PreviewPaneEditorActionsOptions): PreviewPaneEditorActions {
  const [installedEditorQuery, setInstalledEditorQuery] = useState<{
    path: string | undefined;
    editors: EditorInfo[];
  } | null>(null);
  // 文件类型变化后不能沿用上一份应用列表；查询结果与路径绑定，旧请求由 effect 清理失效。
  const installedEditors = useMemo(
    () =>
      installedEditorQuery?.path === editorFilePath ? (installedEditorQuery?.editors ?? []) : [],
    [installedEditorQuery, editorFilePath],
  );
  const [preferredEditorId] = useState<string | null>(() => readLastSelectedEditorId());

  useEffect(() => {
    let disposed = false;

    platform
      .getInstalledEditors(editorFilePath)
      .then((editors) => {
        if (disposed) {
          return;
        }

        setInstalledEditorQuery({ path: editorFilePath, editors });
      })
      .catch((platformError) => {
        logger.warn("[PreviewPane] 获取已安装编辑器列表失败", {
          error: platformError instanceof Error ? platformError.message : String(platformError),
        });
      });

    return () => {
      disposed = true;
    };
  }, [platform, editorFilePath]);

  const editorSelection = useMemo(
    () =>
      resolveWorkspaceEditorSelection({
        installedEditors: isRemoteSource && !openInEditorRemoteTarget ? [] : installedEditors,
        selectedEditorId: preferredEditorId,
        remoteTarget: openInEditorRemoteTarget,
      }),
    [installedEditors, isRemoteSource, openInEditorRemoteTarget, preferredEditorId],
  );
  const selectedEditor = editorSelection.selectedEditor;
  const canOpenInEditor = Boolean(source?.path && selectedEditor);

  const handleOpenInEditor = async () => {
    if (!source?.path || !selectedEditor) {
      return;
    }

    try {
      // 远程能力过滤产生的 fallback 只用于本次打开；不能把它写回面板偏好，
      // 否则同一 PreviewPane 切回本地文件时仍会错误沿用远程 VS Code。
      const result = await platform.openInEditor(selectedEditor.id, source.path, {
        pathKind: "file",
        remoteTarget: openInEditorRemoteTarget,
        workspaceIdentity: source.workspaceIdentity,
      });
      if (result.success) {
        return;
      }

      logger.warn("[PreviewPane] 用编辑器打开文件失败", {
        editorId: selectedEditor.id,
        path: source.path,
        error: result.error ?? "unknown-error",
      });
    } catch (platformError) {
      logger.warn("[PreviewPane] 打开文件失败", {
        path: source.path,
        error: platformError instanceof Error ? platformError.message : String(platformError),
      });
    }
  };

  return { selectedEditor, canOpenInEditor, handleOpenInEditor };
}
