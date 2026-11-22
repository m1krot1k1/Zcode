import { describe, expect, it } from "vitest";
import { sanitizeProxyRouteForDisplay } from "../src/settingsPageHelpers.js";

describe("sanitizeProxyRouteForDisplay", () => {
  it("shows scheme and host while hiding credentials and URL extras", () => {
    expect(
      sanitizeProxyRouteForDisplay("socks5://user:secret@proxy.example:1080?token=hidden#fragment"),
    ).toBe("socks5://proxy.example:1080");
  });

  it("does not expose credentials from a legacy credential-bearing route", () => {
    expect(sanitizeProxyRouteForDisplay("http://user:secret@proxy.example:1080")).toBe(
      "http://proxy.example:1080",
    );
  });

  it("returns undefined for direct routing", () => {
    expect(sanitizeProxyRouteForDisplay("  ")).toBeUndefined();
  });
});
