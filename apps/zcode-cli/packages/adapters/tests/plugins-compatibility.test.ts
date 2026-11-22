import { describe, expect, it } from "vitest";
import type { PluginManifest } from "@zcode/contracts";
import {
  assertPluginAppVersionCompatible,
  PluginCompatibilityError,
  resolvePluginAppVersionConstraints,
} from "../src/plugins/marketplace.js";

describe("plugin app version compatibility", () => {
  it("treats missing declarations as unconstrained for existing catalogs", () => {
    expect(resolvePluginAppVersionConstraints({ name: "legacy" })).toEqual([]);
    expect(() =>
      assertPluginAppVersionCompatible({
        appVersion: "0.17.0",
        manifest: { name: "legacy" },
        pluginId: "legacy@market",
      }),
    ).not.toThrow();
  });

  it("accepts minAppVersion at or below the running kernel", () => {
    for (const minAppVersion of ["0.17.0", "0.16.9"]) {
      expect(() =>
        assertPluginAppVersionCompatible({
          appVersion: "0.17.0",
          manifest: { minAppVersion, name: "plugin" },
          pluginId: "plugin@market",
        }),
      ).not.toThrow();
    }
  });

  it("rejects minAppVersion above the running kernel with a stable diagnostic code", () => {
    try {
      assertPluginAppVersionCompatible({
        appVersion: "0.17.0",
        manifest: { minAppVersion: "0.18.0", name: "plugin" },
        pluginId: "plugin@market",
      });
      throw new Error("expected compatibility rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginCompatibilityError);
      expect((error as PluginCompatibilityError).diagnosticCode).toBe(
        "plugin_incompatible_app_version",
      );
      expect((error as Error).message).toContain("0.18.0");
      expect((error as Error).message).toContain("0.17.0");
    }
  });

  it("supports semver ranges in engines.zcode and string shorthand", () => {
    const cases = [
      { engines: { zcode: ">=0.17.0 <1.0.0" }, ok: true },
      { engines: { zcode: "^0.17.0" }, ok: true },
      { engines: { zcode: ">=0.18.0" }, ok: false },
      { engines: "~0.17.0", ok: true },
      { engines: "^1.0.0", ok: false },
    ] as const;
    for (const testCase of cases) {
      const run = () =>
        assertPluginAppVersionCompatible({
          appVersion: "0.17.4",
          manifest: { engines: testCase.engines, name: "plugin" },
          pluginId: "plugin@market",
        });
      if (testCase.ok) expect(run).not.toThrow();
      else expect(run).toThrow(PluginCompatibilityError);
    }
  });

  it("fails closed on malformed declarations or kernel versions", () => {
    for (const manifest of [
      { minAppVersion: "latest", name: "plugin" },
      { engines: { zcode: "not a range" }, name: "plugin" },
      { engines: { zcode: 3 }, name: "plugin" },
      { engines: 7, name: "plugin" },
    ] as unknown as PluginManifest[]) {
      expect(() =>
        assertPluginAppVersionCompatible({
          appVersion: "0.17.0",
          manifest,
          pluginId: "plugin@market",
        }),
      ).toThrow(PluginCompatibilityError);
    }
    expect(() =>
      assertPluginAppVersionCompatible({
        appVersion: "not-a-version",
        manifest: { minAppVersion: "0.1.0", name: "plugin" },
        pluginId: "plugin@market",
      }),
    ).toThrow(PluginCompatibilityError);
  });
});
