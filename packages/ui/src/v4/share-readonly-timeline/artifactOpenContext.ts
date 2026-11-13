import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { isAbsoluteFilePath, joinFilePath } from "@/lib/path.js";
import type { ConversationShareArtifactOpenAction } from "@/v4/share-readonly-timeline/types.js";
import { createContext, useMemo } from "react";

export interface ArtifactOpenContextValue {
  artifactWorkspaceRelativePaths: ReadonlyMap<string, string>;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  openAction?: ConversationShareArtifactOpenAction;
}

export const ArtifactOpenContext =
  createContext<ArtifactOpenContextValue | null>(null);

export function resolveImportedArtifactPath(
  workspacePath: string,
  workspaceRelativePath: string | undefined,
): string | null {
  // 取舍：这里只校验形状（.zcode-share/<dir>/shared-artifacts/<file> 四段），刻意不把
  // 段 2 与导入记录的 shareId 交叉比对。元数据由本端导入服务自写（conversationShareService
  // 落盘时用 sanitizeFileSegment(share_id) 作目录名），自洽；若在 UI 侧比对，就得复制
  // service 层的 sanitize 规则，两边漂移会让合法导入静默丢打开按钮，而收益仅是防住
  // 「指向另一 share 目录」这种一致性噪声——路径仍被限制在 workspace 的
  // .zcode-share/*/shared-artifacts/ 内，无越权读放大。
  const normalizedPath = workspaceRelativePath?.trim();
  if (!normalizedPath || isAbsoluteFilePath(normalizedPath)) {
    return null;
  }

  const segments = normalizedPath.replace(/\\/g, "/").split("/");
  if (
    segments.length !== 4 ||
    segments.some(
      (segment) => !segment || segment === "." || segment === "..",
    ) ||
    segments[0] !== ".zcode-share" ||
    segments[2] !== "shared-artifacts"
  ) {
    return null;
  }

  return joinFilePath(workspacePath, segments.join("/"));
}

interface ArtifactOpenContextParams {
  artifactWorkspaceRelativePaths: ReadonlyMap<string, string>;
  workspacePath: string | undefined;
  workspaceIdentity: string | undefined;
  workspaceRemoteSessionId: string | undefined;
  onOpenFileLink: ((target: MessageFileLinkTarget) => void) | undefined;
  onOpenCodeViewer: ((source: CodeViewerSource) => void) | undefined;
  artifactOpenAction: ConversationShareArtifactOpenAction | undefined;
}

/** 只在「本地打开能力齐备」时建 context，其余情况保持 null（公开页不注入）。 */
export function useArtifactOpenContextValue({
  artifactWorkspaceRelativePaths,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  onOpenFileLink,
  onOpenCodeViewer,
  artifactOpenAction,
}: ArtifactOpenContextParams): ArtifactOpenContextValue | null {
  return useMemo<ArtifactOpenContextValue | null>(() => {
    if (
      !workspacePath ||
      artifactWorkspaceRelativePaths.size === 0 ||
      (!onOpenFileLink && !onOpenCodeViewer) ||
      !artifactOpenAction
    ) {
      return null;
    }

    return {
      artifactWorkspaceRelativePaths,
      workspacePath,
      openAction: artifactOpenAction,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {}),
      ...(onOpenFileLink ? { onOpenFileLink } : {}),
      ...(onOpenCodeViewer ? { onOpenCodeViewer } : {}),
    };
  }, [
    artifactOpenAction,
    artifactWorkspaceRelativePaths,
    onOpenCodeViewer,
    onOpenFileLink,
    workspaceIdentity,
    workspacePath,
    workspaceRemoteSessionId,
  ]);
}
