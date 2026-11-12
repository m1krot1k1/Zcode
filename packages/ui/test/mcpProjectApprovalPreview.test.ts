import { describe, expect, it } from "vitest";
import { buildMcpProjectApprovalPreview } from "../src/settings/mcpProjectApprovalPreview.js";

describe("project MCP approval preview", () => {
  it("shows stdio command/args but masks environment values", () => {
    const preview = buildMcpProjectApprovalPreview({
      type: "stdio",
      command: "node",
      args: ["server.js", "--workspace", "/repo"],
      env: { PROJECT_TOKEN: "sk-live-secret", LOG_LEVEL: "debug" },
    });

    expect(preview.commandLine).toBe("node server.js --workspace /repo");
    expect(preview.envEntries).toEqual(["LOG_LEVEL=••••", "PROJECT_TOKEN=••••"]);
    expect(JSON.stringify(preview)).not.toContain("sk-live-secret");
    expect(JSON.stringify(preview)).not.toContain("debug");
  });

  it("strips URL query strings and masks header values", () => {
    const preview = buildMcpProjectApprovalPreview({
      type: "http",
      url: "https://mcp.example.test/mcp?token=sk-live-secret#fragment",
      headers: { Authorization: "Bearer sk-live-secret" },
    });

    expect(preview.url).toBe("https://mcp.example.test/mcp");
    expect(preview.headerEntries).toEqual(["Authorization=••••"]);
    expect(JSON.stringify(preview)).not.toContain("sk-live-secret");
  });
});
