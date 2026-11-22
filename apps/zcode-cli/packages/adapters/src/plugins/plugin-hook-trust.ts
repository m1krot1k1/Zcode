import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { HookEventName, HookMatcherConfig } from "@zcode/contracts";
import { isOfficialMarketplaceId } from "@zcode/contracts";
import { writeFileAtomically } from "./atomic-directory.js";
import type { LoadedPlugin } from "./types.js";

/**
 * 第三方插件 Hook 的唯一信任 owner。
 *
 * 安全边界：信任记录只存 `pluginId + version + hook definition digest` 的 SHA-256，
 * 不保存 command/args/env 或任何凭据。读取失败、文件损坏和 schema 不匹配一律按
 * 「无信任记录」处理（fail closed），且不会把 store 故障升级为插件加载失败。
 */

export const PLUGIN_HOOK_TRUST_SCHEMA_VERSION = 1;
export const PLUGIN_HOOK_TRUST_DIGEST_VERSION = 1;
const SECURITY_DIRECTORY = "security";
const TRUST_STORE_FILE = "plugin-hook-trust-v1.json";
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 10;
const STALE_LOCK_MS = 30_000;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

/** discovery 解析阶段的 hook inspection 形状（与 plugins/index.ts 的 PluginHookInspection 同构）。 */
export interface PluginHookInspectionShape {
  details: Array<{ runnable: boolean }>;
  events: Partial<Record<HookEventName, HookMatcherConfig[]>>;
}

export interface PluginHookTrustRecord {
  decision: "trusted";
  definitionDigest: string;
  digestAlgorithm: "sha256";
  grantedAt: string;
  pluginId: string;
  version: string;
}

export interface PluginHookTrustStoreFile {
  records: PluginHookTrustRecord[];
  schemaVersion: typeof PLUGIN_HOOK_TRUST_SCHEMA_VERSION;
}

export type PluginHookTrustState =
  | { records: []; status: "missing" }
  | { records: PluginHookTrustRecord[]; status: "ok" }
  | { records: []; status: "corrupt" };

export interface PluginHookTrustEvaluation {
  /** 纯函数判定结果；true 仅表示存在精确匹配的持久记录或 first-party。 */
  runnable: boolean;
  reason:
    | "first_party"
    | "no_hook_definitions"
    | "trusted_exact_match"
    | "untrusted"
    | "trust_store_unavailable";
}

export function resolvePluginHookTrustStorePath(storageRoot: string): string {
  return join(resolve(storageRoot), SECURITY_DIRECTORY, TRUST_STORE_FILE);
}

/**
 * first-party 判定：official 源，或来自 official marketplace 的安装产物。
 * `inline`（含 workspace `plugins.dirs`）与第三方 marketplace cache 一律不属于 first-party。
 */
export function isFirstPartyPlugin(
  plugin: Pick<LoadedPlugin, "marketplace" | "source">,
): boolean {
  return plugin.source === "official" || isOfficialMarketplaceId(plugin.marketplace);
}

export function resolvePluginHookVersion(plugin: Pick<LoadedPlugin, "manifest">): string {
  const version = plugin.manifest.version;
  return typeof version === "string" && version.trim().length > 0 ? version : "0.0.0";
}

function hasHookDefinitions(
  events: Partial<Record<HookEventName, HookMatcherConfig[]>>,
): boolean {
  return Object.values(events).some((matchers) => (matchers?.length ?? 0) > 0);
}

/**
 * Canonical definition digest：只包含真实执行语义与稳定身份。
 * `enabled` 属于插件自带内容（不是用户配置开关），必须进入 digest：插件更新把休眠 Hook
 * 打开时也要重新信任。
 * 显式排除 `runnable`（评估结果）、`sourcePath`（机器相关）与 `statusMessage`（仅展示）。
 */
export function computePluginHookDefinitionDigest(input: {
  events: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  pluginId: string;
  version: string;
}): string {
  const events = Object.entries(input.events)
    .filter(([, matchers]) => (matchers?.length ?? 0) > 0)
    .map(([eventName, matchers]) => ({
      event: eventName,
      matchers: (matchers ?? []).map((matcher) => ({
        hooks: matcher.hooks.map((hook) =>
          hook.type === "process"
            ? {
                args: hook.args ?? null,
                command: hook.command,
                enabled: hook.enabled ?? null,
                timeoutMs: hook.timeoutMs ?? null,
                type: hook.type,
              }
            : {
                async: hook.async ?? null,
                command: hook.command,
                enabled: hook.enabled ?? null,
                shell: hook.shell ?? null,
                timeout: hook.timeout ?? null,
                timeoutMs: hook.timeoutMs ?? null,
                type: hook.type,
              },
        ),
        matcher: matcher.matcher ?? null,
      })),
    }));
  return createHash("sha256")
    .update(
      JSON.stringify({
        digestVersion: PLUGIN_HOOK_TRUST_DIGEST_VERSION,
        events,
        pluginId: input.pluginId,
        version: input.version,
      }),
      "utf8",
    )
    .digest("hex");
}

