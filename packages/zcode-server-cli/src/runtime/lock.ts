import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

type ProcessIdentity = {
  startId?: string;
  commandLine?: string;
  zombie: boolean;
};

function readProcessIdentity(pid: number): ProcessIdentity | undefined {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // comm может содержать пробелы и скобки, поэтому поля ищем после последней ')'.
      const fieldsStart = stat.lastIndexOf(")");
      if (fieldsStart < 0) return undefined;
      const fields = stat.slice(fieldsStart + 2).split(" ");
      const state = fields[0];
      const startId = fields[19];
      if (state === "Z" || state === "X") return { zombie: true };
      const commandLine = readFileSync(`/proc/${pid}/cmdline`, "utf8")
        .split("\0")
        .filter((part) => part.length > 0)
        .join(" ");
      return { startId: startId || undefined, commandLine, zombie: false };
    } catch {
      return undefined;
    }
  }
  if (process.platform === "darwin") {
    try {
      const startId = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        timeout: 1_000,
      }).trim();
      const commandLine = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf8",
        timeout: 1_000,
      }).trim();
      return { startId: startId || undefined, commandLine, zombie: false };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function looksLikeZcodeServer(commandLine: string | undefined): boolean {
  return commandLine === undefined || /zcode|server-(?:cli|core)/i.test(commandLine);
}

export type DataRootLockInspection =
  | { state: "missing" }
  | { state: "active"; pid: number }
  | { state: "stale"; pid: number }
  | { state: "invalid" }
  | { state: "unreadable"; error: unknown };

export class DataRootLock {
  private handle: FileHandle | undefined;
  private ownerToken: string | undefined;
  public constructor(private readonly path: string) {}

