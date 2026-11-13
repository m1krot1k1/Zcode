/**
 * 上传目标的纯函数与错误分类：scope key、远端目标判定、可重试错误和进度换算。
 * 不含 React 依赖，原 hook 以完全相同的参数与判定顺序调用它们。
 */
import type { IPlatformService } from "@zcode/shared";
import {
  MissingInlinePdfContentError,
  OversizedInlinePdfAttachmentError,
  OversizedInlineVideoAttachmentError,
} from "@/lib/chatAttachments.js";
import { REMOTE_ATTACHMENT_NOT_STAGED_ERROR_CODE, type UploadTarget } from "./types.js";

export async function selectAttachmentLocalPaths(
  platform: Pick<IPlatformService, "selectFile" | "selectFiles">,
): Promise<string[]> {
  const selectedPaths = platform.selectFiles
    ? await platform.selectFiles()
    : await platform.selectFile().then((selectedPath) => (selectedPath ? [selectedPath] : []));
  return selectedPaths.filter((path) => path.trim().length > 0);
}

export function buildScopeKey(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  scopeId: string,
): string {
  return `${workspaceIdentity?.trim() || workspacePath}\u0000${scopeId}`;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  return error instanceof Error && error.cause !== undefined ? isAbortError(error.cause) : false;
}

export class RemoteAttachmentNotStagedError extends Error {
  readonly code = REMOTE_ATTACHMENT_NOT_STAGED_ERROR_CODE;
}

export function isTransientAttachmentUploadError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (error instanceof OversizedInlineVideoAttachmentError) return false;
  if (error instanceof OversizedInlinePdfAttachmentError) return false;
  if (error instanceof MissingInlinePdfContentError) return false;
  if (
    error instanceof Error &&
    "code" in error &&
    error.code === REMOTE_ATTACHMENT_NOT_STAGED_ERROR_CODE
  ) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  // video 超限错误必须在黑名单里，否则会触发一次无意义重试；按错误类型精确拦截，
  // 避免扩大 message 正则后改变 image 超限的既有判定。
  return !/(?:payloadTooLarge|invalidBase64|invalidServerProgress|frameTooLarge|permission|EACCES|ENOENT|not found|unsupported|附件缺少|缺少可读取内容|远端附件未完成物化)/iu.test(
    message,
  );
}

export function progressPercent(uploadedBytes: number, totalBytes: number): number {
  if (totalBytes <= 0) return 0;
  return Math.min(99, Math.max(0, Math.floor((uploadedBytes / totalBytes) * 99)));
}

export function isRemoteAttachmentTarget(
  target: Pick<UploadTarget, "remoteSessionId" | "workspaceIdentity">,
) {
  // 这里曾要求 workspaceIdentity 能被当前解析器识别。远端 identity 新增格式或
  // 暂时非规范时，在 remoteSessionId 注入前会被误判为本地 workspace，使 host localPath
  // 直接走零复制交给远端 Agent。identity 只承担隔离语义；任意非空值都必须按远端 fail closed。
  return Boolean(target.remoteSessionId?.trim() || target.workspaceIdentity?.trim());
}