function findExactRecord(
  state: PluginHookTrustState,
  input: { definitionDigest: string; pluginId: string; version: string },
): PluginHookTrustRecord | undefined {
  if (state.status !== "ok") return undefined;
  return state.records.find(
    (record) =>
      record.pluginId === input.pluginId &&
      record.version === input.version &&
      record.definitionDigest === input.definitionDigest,
  );
}

export function evaluatePluginHookTrust(input: {
  events: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  firstParty: boolean;
  pluginId: string;
  state: PluginHookTrustState;
  version: string;
}): PluginHookTrustEvaluation {
  if (input.firstParty) return { reason: "first_party", runnable: true };
  if (!hasHookDefinitions(input.events)) {
    return { reason: "no_hook_definitions", runnable: true };
  }
  // corrupt 无法证明「没有记录」，单独归为 unavailable；missing 就是「确实未信任」。
  if (input.state.status === "corrupt") {
    return { reason: "trust_store_unavailable", runnable: false };
  }
  if (input.state.status === "missing") {
    return { reason: "untrusted", runnable: false };
  }
  const definitionDigest = computePluginHookDefinitionDigest({
    events: input.events,
    pluginId: input.pluginId,
    version: input.version,
  });
  const record = findExactRecord(input.state, {
    definitionDigest,
    pluginId: input.pluginId,
    version: input.version,
  });
  return record
    ? { reason: "trusted_exact_match", runnable: true }
    : { reason: "untrusted", runnable: false };
}

/**
 * discovery 的唯一 gate 入口：评估后同步 inspection 的 runnable 标记。
 * 未信任时清空可执行 matcher，但保留 details 供设置页只读展示；两者必须保持一致，
 * 避免 UI 显示「可运行」而实际被跳过。
 */
export function gatePluginHookInspection(input: {
  inspection: PluginHookInspectionShape;
  loaded: Pick<LoadedPlugin, "id" | "manifest" | "marketplace" | "source">;
  state: PluginHookTrustState;
}): PluginHookTrustEvaluation {
  const evaluation = evaluatePluginHookTrust({
    events: input.inspection.events,
    firstParty: isFirstPartyPlugin(input.loaded),
    pluginId: input.loaded.id,
    state: input.state,
    version: resolvePluginHookVersion(input.loaded),
  });
  for (const detail of input.inspection.details) {
    detail.runnable = evaluation.runnable;
  }
  if (!evaluation.runnable) {
    input.inspection.events = {};
  }
  return evaluation;
}

