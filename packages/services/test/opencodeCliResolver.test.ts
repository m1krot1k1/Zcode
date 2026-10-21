import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPosixOpenCodeCandidates } from "../src/opencode-acp-runtime/adapters/cliResolver.js";

describe("OpenCode POSIX CLI candidates", () => {
  it("discovers both per-user and shared Linuxbrew installs", () => {
    const candidates = getPosixOpenCodeCandidates({
      pathValue: "",
      homeDirectory: "/home/alice",
    });

    expect(candidates).toContain(join("/home/alice", ".linuxbrew", "bin", "opencode"));
    expect(candidates).toContain("/home/linuxbrew/.linuxbrew/bin/opencode");
  });
});
