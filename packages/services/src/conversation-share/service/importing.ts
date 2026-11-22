import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { decodeConversationShareRows } from "@zcode/shared";
import { z } from "zod";

import {
  ConversationShareServiceError,
  type ImportConversationShareInput,
  type ImportConversationShareResult,
  type ImportedConversationShare,
} from "../conversationShare.js";
import { formatSharedContextV1 } from "../sharedContextFormatter.js";

import {
  downloadArtifactBytes,
  sanitizeFileSegment,
  uniqueImportedFileName,
} from "./artifacts.js";
import { workspaceKeyOf } from "./keys.js";
import {
  formatImportedShareSessionTitle,
  throwServiceError,
  type ConversationShareServiceRuntime,
} from "./runtime.js";

/** 本端产出的只读副本格式版本；与 wire 的 schema_version 各自独立演进。 */
const IMPORTED_CONVERSATION_SHARE_FORMAT_VERSION = 1;

/**
 * 落盘的只读副本形状；来自磁盘，渲染前必须校验。
 *
 * formatVersion 与 rows 都刻意宽容：用户在新版导入过会话后回退到旧版时，只读块应该尽量
 * 显示出来（认不出的行跳过 + 顶部软提示），而不是整块静默消失让人以为内容丢了。
 */
const importedConversationShareFileSchema = z
  .object({
    formatVersion: z.number().int().positive(),
    shareId: z.string().trim().min(1),
    contextId: z.string().trim().min(1),
    title: z.string(),
    rows: z.array(z.unknown()),
    content_blocks: z.array(z.unknown()).optional(),
    artifacts: z.array(
      z.object({
        artifactId: z.string().trim().min(1),
        displayName: z.string(),
        mimeType: z.string().optional(),
        workspaceRelativePath: z.string().optional(),
      }),
    ),
  })
  .strip();

export async function importShare(
  runtime: ConversationShareServiceRuntime,
  input: ImportConversationShareInput,
  operationId: string,
): Promise<ImportConversationShareResult> {
  await runtime.imports.ready;
  const workspaceKey = workspaceKeyOf(
    input.targetWorkspacePath,
    input.targetWorkspaceIdentity,
  );
  const completed = runtime.imports.find(
    input.shareCode,
    workspaceKey,
    input.clientRequestId,
  );
  if (completed) {
    runtime.logger.info(undefined, "conversation share import reused", {
      operationId,
      phase: "complete",
    });
    return { ...completed, reused: true };
  }
  const inFlight = runtime.imports.findInFlight(
    input.shareCode,
    workspaceKey,
    input.clientRequestId,
  );
  if (inFlight) {
    return inFlight;
  }
  const promise = importShareInternal(runtime, input, operationId).then(
    (result) =>
      runtime.imports
        .record(input.shareCode, workspaceKey, input.clientRequestId, result)
        .catch(() => undefined)
        .then(() => result),
  );
  runtime.imports.trackInFlight(
    input.shareCode,
    workspaceKey,
    input.clientRequestId,
    promise,
  );
  return promise;
}

