import { describe, expect, it, vi } from "vitest";
import type { ISourceServerManagementService } from "@zcode/services";
import englishMessages from "@/i18n/locales/en-US.js";
import {
  getSourceServerForceUpdateDescription,
  runSourceServerUpdate,
} from "@/lib/sourceServerUpdateAction.js";

const profileId = "17ef20b3-622d-4a53-98c1-0cdff29f3e6d";
const snapshot = { generation: 1 } as never;

describe("runSourceServerUpdate", () => {
  it("必须先普通更新，不把版本不兼容等价为强制中断", async () => {
    const updateSource = vi.fn(async () => snapshot);
    const confirmForce = vi.fn(async () => true);

    await runSourceServerUpdate({
      management: { updateSource } as unknown as ISourceServerManagementService,
      profileId,
      confirmForce,
    });

    expect(updateSource).toHaveBeenCalledOnce();
    expect(updateSource).toHaveBeenCalledWith({ profileId, force: false });
    expect(confirmForce).not.toHaveBeenCalled();
  });

  it("只在运行中 Task guard 后二次确认并强制重试", async () => {
    const guard = Object.assign(new Error("running tasks"), {
      code: "source-server-update-running-tasks",
    });
    const updateSource = vi.fn().mockRejectedValueOnce(guard).mockResolvedValueOnce(snapshot);
    const confirmForce = vi.fn(async () => true);

    await runSourceServerUpdate({
      management: { updateSource } as unknown as ISourceServerManagementService,
      profileId,
      confirmForce,
    });

    expect(confirmForce).toHaveBeenCalledOnce();
    expect(updateSource.mock.calls).toEqual([
      [{ profileId, force: false }],
      [{ profileId, force: true }],
    ]);
  });

  it("用户取消强制更新时不发送 force=true", async () => {
    const updateSource = vi.fn(async () => {
      throw Object.assign(new Error("running tasks"), {
        code: "source-server-update-running-tasks",
      });
    });

    await expect(
      runSourceServerUpdate({
        management: { updateSource } as unknown as ISourceServerManagementService,
        profileId,
        confirmForce: async () => false,
      }),
    ).resolves.toBeNull();
    expect(updateSource).toHaveBeenCalledOnce();
  });

  it("普通错误不进入 force 确认，也不会自动重试", async () => {
    const failure = new Error("network down");
    const updateSource = vi.fn(async () => {
      throw failure;
    });
    const confirmForce = vi.fn(async () => true);

    await expect(
      runSourceServerUpdate({
        management: { updateSource } as unknown as ISourceServerManagementService,
        profileId,
        confirmForce,
      }),
    ).rejects.toBe(failure);
    expect(updateSource).toHaveBeenCalledOnce();
    expect(confirmForce).not.toHaveBeenCalled();
  });

  it("用户确认后 force 请求失败时不再产生第三次请求", async () => {
    const guard = Object.assign(new Error("running tasks"), {
      code: "source-server-update-running-tasks",
    });
    const forcedFailure = new Error("restart failed");
    const updateSource = vi.fn().mockRejectedValueOnce(guard).mockRejectedValueOnce(forcedFailure);
    const confirmForce = vi.fn(async () => true);

    await expect(
      runSourceServerUpdate({
        management: { updateSource } as unknown as ISourceServerManagementService,
        profileId,
        confirmForce,
      }),
    ).rejects.toBe(forcedFailure);
    expect(updateSource).toHaveBeenCalledTimes(2);
    expect(confirmForce).toHaveBeenCalledOnce();
  });
});

describe("getSourceServerForceUpdateDescription", () => {
  const formatMessage = (id: string) => englishMessages[id] ?? id;
  const managementWithTasks = (runningTasks: unknown[]) =>
    ({
      getSnapshot: async () => ({
        states: [{ profileId, runningTasks }],
      }),
    }) as unknown as ISourceServerManagementService;

  it("lists interrupted tasks and the ZCode-service restart with automatic reconnect", async () => {
    const description = await getSourceServerForceUpdateDescription(
      managementWithTasks([{ sessionId: "running-session", workspacePath: "/work/alpha" }]),
      profileId,
      formatMessage,
    );

    expect(description).toContain(englishMessages["settings.source.forceUpdateDescription"]!);
    expect(description).toContain("running-session — /work/alpha");
    expect(description).toContain("interrupts tasks");
    expect(description).toContain("only the ZCode service");
    expect(description).toContain("reconnects automatically");
  });

  it("uses the unavailable-task warning when the device cannot report tasks", async () => {
    const description = await getSourceServerForceUpdateDescription(
      managementWithTasks([]),
      profileId,
      formatMessage,
    );

    expect(description).toContain(englishMessages["settings.source.forceUpdateDescription"]!);
    expect(description).toContain(englishMessages["remote.runningTasksUnavailable"]!);
    expect(description).toContain("interrupts running tasks");
    expect(description).toContain("reconnects automatically");
  });
});

it("force 确认后继续携带原 expectedTarget", async () => {
  const expectedTarget = { kind: "wsl", distro: "Ubuntu", user: "dev" } as const;
  const updateSource = vi
    .fn()
    .mockRejectedValueOnce(
      Object.assign(new Error("running"), { code: "source-server-update-running-tasks" }),
    )
    .mockResolvedValue(snapshot);
  await runSourceServerUpdate({
    management: { updateSource } as unknown as ISourceServerManagementService,
    profileId,
    expectedTarget,
    confirmForce: async () => true,
  });
  expect(updateSource.mock.calls).toEqual([
    [{ profileId, expectedTarget, force: false }],
    [{ profileId, expectedTarget, force: true }],
  ]);
});
