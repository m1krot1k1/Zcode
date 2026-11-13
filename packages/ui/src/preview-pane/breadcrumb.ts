// PreviewPane 拆分（max-lines）：顶部路径面包屑的数据构造，以及图片预览的跨工作区文件引用。
import { resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { getPathLeaf } from "@/lib/path.js";
import type { WorkspaceFileDragPayload } from "@/lib/workspaceFileDrag.js";
import {
  getWorkspaceFileRelativePath,
  isWorkspaceFilePathInside,
} from "@/workspace-file-tree/model.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { CodeViewerBreadcrumbData } from "./constants.js";

function normalizeBreadcrumbPathSegments(path: string): string[] {
  return path.replace(/\\/g, "/").split("/").filter(Boolean);
}

export function buildCodeViewerBreadcrumb(
  source: CodeViewerSource,
  workspacePath?: string,
): CodeViewerBreadcrumbData | null {
  const sourcePath = source.path;
  if (!sourcePath) {
    if (!source.title.trim()) {
      return null;
    }

    return {
      rootLabel: null,
      parentSegments: [],
      fileLabel: source.title,
      fileIconSrc: null,
    };
  }

  const normalizedSourcePath = sourcePath.replace(/\\/g, "/");
  const normalizedWorkspacePath = workspacePath?.replace(/\\/g, "/").replace(/\/+$/, "") ?? null;
  const sourceLeaf = getPathLeaf(sourcePath);
  const descriptor = resolveFileDisplayDescriptor(sourcePath);
  if (
    normalizedWorkspacePath &&
    (normalizedSourcePath === normalizedWorkspacePath ||
      normalizedSourcePath.startsWith(`${normalizedWorkspacePath}/`))
  ) {
    const relativePath =
      normalizedSourcePath === normalizedWorkspacePath
        ? ""
        : normalizedSourcePath.slice(normalizedWorkspacePath.length + 1);
    const relativeSegments = normalizeBreadcrumbPathSegments(relativePath);

    return {
      rootLabel: getPathLeaf(normalizedWorkspacePath),
      parentSegments: relativeSegments.slice(0, -1),
      fileLabel: relativeSegments.at(-1) ?? sourceLeaf,
      fileIconSrc: descriptor.fileIconSrc,
    };
  }

  const sourceSegments = normalizeBreadcrumbPathSegments(normalizedSourcePath);
  return {
    rootLabel: sourcePath.startsWith("/") ? "/" : (sourceSegments[0] ?? null),
    parentSegments: sourcePath.startsWith("/")
      ? sourceSegments.slice(0, -1)
      : sourceSegments.slice(1, -1),
    fileLabel: sourceSegments.at(-1) ?? sourceLeaf,
    fileIconSrc: descriptor.fileIconSrc,
  };
}

export function resolvePreviewPaneImageFileReference(
  source: CodeViewerSource | null,
  workspacePath?: string,
  targetWorkspaceKey?: string,
): WorkspaceFileDragPayload | undefined {
  const sourceWorkspacePath = source?.workspacePath ?? workspacePath;
  const workspaceIdentity = source?.workspaceIdentity?.trim();
  if (!source?.path || !sourceWorkspacePath) return undefined;
  const sourceWorkspaceKey = workspaceIdentity || sourceWorkspacePath;
  const sourceIsRemote = Boolean(workspaceIdentity || source.workspaceRemoteSessionId);
  const targetIsRemote = Boolean(
    workspacePath && targetWorkspaceKey && targetWorkspaceKey !== workspacePath,
  );
  // 本地文件沿用文件树的跨工作区绝对引用；远端必须匹配身份，不能把另一 Host 的 path 交给当前草稿。
  if ((sourceIsRemote || targetIsRemote) && sourceWorkspaceKey !== targetWorkspaceKey)
    return undefined;
  return {
    type: "file",
    workspacePath: sourceWorkspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    path: source.path,
    // 预览允许工作区外路径；文件树的相对路径 helper 对外部文件只返回文件名，会误指向同名文件。
    relativePath: isWorkspaceFilePathInside(sourceWorkspacePath, source.path)
      ? getWorkspaceFileRelativePath(sourceWorkspacePath, source.path)
      : source.path,
    name: getPathLeaf(source.path) || source.title,
  };
}