  public async inspect(): Promise<DataRootLockInspection> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { state: "missing" };
      }
      return { state: "unreadable", error };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { state: "invalid" };
    }
    const pid =
      typeof parsed === "object" &&
      parsed !== null &&
      "pid" in parsed &&
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0
        ? parsed.pid
        : undefined;
    if (pid === undefined) return { state: "invalid" };
    const processStartId =
      typeof parsed === "object" &&
      parsed !== null &&
      "processStartId" in parsed &&
      typeof parsed.processStartId === "string"
        ? parsed.processStartId
        : undefined;
    return this.isHolderAlive(pid, processStartId)
      ? { state: "active", pid }
      : { state: "stale", pid };
  }

  public async acquire(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    if (await this.tryAcquireOnce()) return;
    const recoveryPath = `${this.path}.recovery`;
    for (let attempt = 0; attempt < 100; attempt++) {
      const observed = await this.readOwner(this.path);
      if (observed && this.isHolderAlive(observed.record.pid, observed.record.processStartId)) {
        throw new Error("Another ZCode Server instance is already running");
      }
      const recoveryToken = await this.tryAcquireRecoveryGate(recoveryPath);
      if (!recoveryToken) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        continue;
      }
      try {
        const current = await this.readOwner(this.path);
        if (current && this.isHolderAlive(current.record.pid, current.record.processStartId)) {
          throw new Error("Another ZCode Server instance is already running");
        }
        if (current) {
          await this.claimStalePath(this.path, current.raw);
        }
        if (await this.tryAcquireOnce()) return;
      } finally {
        await this.releaseOwnedPath(recoveryPath, recoveryToken);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Another ZCode Server instance is already running");
  }

  public async release(): Promise<void> {
    await this.handle?.close().catch(() => undefined);
    this.handle = undefined;
    const token = this.ownerToken;
    this.ownerToken = undefined;
    if (token) await this.releaseOwnedPath(this.path, token);
  }

  private async tryAcquireOnce(): Promise<boolean> {
    const ownerToken = randomUUID();
    let handle: FileHandle | undefined;
    try {
      handle = await open(this.path, "wx", 0o600);
      const processStartId = readProcessIdentity(process.pid)?.startId;
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, processStartId, acquiredAt: Date.now(), ownerToken })}\n`,
      );
      this.handle = handle;
      this.ownerToken = ownerToken;
      return true;
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
      await handle?.close().catch(() => undefined);
      const observed = await this.readOwner(this.path);
      if (observed?.record.ownerToken === ownerToken) {
        await this.releaseOwnedPath(this.path, ownerToken);
      }
      throw error;
    }
  }

  private async readOwner(path: string): Promise<{
    raw: string;
    record: { ownerToken?: string; pid?: number; processStartId?: string };
  } | null> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as {
        ownerToken?: unknown;
        pid?: unknown;
        processStartId?: unknown;
      };
      return {
        raw,
        record: {
          ownerToken: typeof parsed.ownerToken === "string" ? parsed.ownerToken : undefined,
          pid:
            typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0
              ? parsed.pid
              : undefined,
          processStartId:
            typeof parsed.processStartId === "string" ? parsed.processStartId : undefined,
        },
      };
    } catch {
      return { raw, record: {} };
    }
  }

  public isHolderAlive(pid: number | undefined, processStartId?: string): boolean {
    if (pid === undefined) return false;
    if (pid === process.pid) {
      if (processStartId === undefined) return true;
      const currentStartId = readProcessIdentity(pid)?.startId;
      return currentStartId === undefined || currentStartId === processStartId;
    }
    try {
      process.kill(pid, 0);
    } catch (error: unknown) {
      // ESRCH 表示进程不存在（stale）；EPERM 表示进程存在但无权限，保守视为存活。
      if (!(error instanceof Error && "code" in error && error.code === "EPERM")) return false;
    }
    const identity = readProcessIdentity(pid);
    if (identity?.zombie) return false;
    // PID мог быть переиспользован другим процессом. Для новых lock сравниваем
    // время старта, для legacy-lock без identity — хотя бы командную строку.
    if (processStartId !== undefined && identity?.startId !== undefined) {
      return identity.startId === processStartId;
    }
    return looksLikeZcodeServer(identity?.commandLine);
  }

  private async tryAcquireRecoveryGate(path: string): Promise<string | null> {
    const ownerToken = randomUUID();
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), ownerToken })}\n`,
      );
      await handle.close();
      return ownerToken;
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        await handle?.close().catch(() => undefined);
        const observed = await this.readOwner(path);
        if (observed?.record.ownerToken === ownerToken) {
          await this.releaseOwnedPath(path, ownerToken);
        }
        throw error;
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
    const observed = await this.readOwner(path);
    if (!observed || !this.isHolderAlive(observed.record.pid, observed.record.processStartId)) {
      if (observed) await this.claimStalePath(path, observed.raw);
      return null;
    }
    return null;
  }

  private async claimStalePath(path: string, expectedRaw: string): Promise<void> {
    const quarantine = `${path}.stale-${process.pid}-${randomUUID()}`;
    try {
      await rename(path, quarantine);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    const claimedRaw = await readFile(quarantine, "utf8").catch(() => null);
    if (claimedRaw === expectedRaw) {
      await rm(quarantine, { force: true });
      return;
    }
    // 陈旧观察误 claim 了后来者时必须恢复，不能删除新 owner 的 lock。
    await rename(quarantine, path).catch(() => undefined);
  }

  private async releaseOwnedPath(path: string, ownerToken: string): Promise<void> {
    const observed = await this.readOwner(path);
    if (observed?.record.ownerToken !== ownerToken) return;
    const quarantine = `${path}.release-${process.pid}-${randomUUID()}`;
    try {
      await rename(path, quarantine);
    } catch {
      return;
    }
    const claimed = await this.readOwner(quarantine);
    if (claimed?.record.ownerToken === ownerToken) {
      await rm(quarantine, { force: true });
      return;
    }
    await rename(quarantine, path).catch(() => undefined);
  }
}
