import { describe, expect, it } from "vitest";
import { classifyRemoteConnectionError } from "@/lib/remoteConnectionPresentation.js";
import enUS from "@/i18n/locales/en-US.js";
import ruRU from "@/i18n/locales/ru-RU.json" with { type: "json" };
import zhCN from "@/i18n/locales/zh-CN.js";

const LOCALES = [
  ["en-US", enUS],
  ["zh-CN", zhCN],
  ["ru-RU", ruRU],
] as const;

describe("host-unreachable copy stops asserting an unproven cause", () => {
  it.each(LOCALES)(
    "%s names route, VPN, firewall and macOS Local Network",
    (_locale, messages) => {
      const text = messages["remote.error.hostUnreachable.reason"] ?? "";

      expect(text.length).toBeGreaterThan(0);
      expect(text).toMatch(/VPN/u);
      // macOS 本地网络授权是本次唯一新增的产品侧提示，三种语言都必须可读。
      expect(text).toMatch(/Local Network|本地网络|Локальная сеть/u);
      expect(text).toMatch(/firewall|防火墙|брандмауэр/iu);
    },
  );

  it.each(LOCALES)("%s no longer claims the device is running", (_locale, messages) => {
    const text = messages["remote.error.hostUnreachable.reason"] ?? "";

    // 原文案把“设备已启动”当事实；EHOSTUNREACH 只说明本机没有可达路径（见 spec F4）。
    expect(text).not.toMatch(
      /make sure it is running|确认设备已启动|убедитесь, что оно включено/u,
    );
  });

  it.each(LOCALES)("%s provides the refused-port reason key", (_locale, messages) => {
    expect(messages["remote.error.hostUnreachable.refused.reason"]?.trim()).toBeTruthy();
  });
});

describe("classifyRemoteConnectionError keeps the public code and refines the reason", () => {
  it("uses the no-route reason for EHOSTUNREACH without changing the category", () => {
    const presentation = classifyRemoteConnectionError({
      errorCode: "remote-host-unreachable",
      error: "connect EHOSTUNREACH 172.16.99.50:22 - Local (172.16.99.4:51903)",
    });

    expect(presentation.category).toBe("remote-host-unreachable");
    expect(presentation.titleId).toBe("remote.error.hostUnreachable");
    expect(presentation.reasonId).toBe("remote.error.hostUnreachable.reason");
    expect(presentation.primaryAction).toBe("retry");
  });

  it("uses the refused-port reason for ECONNREFUSED without claiming a missing route", () => {
    const presentation = classifyRemoteConnectionError({
      errorCode: "remote-host-unreachable",
      error: "connect ECONNREFUSED 192.168.1.10:22",
    });

    expect(presentation.category).toBe("remote-host-unreachable");
    expect(presentation.titleId).toBe("remote.error.hostUnreachable");
    expect(presentation.reasonId).toBe("remote.error.hostUnreachable.refused.reason");
    expect(presentation.primaryAction).toBe("retry");
  });

  it("keeps the generic reason for ECONNRESET instead of guessing a cause", () => {
    const presentation = classifyRemoteConnectionError({
      errorCode: "remote-host-unreachable",
      error: "read ECONNRESET",
    });

    expect(presentation.reasonId).toBe("remote.error.hostUnreachable.reason");
  });

  it.each([
    [{ kind: "wsl", distro: "Ubuntu" }, "remote.error.hostUnreachable.wsl.reason"],
    [{ kind: "docker", container: "app" }, "remote.error.hostUnreachable.docker.reason"],
  ] as const)("keeps the %j variant reason", (target, reasonId) => {
    const presentation = classifyRemoteConnectionError({
      errorCode: "remote-host-unreachable",
      error: "connect ECONNREFUSED 10.0.0.2:22",
      target,
    });

    expect(presentation.reasonId).toBe(reasonId);
  });

  it("falls back to the generic reason when no raw message is available", () => {
    const presentation = classifyRemoteConnectionError({
      errorCode: "remote-host-unreachable",
    });

    expect(presentation.reasonId).toBe("remote.error.hostUnreachable.reason");
  });
});
