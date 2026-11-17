import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_APP_VERSION_FALLBACK,
  applyAppVersionBootstrap,
  isSemverShapedVersion,
  resolveDesktopAppVersion,
  type DesktopAppVersionTarget,
} from "../src/main/desktopAppVersionBootstrap.js";

function createTarget(version: string, isPackaged = false) {
  const setVersion = vi.fn();
  const target: DesktopAppVersionTarget = {
    isPackaged,
    getVersion: () => version,
    setVersion,
  };
  return { target, setVersion };
}

describe("desktopAppVersionBootstrap", () => {
  it("接受合法 semver 并拒绝未打包运行时返回的 0.0", () => {
    expect(isSemverShapedVersion("3.17.122")).toBe(true);
    expect(isSemverShapedVersion("3.17.122-beta.1")).toBe(true);
    expect(isSemverShapedVersion("3.17.122+build.7")).toBe(true);
    expect(isSemverShapedVersion("0.0")).toBe(false);
    expect(isSemverShapedVersion("")).toBe(false);
    expect(isSemverShapedVersion(undefined)).toBe(false);
  });

  it("优先使用环境变量，其次退回构建期版本", () => {
    expect(resolveDesktopAppVersion({ envVersion: "4.0.0", buildVersion: "3.17.122" })).toBe(
      "4.0.0",
    );
    expect(resolveDesktopAppVersion({ envVersion: "bogus", buildVersion: "3.17.122" })).toBe(
      "3.17.122",
    );
    expect(resolveDesktopAppVersion({ envVersion: undefined, buildVersion: undefined })).toBe(
      DESKTOP_APP_VERSION_FALLBACK,
    );
  });

  it("把版本写进未打包的 app，使 electron-updater 能解析 semver", () => {
    const { target, setVersion } = createTarget("0.0");
    expect(applyAppVersionBootstrap(target, { buildVersion: "3.17.122" })).toBe("3.17.122");
    expect(setVersion).toHaveBeenCalledWith("3.17.122");
  });

  it("打包态不覆盖安装包自带版本", () => {
    const { target, setVersion } = createTarget("3.17.122", true);
    expect(applyAppVersionBootstrap(target, { buildVersion: "9.9.9" })).toBeNull();
    expect(setVersion).not.toHaveBeenCalled();
  });

  it("已是目标版本时不重复 setVersion", () => {
    const { target, setVersion } = createTarget("3.17.122");
    applyAppVersionBootstrap(target, { buildVersion: "3.17.122" });
    expect(setVersion).not.toHaveBeenCalled();
  });
});
