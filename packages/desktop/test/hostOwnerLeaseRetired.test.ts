import { EventEmitter } from "node:events";
import { access, readFile } from "node:fs/promises";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { HostMessageTypes, HostResponseTypes } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import { TaskRealtimeBus } from "../src/main/taskRealtimeBus.js";

/**
 * R09 守卫：Host 侧不再声明 owner/lease/mirror 注入点。
 * 决策与证据见 docs/specs/2026-11-11-owner-lease-mirror-decision.md。
 * 如果以后确实要恢复镜像路径，必须同时提供 owner-command 消费者和手机 relay 的
 * 路由/去重验证，并替换本测试，而不是只把 port 传回来。
 */
class FakeHostProcess extends EventEmitter {
  readonly postedMessages: unknown[] = [];

  postMessage(message: unknown): void {
    this.postedMessages.push(message);
  }

  emitMessage(message: unknown): void {
    this.emit("message", message);
  }
}

function asUtilityProcess(process: FakeHostProcess): ElectronUtilityProcess {
  return process as unknown as ElectronUtilityProcess;
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

// Host 入口拆分后，装配与 remote task service 包装分属不同模块；守卫覆盖全部归属文件。
const hostSourcePaths = [
  "../src/host/index.ts",
  "../src/host/hostTaskReporting.ts",
  "../src/host/hostLocalInit.ts",
].map((relative) => new URL(relative, import.meta.url));
const retiredBridgePath = new URL("../src/host/taskRealtimeBridge.ts", import.meta.url);
const retiredPortPath = new URL(
  "../../services/src/session/sessionRealtimePort.ts",
  import.meta.url,
);

describe("R09 owner/lease mirror retirement", () => {
  it("Host 不声明、不创建也不注入 owner/lease mirror port", async () => {
    const source = (await Promise.all(hostSourcePaths.map((path) => readFile(path, "utf8")))).join(
      "\n",
    );

    expect(source).not.toMatch(/\btaskRealtimePort\b/);
    expect(source).not.toMatch(/\bactiveSessionRealtimePort\b/);
    expect(source).not.toMatch(/\bcreateTaskRealtimeBridgeForHostInit\b/);
    expect(source).not.toMatch(/\bmirrorRemotePrompt\b/);
    expect(source).not.toMatch(/\bacquireTaskRunLease\b/);
    expect(source).not.toMatch(/\bpublishStreamOp\b/);

    // 生产装配只有 reportRunningPromptCount: false，没有可通过传参重新开启镜像的选项。
    expect(source).toContain("reportRunningPromptCount: false");
    expect(source).toMatch(
      /createReportingRemoteZCodeTaskService\([\s\S]*?\{\s*reportRunningPromptCount: false,\s*\}/,
    );
  });

  it("已删除无生产消费者的 bridge 与 SessionRealtimePort 声明", async () => {
    await expect(access(retiredBridgePath)).rejects.toThrow();
    await expect(access(retiredPortPath)).rejects.toThrow();
  });

  it("保留的 continuous 路径仍按 session route 跨 Host 投递", () => {
    const hostA = new FakeHostProcess();
    const hostB = new FakeHostProcess();
    const bus = new TaskRealtimeBus({ logger: makeLogger() });

    bus.registerHost({
      hostId: "host-a",
      windowId: 1,
      child: asUtilityProcess(hostA),
      workspaceKeys: ["/repo/demo"],
    });
    bus.registerHost({
      hostId: "host-b",
      windowId: 2,
      child: asUtilityProcess(hostB),
      workspaceKeys: ["/repo/demo"],
    });

    // Host 在 rememberTaskMeta 时发布 SessionRouteAnnounce（host/index.ts）。
    hostB.emitMessage({
      type: HostResponseTypes.SessionRouteAnnounce,
      route: { sessionId: "session-target" },
    });
    hostB.postedMessages.length = 0;

    const request = {
      content: "继续",
      createdAt: "2026-11-12T00:00:00.000Z",
      fromSessionId: "session-source",
      messageId: "msg-1",
      requestId: "req-1",
      toSessionId: "session-target",
    };
    hostA.emitMessage({
      type: HostResponseTypes.SessionMessageSendRequested,
      request,
    });

    expect(hostB.postedMessages).toEqual([
      { type: HostMessageTypes.SessionMessageDeliver, request },
    ]);

    hostB.emitMessage({
      type: HostResponseTypes.SessionMessageDeliverResult,
      result: {
        messageId: "msg-1",
        requestId: "req-1",
        sessionId: "session-source",
        status: "success",
      },
    });
    expect(hostA.postedMessages.at(-1)).toEqual({
      type: HostMessageTypes.SessionMessageDeliveryResult,
      result: {
        messageId: "msg-1",
        requestId: "req-1",
        sessionId: "session-source",
        status: "success",
      },
    });
  });
});
