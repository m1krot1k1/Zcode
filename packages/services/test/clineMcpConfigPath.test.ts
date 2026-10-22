import { describe, expect, it } from "vitest";
import { resolveClineMcpConfigPath } from "../src/settings-sync/settingsSyncService.js";

describe("resolveClineMcpConfigPath", () => {
  it("prefers explicit Cline overrides before editor discovery", () => {
    const homeDir = "/profile";
    const editorProfile =
      "/profile/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json";
    const exists = (path: string) => path === editorProfile;

    expect(
      resolveClineMcpConfigPath({
        env: {
          CLINE_MCP_SETTINGS_PATH: "/explicit/profile.json",
          CLINE_DATA_DIR: "/data-dir",
          CLINE_DIR: "/cline-dir",
        },
        homeDir,
        platform: "darwin",
        exists,
      }),
    ).toBe("/explicit/profile.json");
    expect(
      resolveClineMcpConfigPath({
        env: { CLINE_DATA_DIR: "/data-dir", CLINE_DIR: "/cline-dir" },
        homeDir,
        platform: "darwin",
        exists,
      }),
    ).toBe("/data-dir/settings/cline_mcp_settings.json");
    expect(
      resolveClineMcpConfigPath({
        env: { CLINE_DIR: "/cline-dir" },
        homeDir,
        platform: "darwin",
        exists,
      }),
    ).toBe("/cline-dir/data/settings/cline_mcp_settings.json");
  });

  it.each([
    {
      platform: "darwin" as const,
      env: {},
      homeDir: "/profile",
      expected:
        "/profile/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
    },
    {
      platform: "win32" as const,
      env: { APPDATA: "C:/Users/test/AppData/Roaming" },
      homeDir: "C:/Users/test",
      expected:
        "C:/Users/test/AppData/Roaming/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
    },
    {
      platform: "linux" as const,
      env: { XDG_CONFIG_HOME: "/profile/config" },
      homeDir: "/profile",
      expected:
        "/profile/config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
    },
  ])(
    "discovers the first existing editor profile on $platform",
    ({ platform, env, homeDir, expected }) => {
      expect(
        resolveClineMcpConfigPath({
          env,
          homeDir,
          platform,
          exists: (path) => path === expected,
        }),
      ).toBe(expected);
    },
  );

  it("uses the deterministic editor order and falls back to the Cline CLI path", () => {
    const homeDir = "/profile";
    const profile = (editor: string) =>
      `/profile/.config/${editor}/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`;
    const found = new Set([profile("Cursor"), profile("VSCodium")]);

    expect(
      resolveClineMcpConfigPath({
        env: {},
        homeDir,
        platform: "linux",
        exists: (path) => found.has(path),
      }),
    ).toBe(profile("Cursor"));
    expect(
      resolveClineMcpConfigPath({
        env: {},
        homeDir,
        platform: "linux",
        exists: () => false,
      }),
    ).toBe("/profile/.cline/data/settings/cline_mcp_settings.json");
  });

  it("uses platform-specific default roots when editor environment variables are absent", () => {
    expect(
      resolveClineMcpConfigPath({
        env: {},
        homeDir: "C:/Users/test",
        platform: "win32",
        exists: (path) => path.includes("AppData/Roaming/Code/"),
      }),
    ).toContain("AppData/Roaming/Code/");
    expect(
      resolveClineMcpConfigPath({
        env: {},
        homeDir: "/profile",
        platform: "linux",
        exists: (path) => path.includes("/.config/Code/"),
      }),
    ).toContain("/.config/Code/");
  });
});
