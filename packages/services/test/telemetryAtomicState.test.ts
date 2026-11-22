import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDataBaseDir } from "../src/paths.js";

const fsMockState = vi.hoisted(() => ({
  renameFailures: [] as NodeJS.ErrnoException[],
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    rename: vi.fn(
      async (
        oldPath: Parameters<typeof actual.rename>[0],
        newPath: Parameters<typeof actual.rename>[1],
      ) => {
        const failure = fsMockState.renameFailures.shift();
        if (failure) {
          throw failure;
        }
        await actual.rename(oldPath, newPath);
      },
    ),
  };
});

import { createTelemetryCore, ensureTelemetryDeviceMid } from "../src/telemetry/telemetryCore.js";

function createFsError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("telemetry-state.json 原子写入 (QW12)", () => {
  const tempDirs: string[] = [];

  function createIsolatedHome(): { home: string; stateFile: string; stateDir: string } {
    const home = mkdtempSync(join(tmpdir(), "zcode-telemetry-atomic-"));
    tempDirs.push(home);
    setDataBaseDir(home);
    const stateDir = join(home, ".zcode", "v2");
    return { home, stateDir, stateFile: join(stateDir, "telemetry-state.json") };
  }

  function seedState(stateDir: string, stateFile: string, content: string, mode?: number): void {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(stateFile, content, "utf-8");
    if (mode !== undefined && process.platform !== "win32") {
      chmodSync(stateFile, mode);
    }
  }

  function listTempFiles(stateDir: string): string[] {
    try {
      return readdirSync(stateDir).filter((name) => name.endsWith(".tmp"));
    } catch {
      return [];
    }
  }

  beforeEach(() => {
    fsMockState.renameFailures.length = 0;
  });

  afterEach(() => {
    setDataBaseDir(null);
    vi.mocked(rename).mockClear();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("已有 state 缺失 deviceMid 时补写完整 JSON，并保留既有字段与文件权限", async () => {
    const { home, stateDir, stateFile } = createIsolatedHome();
    seedState(
      stateDir,
      stateFile,
      JSON.stringify({ lastDailyActiveDate: "2026-11-10", dailyActiveInFlight: null }),
      0o600,
    );

    const deviceMid = await ensureTelemetryDeviceMid({ homeDir: home });

    expect(deviceMid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const persisted = JSON.parse(readFileSync(stateFile, "utf-8")) as Record<string, unknown>;
    expect(persisted).toEqual({
      lastDailyActiveDate: "2026-11-10",
      dailyActiveInFlight: null,
      deviceMid,
    });
    if (process.platform !== "win32") {
      // rename 会让临时文件接管目标 mode；必须继承已收紧的 0600，而不是退回 0666。
      expect(statSync(stateFile).mode & 0o777).toBe(0o600);
    }
    expect(listTempFiles(stateDir)).toEqual([]);
  });

  it("rename 失败时拒绝写入，原 state 保持完整且不残留临时文件", async () => {
    const { home, stateDir, stateFile } = createIsolatedHome();
    const original = JSON.stringify({ lastDailyActiveDate: "2026-11-10" }, null, 2);
    seedState(stateDir, stateFile, original);
    fsMockState.renameFailures.push(createFsError("ENOENT"));

    await expect(ensureTelemetryDeviceMid({ homeDir: home })).rejects.toMatchObject({
      code: "ENOENT",
    });

    expect(readFileSync(stateFile, "utf-8")).toBe(original);
    expect(() => JSON.parse(readFileSync(stateFile, "utf-8"))).not.toThrow();
    expect(listTempFiles(stateDir)).toEqual([]);
  });

  it("瞬时 rename 占用（EACCES）被有界重试后仍然完成写入", async () => {
    const { home, stateDir, stateFile } = createIsolatedHome();
    fsMockState.renameFailures.push(createFsError("EACCES"));

    const deviceMid = await ensureTelemetryDeviceMid({ homeDir: home });

    expect(JSON.parse(readFileSync(stateFile, "utf-8"))).toEqual({ deviceMid });
    expect(listTempFiles(stateDir)).toEqual([]);
  });

  it("连续 daily-active 写入期间并发读取，所有观察值都是完整 JSON 且 deviceMid 唯一", async () => {
    const { home, stateDir, stateFile } = createIsolatedHome();
    // 预置带 deviceMid 的旧 state：读取方从第一次成功读取起就有确定值可比对，
    // 写入方随后跨日提交新状态时必须原样保留这个身份。
    seedState(stateDir, stateFile, JSON.stringify({ deviceMid: "seed-device-mid" }));
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(null, { status: 204 }));
    const context = {
      clientTimezone: "UTC",
      clientLanguage: "en-US",
      screenResolution: "1x1",
    };
    let keepReading = true;
    const observed: string[] = [];
    let readerError: unknown;
    const reader = (async () => {
      while (keepReading) {
        try {
          const raw = await readFile(stateFile, "utf-8");
          // 每次成功读取都必须能完整解析；原子 rename 不允许出现半截内容。
          const parsed = JSON.parse(raw) as { deviceMid?: unknown };
          if (typeof parsed.deviceMid !== "string") {
            throw new Error(`state 缺少 deviceMid: ${raw}`);
          }
          observed.push(parsed.deviceMid);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          // 读取与 rename 并发时，Windows 可能短暂返回 ENOENT/EBUSY/EACCES；这些是
          // 访问时序问题，不是“半截 JSON”，重试即可。JSON 解析失败仍会进入 readerError。
          if (code === "ENOENT" || code === "EBUSY" || code === "EACCES") {
            await pause(1);
            continue;
          }
          readerError = error;
          return;
        }
        await pause(1);
      }
    })();
    // 让读取方先完成至少一次读取，避免写入过快导致观察集合为空而误判。
    await pause(5);

    for (const day of [1, 2, 3, 4]) {
      const timestamp = Date.UTC(2026, 10, day, 10, 0, 0);
      const service = createTelemetryCore({
        fetchImpl: fetchMock,
        homeDir: home,
        now: () => timestamp,
      }) as {
        reportAppDailyActive(input: typeof context): Promise<void>;
      };
      await service.reportAppDailyActive(context);
    }
    keepReading = false;
    await reader;
    if (readerError) {
      throw readerError;
    }

    const finalState = JSON.parse(readFileSync(stateFile, "utf-8")) as { deviceMid?: string };
    expect(observed.length).toBeGreaterThan(0);
    expect(typeof finalState.deviceMid).toBe("string");
    expect(new Set(observed)).toEqual(new Set([finalState.deviceMid]));
    expect(listTempFiles(stateDir)).toEqual([]);
  });

  it("损坏的旧 state 仍按原行为重新生成 deviceMid 并写出合法 JSON", async () => {
    const { home, stateDir, stateFile } = createIsolatedHome();
    seedState(stateDir, stateFile, '{"deviceMid": "trunc');

    const deviceMid = await ensureTelemetryDeviceMid({ homeDir: home });

    expect(JSON.parse(readFileSync(stateFile, "utf-8"))).toEqual({ deviceMid });
    expect(listTempFiles(stateDir)).toEqual([]);
  });
});
