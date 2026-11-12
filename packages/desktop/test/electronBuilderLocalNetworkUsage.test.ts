import { describe, expect, it } from "vitest";
import desktopBuilderConfig from "../electron-builder.config.js";

describe("macOS Local Network usage declaration", () => {
  const extendInfo = desktopBuilderConfig.mac?.extendInfo as Record<string, unknown> | undefined;

  it("declares a non-empty NSLocalNetworkUsageDescription while keeping existing usage keys", () => {
    // ssh2 目标通常是局域网/私有网段地址；缺少该 key 时 macOS 不会发起本地网络授权。
    // 这里只固定打包声明，真实授权与连通性仍需打包后由用户在系统设置中确认。
    expect(typeof extendInfo?.NSLocalNetworkUsageDescription).toBe("string");
    expect(String(extendInfo?.NSLocalNetworkUsageDescription).length).toBeGreaterThan(0);
    expect(extendInfo?.NSAppleEventsUsageDescription).toEqual(expect.any(String));
    expect(extendInfo?.NSBluetoothAlwaysUsageDescription).toEqual(expect.any(String));
  });

  it("does not declare Bonjour services while no Bonjour discovery exists", () => {
    // NSBonjourServices 只在声明具体的 Bonjour 服务类型时才需要；当前没有 mDNS 浏览/广播，
    // 加上会暗示一个不存在的发现能力。
    expect(extendInfo?.NSBonjourServices).toBeUndefined();
  });
});
