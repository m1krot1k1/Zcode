import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Emitter, type Event } from "@zcode/rpc";
import { getDataBaseDir, migrateControllerRemoteWorkspaceIdentity } from "@zcode/services/node";
import { repairDanglingProfileCredentials } from "./credentials.js";
import { migrateLegacyRemoteEntries } from "./migration.js";
import type { SourceServerDirectoryContext, SourceServerDirectoryOptions } from "./types.js";

interface SourceServerDirectoryRuntime {
  context: SourceServerDirectoryContext;
  onDidChange: Event<void>;
}

/**
 * 构造目录运行上下文：串行写队列、初始化 flight 与变更事件都由这里单独持有。
 * 子模块通过 context 复用同一份状态，不复制任何持久化标记。
 */
export function createSourceServerDirectoryRuntime(
  options: SourceServerDirectoryOptions,
): SourceServerDirectoryRuntime {
  const changeEmitter = new Emitter<void>();
  let initializePromise: Promise<void> | null = null;
  let writeChain = Promise.resolve();
  /** 当前 enqueue 操作内是否发生过成功的持久化写入；enqueue 串行执行，变量无并发窗口。 */
  let didPersistInCurrentOperation = false;

  const enqueue = async <T>(operation: () => Promise<T>): Promise<T> => {
    // Bug 原因：过去 enqueue 完成后无条件 fire onDidChange，未写入的操作（已迁移短路、
    // identity-pending 零写入分支、目标不存在的 no-op）也会驱动全部消费方权威重读快照。
    // 事件语义收敛为「确有持久化写入成功才通知」；写入统一走 persistSettings 打标。
    const run = async (): Promise<{ value: T; didPersist: boolean }> => {
      didPersistInCurrentOperation = false;
      const value = await operation();
      return { value, didPersist: didPersistInCurrentOperation };
    };
    const result = writeChain.then(run, run);
    writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    const { value, didPersist } = await result;
    if (didPersist) changeEmitter.fire();
    return value;
  };

  const context: SourceServerDirectoryContext = {
    options,
    createProfileId: options.createProfileId ?? randomUUID,
    now: options.now ?? Date.now,
    migrateControllerIdentity:
      options.migrateControllerIdentity ??
      (async (input) =>
        await migrateControllerRemoteWorkspaceIdentity({
          dbPath: join(getDataBaseDir(), ".zcode", "v2", "tasks-index.sqlite"),
          ...input,
        })),
    enqueue,
    /** 目录持久化写入的唯一入口：写入成功即标记本次 enqueue 操作需要发布变更事件。 */
    async persistSettings(patch): Promise<void> {
      await options.settingService.update(patch);
      didPersistInCurrentOperation = true;
    },
    async initialize(): Promise<void> {
      if (!initializePromise) {
        const flight = enqueue(async () => {
          let settings = await options.settingService.get();
          if (settings.sourceServerDirectoryMigrationVersion !== 1) {
            await migrateLegacyRemoteEntries(context, settings);
            settings = await options.settingService.get();
          }
          await repairDanglingProfileCredentials(context, settings);
        });
        initializePromise = flight;
      }
      const flight = initializePromise;
      try {
        await flight;
      } catch (error) {
        // Bug 原因：失败 flight 若永久缓存，临时 settings/credential IO 故障会让本 Host
        // 生命周期内所有 Source Server 操作持续复用同一个 rejected promise。
        if (initializePromise === flight) initializePromise = null;
        throw error;
      }
    },
  };

  return { context, onDidChange: changeEmitter.event };
}
