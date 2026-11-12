import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IGenUiService } from "./contract.js";
import { createGenUiService } from "./adapters/service.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("Gen UI service boundary", () => {
  it("keeps the RPC channel id consumed by host and renderer descriptors", () => {
    // 架构策略把 gen-ui-service 声明为 managed 模块；channel 名是与调用端唯一的运行时约定。
    expect(IGenUiService.channelName).toBe("gen-ui");
  });

  it("scopes widget state by workspace identity and session instead of executor path", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "gen-ui-contract-"));
    roots.push(stateRoot);
    const service = createGenUiService({ stateRoot, outputRoot: stateRoot });
    try {
      const base = {
        workspacePath: "/project",
        sessionId: "session",
        path: "/project/demo.html",
      };

      expect(await service.getState(base)).toBeNull();
      await service.setState({
        target: base,
        state: { modelContent: { month: 6 }, privateContent: null },
      });

      // CONTRACT.md：状态按 workspace identity + session 隔离，不按 executor 路径共享。
      expect(await service.getState({ ...base, sessionId: "other" })).toBeNull();
      expect(
        await service.getState({ ...base, workspaceIdentity: "ssh://example.test/project" }),
      ).toBeNull();
      expect(await service.getState(base)).toEqual({
        modelContent: { month: 6 },
        privateContent: null,
      });
    } finally {
      service.dispose();
    }
  });
});