/** 只读一次 trust store；此函数是 discovery 的唯一读取入口。 */
export function loadPluginHookTrustState(storageRoot: string): PluginHookTrustState {
  let content: string;
  try {
    content = readFileSync(resolvePluginHookTrustStorePath(storageRoot), "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { records: [], status: "missing" };
    // 权限/IO 错误无法证明记录不存在；按 corrupt 返回，让上层 fail closed。
    return { records: [], status: "corrupt" };
  }
  const parsed = parseTrustStoreFile(content);
  return parsed ? { records: parsed.records, status: "ok" } : { records: [], status: "corrupt" };
}

export function listPluginHookTrustRecords(storageRoot: string): PluginHookTrustRecord[] {
  const state = loadPluginHookTrustState(storageRoot);
  return state.status === "ok" ? state.records : [];
}

export async function grantPluginHookTrust(input: {
  events: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  now?: () => number;
  pluginId: string;
  storageRoot: string;
  version: string;
}): Promise<PluginHookTrustRecord> {
  if (!hasHookDefinitions(input.events)) {
    throw new Error(`Plugin has no hook definitions to trust: ${input.pluginId}`);
  }
  const record: PluginHookTrustRecord = {
    decision: "trusted",
    definitionDigest: computePluginHookDefinitionDigest({
      events: input.events,
      pluginId: input.pluginId,
      version: input.version,
    }),
    digestAlgorithm: "sha256",
    grantedAt: new Date(input.now?.() ?? Date.now()).toISOString(),
    pluginId: input.pluginId,
    version: input.version,
  };
  await mutateTrustStore(input.storageRoot, (current) => [
    ...current.filter((entry) => entry.pluginId !== record.pluginId),
    record,
  ]);
  return record;
}

export async function revokePluginHookTrust(input: {
  pluginId: string;
  storageRoot: string;
}): Promise<void> {
  await mutateTrustStore(input.storageRoot, (current) =>
    current.filter((record) => record.pluginId !== input.pluginId),
  );
}

let mutationQueue: Promise<unknown> = Promise.resolve();

/** 唯一写入路径：进程内串行 + 跨进程锁 + 原子替换。 */
function mutateTrustStore(
  storageRoot: string,
  update: (current: PluginHookTrustRecord[]) => PluginHookTrustRecord[],
): Promise<void> {
  const operation = async (): Promise<void> => {
    const filePath = resolvePluginHookTrustStorePath(storageRoot);
    await ensureSecurityDirectory(dirname(filePath));
    await withTrustStoreLock(filePath, async () => {
      const current = readRecordsForMutation(filePath);
      const next: PluginHookTrustStoreFile = {
        records: update(current),
        schemaVersion: PLUGIN_HOOK_TRUST_SCHEMA_VERSION,
      };
      await writeFileAtomically(filePath, `${JSON.stringify(next, null, 2)}\n`);
      // 记录只含哈希与身份，0600 是最小权限加固；失败不改变已完成的写入语义。
      await chmod(filePath, 0o600).catch(() => undefined);
    });
  };
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function readRecordsForMutation(filePath: string): PluginHookTrustRecord[] {
  try {
    const parsed = parseTrustStoreFile(readFileSync(filePath, "utf8"));
    return parsed?.records ?? [];
  } catch {
    // 损坏/不可读时以空集合重建；不能让旧损坏内容继续阻止用户显式信任。
    return [];
  }
}

async function ensureSecurityDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
}

async function withTrustStoreLock<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let acquired: FileHandle | undefined;
  while (acquired === undefined) {
    let handle: FileHandle | undefined;
    try {
      handle = await open(lockPath, "wx", 0o600);
      // owner 元数据只用于崩溃后的 stale 回收；写失败时关闭并删除自己创建的锁。
      await handle.writeFile(`${JSON.stringify({ pid: process.pid })}\n`, "utf8");
      acquired = handle;
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
      }
      if (!isNodeError(error, "EEXIST")) throw error;
      await removeStaleLock(lockPath);
      // 不猜测活跃 owner：并发写入是短临界区，超时即失败，绝不绕过锁写入。
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring plugin hook trust store lock: ${lockPath}`);
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  const handle = acquired;
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

/**
 * 只回收「超龄且 owner 进程已死」的锁：崩溃遗留的锁不应永久阻断用户显式信任，
 * 也不能误删活跃 writer 的锁（活跃进程即使超龄也保留）。
 */
async function removeStaleLock(lockPath: string): Promise<void> {
  try {
    const lockStats = await stat(lockPath);
    if (Date.now() - lockStats.mtimeMs <= STALE_LOCK_MS) return;
    let ownerPid: number | undefined;
    try {
      const parsed = JSON.parse(await readFile(lockPath, "utf8")) as unknown;
      if (isRecord(parsed) && typeof parsed.pid === "number") ownerPid = parsed.pid;
    } catch {
      // 无有效 owner 元数据：可能正在写入，交给超时处理。
      return;
    }
    if (ownerPid === undefined || isProcessAlive(ownerPid)) return;
    await rm(lockPath, { force: true });
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 表示进程存在但无权限探测，保守视为存活。
    return isNodeError(error, "EPERM");
  }
}

function parseTrustStoreFile(content: string): PluginHookTrustStoreFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(content) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.schemaVersion !== PLUGIN_HOOK_TRUST_SCHEMA_VERSION) return null;
  if (!Array.isArray(raw.records)) return null;
  const records: PluginHookTrustRecord[] = [];
  for (const entry of raw.records) {
    const record = parseTrustRecord(entry);
    if (!record) return null;
    records.push(record);
  }
  return { records, schemaVersion: PLUGIN_HOOK_TRUST_SCHEMA_VERSION };
}

function parseTrustRecord(value: unknown): PluginHookTrustRecord | null {
  if (!isRecord(value)) return null;
  const { decision, definitionDigest, digestAlgorithm, grantedAt, pluginId, version } = value;
  if (decision !== "trusted" || digestAlgorithm !== "sha256") return null;
  if (typeof pluginId !== "string" || pluginId.length === 0) return null;
  if (typeof version !== "string" || version.length === 0) return null;
  if (typeof grantedAt !== "string" || !Number.isFinite(Date.parse(grantedAt))) return null;
  if (typeof definitionDigest !== "string" || !HASH_PATTERN.test(definitionDigest)) return null;
  return {
    decision: "trusted",
    definitionDigest,
    digestAlgorithm: "sha256",
    grantedAt,
    pluginId,
    version,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