async function importShareInternal(
  runtime: ConversationShareServiceRuntime,
  input: ImportConversationShareInput,
  operationId: string,
): Promise<ImportConversationShareResult> {
  const zcodeSessionService = runtime.zcodeSessionService;
  if (!zcodeSessionService) {
    throwServiceError(
      "feature_disabled",
      "Conversation share import is unavailable",
    );
  }
  // 两个摘要已在 ConversationShareHttpClient.getContinuation 里对服务端原样发来的值复核过。
  // 不能在这里拿解析产物重算：zod 默认剥掉未知字段，那样发布端加一个 optional 字段就会让
  // 所有老客户端算出不同的哈希，把纯 additive 的演进误报成「分享文件校验失败」。
  const continuation = await runtime.client.getContinuation(input.shareCode, {
    schema_version: 1,
    client_request_id: input.clientRequestId,
  });

  const remoteTarget =
    input.targetWorkspaceKind === "remote" ||
    Boolean(input.targetWorkspaceIdentity);
  const workspacePath =
    input.targetWorkspacePath && !remoteTarget
      ? input.targetWorkspacePath
      : runtime.conversationWorkspaceRoot;
  const workspaceIdentity =
    input.targetWorkspaceIdentity && !remoteTarget
      ? input.targetWorkspaceIdentity
      : undefined;
  const shareRoot = join(workspacePath, ".zcode-share");
  const importRoot = join(
    shareRoot,
    sanitizeFileSegment(continuation.share.share_id),
  );
  const markerPath = join(importRoot, ".zcode-share-import.json");
  const stagingPath = join(importRoot, ".share-import-staging");
  const finalArtifactsPath = join(importRoot, "shared-artifacts");
  const conversationPath = join(importRoot, "shared-conversation.json");
  const importId = randomUUID();
  const contextId = `shared-context-${randomUUID()}`;
  const sessionId = `share-import-${randomUUID()}`;
  // 这个 URL 会进持久化的 provenance 与 sharedContextImport 快照，而
  // sharedContextImportV2StateSchema 只接受规范的 /cn/share/<code>；durable 记录也不该
  // 存随界面语言变化的值（用户之后切语言，存的就错了）。本地化只在展示时做。
  const shareUrl = `${runtime.shareWebUrl}/${encodeURIComponent(input.shareCode)}`;
  await mkdir(shareRoot, { recursive: true });
  try {
    const existingMarker = JSON.parse(
      await readFile(markerPath, "utf8"),
    ) as Record<string, unknown>;
    if (
      existingMarker.shareCode === input.shareCode &&
      typeof existingMarker.sessionId === "string" &&
      existingMarker.sessionId.startsWith("share-import-")
    ) {
      const sessions = await zcodeSessionService.listSessions({
        workspacePath,
        limit: 100,
      });
      const existingSession = sessions.find(
        (item) => item.sessionId === existingMarker.sessionId,
      );
      if (
        existingSession &&
        typeof existingMarker.contextId === "string" &&
        typeof existingMarker.shareUrl === "string"
      ) {
        return {
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          sessionId: existingSession.sessionId,
          contextId: existingMarker.contextId,
          shareUrl: existingMarker.shareUrl,
          title: existingSession.title,
          reused: true,
        };
      }
      await rm(importRoot, { recursive: true, force: true });
    }
  } catch {
    // 没有 marker 或 marker 不完整时继续创建；非本次 share 的目录不会被删除。
  }
  // 语义是「失败时是否还允许删 importRoot」，不是「我创建了它」：session 一旦提交
  // 就必须解除武装（见下方 createSession 之后）。
  let importRootCleanupArmed = false;
  try {
    await mkdir(importRoot);
    importRootCleanupArmed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throwServiceError(
        "unknown",
        "Conversation share import is already in progress",
      );
    }
    throw error;
  }
  try {
    await writeFile(
      markerPath,
      JSON.stringify({
        importId,
        shareCode: input.shareCode,
        clientRequestId: input.clientRequestId,
        sessionId,
        shareId: continuation.share.share_id,
        contextId,
        shareUrl,
        workspaceKey: workspaceKeyOf(workspacePath, workspaceIdentity),
        phase: "preparing",
        createdAt: runtime.now(),
      }),
      "utf8",
    );
  } catch (error) {
    await rm(importRoot, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  }
  try {
    await mkdir(stagingPath);
    const installedArtifacts: Array<{
      artifactId: string;
      workspaceRelativePath: string;
      displayName: string;
      mimeType: string;
      sha256: string;
    }> = [];
    const usedNames = new Set<string>();
    let completedArtifacts = 0;
    runtime.progress.fireImport(operationId, {
      phase: "downloading",
      completedArtifacts: 0,
      totalArtifacts: continuation.artifacts.length,
    });
    await writeFile(
      markerPath,
      JSON.stringify({
        importId,
        shareCode: input.shareCode,
        clientRequestId: input.clientRequestId,
        sessionId,
        shareId: continuation.share.share_id,
        contextId,
        shareUrl,
        workspaceKey: workspaceKeyOf(workspacePath, workspaceIdentity),
        phase: "downloading",
        createdAt: runtime.now(),
      }),
      "utf8",
    );
    for (const artifact of continuation.artifacts) {
      const { bytes, responseMimeType } = await downloadArtifactBytes(
        runtime,
        artifact,
      );
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (
        bytes.byteLength !== artifact.size_bytes ||
        sha256 !== artifact.sha256
      ) {
        throw new ConversationShareServiceError(
          "invalid_contract",
          "Conversation artifact integrity check failed",
          {
            issues: [
              {
                code: "artifact_changed",
                scope: "artifact",
                artifactDisplayName: artifact.display_name,
                artifactType: artifact.artifact_type,
                extension: artifact.extension,
                mimeType: artifact.mime_type,
                actual: bytes.byteLength,
                limit: artifact.size_bytes,
                phase: "downloading",
              },
            ],
          },
        );
      }
      // content-type 不一致不能直接判 invalid_contract，否则 .md 一律导入失败——
      // 对象存储/CDN 按自己的规则给下载打标签（.md 常被标成 text/plain 或
      // application/octet-stream），与发布时的 mime_type 无关。
      //
      // 而到这一行字节已经通过 size + SHA-256 校验，且清单本身由 artifact_set_sha256 覆盖，
      // 所以 artifact.mime_type 才是权威值，响应头不提供任何额外完整性保证——
      // 拿它当门禁只会造成误拒。这里降级为记录，不再阻断。
      if (
        responseMimeType &&
        responseMimeType.toLowerCase() !== artifact.mime_type.toLowerCase()
      ) {
        runtime.logger.info(
          undefined,
          "conversation share artifact content-type differs",
          {
            artifactType: artifact.artifact_type,
            extension: artifact.extension,
            expectedMimeType: artifact.mime_type,
            responseMimeType,
          },
        );
      }
      const fileName = uniqueImportedFileName(
        artifact.display_name,
        artifact.artifact_id,
        usedNames,
      );
      await writeFile(join(stagingPath, fileName), bytes);
      installedArtifacts.push({
        artifactId: artifact.artifact_id,
        workspaceRelativePath: `.zcode-share/${sanitizeFileSegment(continuation.share.share_id)}/shared-artifacts/${fileName}`,
        displayName: artifact.display_name,
        mimeType: artifact.mime_type,
        sha256: artifact.sha256,
      });
      completedArtifacts += 1;
      runtime.progress.fireImport(operationId, {
        phase: "downloading",
        completedArtifacts,
        totalArtifacts: continuation.artifacts.length,
      });
    }
    runtime.progress.fireImport(operationId, {
      phase: "installing",
      completedArtifacts,
      totalArtifacts: continuation.artifacts.length,
    });
    await writeFile(
      markerPath,
      JSON.stringify({
        importId,
        shareCode: input.shareCode,
        clientRequestId: input.clientRequestId,
        sessionId,
        shareId: continuation.share.share_id,
        contextId,
        shareUrl,
        workspaceKey: workspaceKeyOf(workspacePath, workspaceIdentity),
        phase: "installing",
        createdAt: runtime.now(),
      }),
      "utf8",
    );
    await rename(stagingPath, finalArtifactsPath);
    // 只读块要能永久离线打开：分享可能过期或尚未上线，渲染时不能回源，
    // 所以把公开 rows 与结果物元数据一起落在 importRoot 内，随失败清理一起删除。
    //
    // 写 rawRows 而不是解析产物：本端认不出的行和字段照样存下来，用户升级之后就能看到，
    // 不会因为导入当天的版本较旧而被永久抹掉。
    await writeFile(
      conversationPath,
      JSON.stringify({
        formatVersion: IMPORTED_CONVERSATION_SHARE_FORMAT_VERSION,
        shareId: continuation.share.share_id,
        contextId,
        title: continuation.share.title,
        rows: continuation.rawRows,
        ...(continuation.content_blocks
          ? { content_blocks: continuation.content_blocks }
          : {}),
        artifacts: continuation.artifacts.map((artifact) => ({
          artifactId: artifact.artifact_id,
          displayName: artifact.display_name,
          mimeType: artifact.mime_type,
          workspaceRelativePath: installedArtifacts.find(
            (installed) => installed.artifactId === artifact.artifact_id,
          )?.workspaceRelativePath,
        })),
      }),
      "utf8",
    );
    const context = formatSharedContextV1({
      share: {
        shareId: continuation.share.share_id,
        title: continuation.share.title,
      },
      rows: continuation.rows,
      installedArtifacts,
    });
    if (context.unsupportedKinds.length > 0) {
      // 模型侧 shared_context 少了内容：不阻断导入，但必须留痕。
      runtime.logger.info(
        undefined,
        "shared context skipped row kinds this build cannot format",
        {
          kinds: context.unsupportedKinds,
        },
      );
    }
    runtime.progress.fireImport(operationId, {
      phase: "committing",
      completedArtifacts,
      totalArtifacts: continuation.artifacts.length,
    });
    await writeFile(
      markerPath,
      JSON.stringify({
        importId,
        shareCode: input.shareCode,
        clientRequestId: input.clientRequestId,
        sessionId,
        shareId: continuation.share.share_id,
        contextId,
        shareUrl,
        workspaceKey: workspaceKeyOf(workspacePath, workspaceIdentity),
        phase: "committing",
        createdAt: runtime.now(),
      }),
      "utf8",
    );
    const snapshot = await zcodeSessionService.createSession({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      sessionId,
      persistence: "immediate",
      importedHistory: {
        source: "sharedContext",
        // 会话标题加前缀，让导入的会话在任务列表里一眼可识别。
        // 注意 UI 侧没有任何地方读 sharedContextImport.title（只读 contextId/status/shareUrl），
        // 所以前缀不会污染展示；CLI 已直接用 importedHistory.title 写 session.title。
        title: formatImportedShareSessionTitle(
          continuation.share.title,
          input.locale,
        ),
        markdown: context.markdown,
        provenance: {
          shareId: continuation.share.share_id,
          contextId,
          shareUrl,
          status: "pending",
          projectionSha256: continuation.integrity.projection_sha256,
          artifactSetSha256: continuation.integrity.artifact_set_sha256,
          formatterVersion: 1,
          markdownSha256: context.markdownSha256,
          installedArtifacts: installedArtifacts.map((artifact) => ({
            artifactId: artifact.artifactId,
            workspaceRelativePath: artifact.workspaceRelativePath,
          })),
        },
      },
    });
    // session 已提交，且它的 provenance 引用 importRoot 里已安装的
    // artifacts。此后 marker 清理或进度上报一旦抛错，旧的 catch 会 rm -rf importRoot，
    // 用户就拿到一个引用缺失文件的会话。失败半径必须止于 createSession 之前，
    // 所以这里立刻解除清理武装；marker 是纯痕迹文件，删不掉也不该让导入失败。
    importRootCleanupArmed = false;
    await rm(markerPath, { force: true }).catch(() => undefined);
    runtime.progress.fireImport(operationId, {
      phase: "complete",
      completedArtifacts,
      totalArtifacts: continuation.artifacts.length,
    });
    return {
      workspacePath,
      workspaceIdentity,
      sessionId: snapshot.session.sessionId,
      contextId,
      shareUrl,
      title: continuation.share.title,
      reused: false,
      ...(remoteTarget
        ? { fallbackReason: "remote_workspace" as const }
        : input.targetWorkspacePath
          ? {}
          : { fallbackReason: "default_workspace" as const }),
    };
  } catch (error) {
    // 导入改为落在现有 workspace 后，删除 workspace 根目录会损坏用户项目；
    // 失败清理只能触及本次 import-owned 子目录。
    if (importRootCleanupArmed) {
      await rm(importRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    throw error;
  }
}

/**
 * 按 contextId 找回导入时落盘的公开 rows。
 *
 * 目录名用的是 share_id 而不是 contextId（二者不等价），所以扫 .zcode-share/ 下各
 * importRoot 并比对文件内的 contextId —— 不额外维护索引，历史导入也能被读到。
 * 内容来自磁盘，属跨存储边界，必须过 schema 再交给渲染层。
 */
export async function getImportedConversation(
  runtime: Pick<ConversationShareServiceRuntime, "logger">,
  input: {
    workspacePath: string;
    contextId: string;
  },
): Promise<ImportedConversationShare | null> {
  const shareRoot = join(input.workspacePath, ".zcode-share");
  let entries: Dirent[];
  try {
    entries = await readdir(shareRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        await readFile(
          join(shareRoot, entry.name, "shared-conversation.json"),
          "utf8",
        ),
      );
    } catch {
      continue;
    }
    const validated = importedConversationShareFileSchema.safeParse(parsed);
    if (!validated.success || validated.data.contextId !== input.contextId)
      continue;
    const decoded = decodeConversationShareRows(validated.data.rows);
    // formatVersion 比本端新（用户在新版导入后回退到旧版）时，认不出的行照样计入
    // unsupportedRowCount，让 UI 出软提示——不能静默少内容。
    const unsupportedRowCount =
      decoded.unsupportedCount +
      (validated.data.formatVersion > IMPORTED_CONVERSATION_SHARE_FORMAT_VERSION
        ? 1
        : 0);
    if (unsupportedRowCount > 0) {
      runtime.logger.info(
        undefined,
        "imported conversation share has content this build can't read",
        {
          formatVersion: validated.data.formatVersion,
          kinds: decoded.unsupportedKinds,
          droppedCount: decoded.unsupportedCount,
          keptCount: decoded.rows.length,
        },
      );
    }
    return {
      shareId: validated.data.shareId,
      contextId: validated.data.contextId,
      title: validated.data.title,
      rows: decoded.rows,
      contentBlocks: validated.data.content_blocks,
      artifacts: validated.data.artifacts,
      unsupportedRowCount,
    };
  }
  return null;
}

export async function cleanupAbandonedImports(
  runtime: Pick<
    ConversationShareServiceRuntime,
    "zcodeSessionService" | "conversationWorkspaceRoot" | "imports"
  >,
): Promise<void> {
  const zcodeSessionService = runtime.zcodeSessionService;
  if (!zcodeSessionService) return;
  await runtime.imports.ready;
  // 只扫描默认 conversation workspace 的 import-owned 子目录；其它 workspace 的 marker
  // 在下一次带 target 的导入请求中处理，避免启动期枚举并触碰用户项目目录。
  const shareRoot = join(runtime.conversationWorkspaceRoot, ".zcode-share");
  const imports = await readdir(shareRoot, { withFileTypes: true }).catch(
    () => [],
  );
  for (const entry of imports) {
    if (!entry.isDirectory()) continue;
    const importRoot = join(shareRoot, entry.name);
    const markerPath = join(importRoot, ".zcode-share-import.json");
    let marker: {
      sessionId?: unknown;
      shareCode?: unknown;
      clientRequestId?: unknown;
      workspaceKey?: unknown;
      contextId?: unknown;
      shareUrl?: unknown;
    };
    try {
      marker = JSON.parse(await readFile(markerPath, "utf8")) as typeof marker;
    } catch {
      continue;
    }
    if (
      typeof marker.sessionId !== "string" ||
      !marker.sessionId.startsWith("share-import-")
    )
      continue;
    try {
      const sessions = await zcodeSessionService.listSessions({
        workspacePath: runtime.conversationWorkspaceRoot,
        limit: 100,
      });
      const session = sessions.find(
        (item) => item.sessionId === marker.sessionId,
      );
      if (session) {
        if (
          typeof marker.shareCode === "string" &&
          typeof marker.clientRequestId === "string" &&
          typeof marker.contextId === "string" &&
          typeof marker.shareUrl === "string"
        ) {
          const workspaceKey =
            typeof marker.workspaceKey === "string"
              ? marker.workspaceKey
              : runtime.conversationWorkspaceRoot;
          const result: ImportConversationShareResult = {
            workspacePath: runtime.conversationWorkspaceRoot,
            sessionId: session.sessionId,
            contextId: marker.contextId,
            shareUrl: marker.shareUrl,
            title: session.title,
            reused: true,
          };
          await runtime.imports
            .record(
              marker.shareCode,
              workspaceKey,
              marker.clientRequestId,
              result,
            )
            .catch(() => undefined);
        }
        await rm(markerPath, { force: true });
      } else {
        // 只删除带合法 marker 且没有匹配 session 的本次 importRoot。
        await rm(importRoot, { recursive: true, force: true });
      }
    } catch {
      // 无法证明 session 状态时保留 importRoot，禁止把暂时性错误升级为数据删除。
    }
  }
}
