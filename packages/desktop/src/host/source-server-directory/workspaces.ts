import type { SourceServerWorkspaceHistoryEntry } from "@zcode/shared";
import type { SourceServerDirectoryContext } from "./types.js";

export async function recordWorkspaceOpen(
  context: SourceServerDirectoryContext,
  input: {
    profileId: string;
    sourceServerId: string;
    workspacePath: string;
    workspaceIdentity: string;
    workspacePurpose?: "project" | "conversation";
    legacyWorkspaceIdentity?: string;
    openedAt?: number;
    signal?: AbortSignal;
  },
): Promise<void> {
  input.signal?.throwIfAborted();
  if (input.workspacePurpose === "conversation") {
    // conversation backing workspace 只属于设备级 canonical path，不得污染 strict project history。
    return;
  }
  await context.initialize();
  input.signal?.throwIfAborted();
  await context.enqueue(async () => {
    input.signal?.throwIfAborted();
    const settings = await context.options.settingService.get();
    input.signal?.throwIfAborted();
    const history = [...(settings.sourceServerWorkspaceHistory ?? [])];
    const index = history.findIndex(
      (entry) =>
        entry.sourceServerId === input.sourceServerId &&
        entry.workspacePath === input.workspacePath,
    );
    const existing = index >= 0 ? history[index] : undefined;
    const legacyWorkspaceIdentity =
      input.legacyWorkspaceIdentity?.trim() || existing?.legacyWorkspaceIdentity?.trim();
    const next: SourceServerWorkspaceHistoryEntry = {
      workspacePath: input.workspacePath,
      workspaceIdentity: input.workspaceIdentity,
      // Bug 原因：stable identity 重连不会再次携带 route hint；整行覆盖会抹掉冻结的
      // legacy identity，下一次启动无法投影 stable key，也读不到 Profile 密码。
      ...(legacyWorkspaceIdentity ? { legacyWorkspaceIdentity } : {}),
      profileId: input.profileId,
      sourceServerId: input.sourceServerId,
      lastOpenedAt: input.openedAt ?? context.now(),
    };
    if (index >= 0) history[index] = next;
    else history.push(next);
    // 同一 JS turn 内从最后一次 abort 检查直接发起持久化，不再引入 await 窗口；取消
    // 若发生在前一段异步读取期间，会在这里阻止任何 workspace history 写入。
    input.signal?.throwIfAborted();
    await context.persistSettings({
      sourceServerWorkspaceHistory: history,
    });
  });
}

export async function recordConversationWorkspace(
  context: SourceServerDirectoryContext,
  sourceServerId: string,
  workspacePath: string,
): Promise<void> {
  const normalizedPath = workspacePath.trim();
  if (!sourceServerId.trim() || !normalizedPath) {
    throw new Error("Source conversation workspace requires sourceServerId and workspacePath");
  }
  await context.initialize();
  await context.enqueue(async () => {
    const settings = await context.options.settingService.get();
    const current = settings.remoteConversationWorkspaceBySourceServerId ?? {};
    // Bug 原因：旧流程可能先把 backing path 当普通 project 写入 strict history。
    // canonical conversation 一旦确认，必须在同一 Directory 写事务中清掉同 Source/path
    // 的污染项；其它设备的同路径与同设备真实项目都保留。
    const projectHistory = (settings.sourceServerWorkspaceHistory ?? []).filter(
      (entry) => entry.sourceServerId !== sourceServerId || entry.workspacePath !== normalizedPath,
    );
    await context.persistSettings({
      remoteConversationWorkspaceBySourceServerId: {
        ...current,
        [sourceServerId]: {
          workspacePath: normalizedPath,
          lastResolvedAt: context.now(),
        },
      },
      sourceServerWorkspaceHistory: projectHistory,
    });
  });
}
