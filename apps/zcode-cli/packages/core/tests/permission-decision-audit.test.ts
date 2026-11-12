import { SESSION_ENTRY_PERMISSION_DECISION } from "@zcode/contracts";
import { describe, expect, it } from "vitest";
import { buildPermissionDecisionEntry } from "../src/runtime/helpers/permission-decision-audit.js";

const base = {
  sessionId: "sess_audit" as never,
  toolCallId: "call_1",
  toolName: "Bash",
  traceId: "trace_1",
  createdAt: 1_700_000_000_000,
};

describe("permission decision audit entry", () => {
  it("records allow/modify/deny with bounded fields and no command text", () => {
    const allow = buildPermissionDecisionEntry({ ...base, allowed: true });
    expect(allow.type).toBe(SESSION_ENTRY_PERMISSION_DECISION);
    expect(allow.data).toMatchObject({
      schema: "zcode.permission.decision.v1",
      decision: "allow",
      toolName: "Bash",
      createdAt: 1_700_000_000_000,
    });
    expect(JSON.stringify(allow)).not.toContain("rm -rf");

    const modify = buildPermissionDecisionEntry({
      ...base,
      allowed: true,
      modified: true,
      reason: "policy.modified",
      ruleId: "rule_1",
    });
    expect(modify.data).toMatchObject({ decision: "modify", reasonCode: "policy.modified" });

    const deny = buildPermissionDecisionEntry({
      ...base,
      allowed: false,
      reason: "User denied: rm -rf / --secret-token",
    });
    expect(deny.data).toMatchObject({ decision: "deny", reasonCode: "unspecified" });
    expect(JSON.stringify(deny)).not.toContain("secret-token");
  });

  it("truncates untrusted identifiers and keeps a stable id", () => {
    const entry = buildPermissionDecisionEntry({
      ...base,
      toolName: "X".repeat(500),
      allowed: false,
      decisionId: "fixed-id",
    });
    expect(entry.id).toBe("fixed-id");
    expect(String((entry.data as Record<string, unknown>).toolName)).toHaveLength(120);
  });
});
