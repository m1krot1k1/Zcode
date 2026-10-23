import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyDesktopProcessPath,
  ensureLoginShellPath,
  extractMarkedPath,
  mergePaths,
  prependPathDirectory,
} from "../src/main/loginShellPath.js";

describe("login shell PATH", () => {
  it("keeps shell entries ahead of directories already injected", () => {
    expect(mergePaths(`/opt/homebrew/bin${delimiter}/usr/bin`, `/usr/bin${delimiter}/tmp/fixture`)).toBe(
      `/opt/homebrew/bin${delimiter}/usr/bin${delimiter}/tmp/fixture`,
    );
  });

  it("reads PATH between markers and ignores profile noise", () => {
    expect(extractMarkedPath("noise\n__ZCODE_LOGIN_PATH_START__/usr/bin__ZCODE_LOGIN_PATH_END__\n")).toBe(
      "/usr/bin",
    );
  });

  it("does not merge a login shell on Windows or when the skip flag is set", async () => {
    const env = { PATH: "/bin", ZCODE_SKIP_LOGIN_SHELL_PATH: "1" };
    await expect(ensureLoginShellPath({ platform: "win32", env })).resolves.toEqual({
      status: "skipped",
      reason: "windows",
    });
    await expect(ensureLoginShellPath({ platform: "darwin", env })).resolves.toEqual({
      status: "skipped",
      reason: "ZCODE_SKIP_LOGIN_SHELL_PATH",
    });
    expect(env.PATH).toBe("/bin");
  });

  it("puts the E2E OpenCode fixture directory first and skips the login shell", async () => {
    const env = { PATH: `/opt/homebrew/bin${delimiter}/usr/bin`, ZCODE_E2E_OPENCODE_CLI_PATH: "/tmp/e2e/opencode" };
    await expect(applyDesktopProcessPath(env)).resolves.toEqual({
      status: "skipped",
      reason: "e2e-opencode-cli",
    });
    expect(env.PATH?.split(delimiter)[0]).toBe("/tmp/e2e");
  });

  it("prepends a directory once", () => {
    const env: NodeJS.ProcessEnv = { PATH: `/usr/bin${delimiter}/tmp/e2e` };
    prependPathDirectory(env, "/tmp/e2e");
    expect(env.PATH).toBe(`/tmp/e2e${delimiter}/usr/bin`);
  });
});
