import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionId, createTraceId, createTurnId } from "@zcode/contracts";
import { createExploreSubagentPort } from "../src/subagent/runner.js";

describe("subagent output permissions", () => {
  it.skipIf(process.platform === "win32")(
    "repairs legacy world-readable artifact paths on rewrite",
    async () => {
      const outputRootDir = await mkdtemp(
        join(tmpdir(), "zcode-subagent-permissions-"),
      );
      const sessionId = createSessionId("parent_output_permissions");
      const turnId = createTurnId("turn_output_permissions");
      const agentId = "agent_output_permissions";
      const request = {
        agentType: "Explore" as const,
        description: "Output permissions",
        parentToolCallId: "call_output_permissions",
        prompt: "Report the output permissions.",
        sessionId,
        trace: {
          traceId: createTraceId(),
          sessionId,
          turnId,
        },
        turnId,
        workingDirectory: outputRootDir,
        workspaceRoot: outputRootDir,
      };
      const runPort = async () => {
        const port = createExploreSubagentPort({
          createAgentId: () => agentId,
          outputRootDir,
          async emitParentEvent() {},
          async runExploreAgent(agentRequest) {
            return {
              response: "artifact permissions",
              traceId: agentRequest.traceContext.traceId,
              events: [],
            };
          },
        });
        await port.run(request);
      };

      await runPort();

      const agentOutputDir = join(outputRootDir, sessionId, agentId);
      const artifactFiles = [
        join(agentOutputDir, "output.txt"),
        join(agentOutputDir, "task.output"),
        join(agentOutputDir, "metadata.json"),
      ];
      // 模拟 a8959bd5 之前创建的产物：目录 0755、文件 0644 会被 create-only 的 mode 保留。
      await chmod(agentOutputDir, 0o755);
      for (const artifactFile of artifactFiles) {
        await chmod(artifactFile, 0o644);
      }

      await runPort();

      for (const artifactFile of artifactFiles) {
        expect((await stat(artifactFile)).mode & 0o777).toBe(0o600);
      }
      expect((await stat(agentOutputDir)).mode & 0o777).toBe(0o700);
    },
  );
});
