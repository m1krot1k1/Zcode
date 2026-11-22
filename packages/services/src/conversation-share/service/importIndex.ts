import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";

import type { ImportConversationShareResult } from "../conversationShare.js";

import { importDedupeKey, workspaceKeyOf } from "./keys.js";

/**
 * 导入结果索引的唯一 owner：内存表 + 串行落盘。
 *
 * 链条原来不 catch，首个写入失败后 chain 永久 rejected，之后每次 persist 都变成静默
 * no-op。现在存起来的链条始终 resolved，只用于串行化；`persist` 的返回值仍可观测，
 * 让调用方自己决定是否吞掉本次失败。
 */
export class ConversationShareImportIndex {
  private readonly completedImports = new Map<
    string,
    ImportConversationShareResult
  >();
  private readonly completedImportsByWorkspace = new Map<
    string,
    ImportConversationShareResult
  >();
  private readonly inFlightImports = new Map<
    string,
    Promise<ImportConversationShareResult>
  >();
  private readonly inFlightImportsByWorkspace = new Map<
    string,
    Promise<ImportConversationShareResult>
  >();
  private writeChain: Promise<void> = Promise.resolve();

  /** 索引读取完成信号；导入入口先 await 它再查重。 */
  readonly ready: Promise<void>;

  constructor(private readonly indexPath: string) {
    this.ready = this.load();
  }

  find(
    shareCode: string,
    workspaceKey: string,
    clientRequestId: string,
  ): ImportConversationShareResult | undefined {
    const workspaceKeyedShare = importDedupeKey(shareCode, workspaceKey);
    return (
      this.completedImports.get(
        `${workspaceKeyedShare}\u0000${clientRequestId}`,
      ) ?? this.completedImportsByWorkspace.get(workspaceKeyedShare)
    );
  }

  record(
    shareCode: string,
    workspaceKey: string,
    clientRequestId: string,
    result: ImportConversationShareResult,
  ): Promise<void> {
    const workspaceKeyedShare = importDedupeKey(shareCode, workspaceKey);
    this.completedImports.set(
      `${workspaceKeyedShare}\u0000${clientRequestId}`,
      result,
    );
    this.completedImportsByWorkspace.set(workspaceKeyedShare, result);
    return this.persist();
  }

  /** 同一 share+workspace 或同一 clientRequestId 的导入合并到同一个进行中 Promise。 */
  findInFlight(
    shareCode: string,
    workspaceKey: string,
    clientRequestId: string,
  ): Promise<ImportConversationShareResult> | undefined {
    const workspaceKeyedShare = importDedupeKey(shareCode, workspaceKey);
    return (
      this.inFlightImports.get(
        `${workspaceKeyedShare}\u0000${clientRequestId}`,
      ) ?? this.inFlightImportsByWorkspace.get(workspaceKeyedShare)
    );
  }

  trackInFlight(
    shareCode: string,
    workspaceKey: string,
    clientRequestId: string,
    promise: Promise<ImportConversationShareResult>,
  ): void {
    const workspaceKeyedShare = importDedupeKey(shareCode, workspaceKey);
    const key = `${workspaceKeyedShare}\u0000${clientRequestId}`;
    this.inFlightImports.set(key, promise);
    this.inFlightImportsByWorkspace.set(workspaceKeyedShare, promise);
    const cleanup = () => {
      this.inFlightImports.delete(key);
      if (
        this.inFlightImportsByWorkspace.get(workspaceKeyedShare) === promise
      ) {
        this.inFlightImportsByWorkspace.delete(workspaceKeyedShare);
      }
    };
    void promise.then(cleanup, cleanup);
  }

  persist(): Promise<void> {
    const run = this.writeChain
      .catch(() => undefined)
      .then(() => this.writeOnce());
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.indexPath, "utf8"));
    } catch {
      return;
    }
    if (!raw || typeof raw !== "object") return;
    for (const [key, value] of Object.entries(raw)) {
      if (!value || typeof value !== "object") continue;
      const record = value as Partial<ImportConversationShareResult>;
      if (
        typeof record.workspacePath !== "string" ||
        typeof record.sessionId !== "string" ||
        typeof record.title !== "string" ||
        typeof record.contextId !== "string" ||
        typeof record.shareUrl !== "string"
      ) {
        continue;
      }
      try {
        if (!(await stat(record.workspacePath)).isDirectory()) continue;
      } catch {
        continue;
      }
      const keyParts = key.split("\u0000");
      const shareCode = keyParts[0]!;
      const workspaceKey =
        keyParts[1] ??
        workspaceKeyOf(record.workspacePath, record.workspaceIdentity);
      const workspaceKeyedShare = importDedupeKey(shareCode, workspaceKey);
      const result: ImportConversationShareResult = {
        workspacePath: record.workspacePath,
        ...(record.workspaceIdentity
          ? { workspaceIdentity: record.workspaceIdentity }
          : {}),
        sessionId: record.sessionId,
        contextId: record.contextId,
        shareUrl: record.shareUrl,
        title: record.title,
        reused: true,
      };
      this.completedImports.set(key, result);
      this.completedImportsByWorkspace.set(workspaceKeyedShare, result);
    }
  }

  private async writeOnce(): Promise<void> {
    const data = Object.fromEntries(this.completedImports.entries());
    const temporaryPath = `${this.indexPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(data), "utf8");
      await rename(temporaryPath, this.indexPath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}
