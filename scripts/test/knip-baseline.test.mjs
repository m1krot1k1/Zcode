import assert from "node:assert/strict";
import test from "node:test";
import { collectIssueKeys, compareIssueKeys } from "../knip-baseline.mjs";

test("flattens knip JSON issues into stable keys", () => {
  const keys = collectIssueKeys({
    issues: [
      {
        file: "src/a.ts",
        exports: [{ name: "unusedA" }],
        files: [{ name: "src/a.ts" }],
        dependencies: [{ name: "left-pad" }],
        types: [],
      },
      {
        file: "src/b.ts",
        exports: [],
        types: [{ name: "UnusedType" }],
      },
    ],
  });

  assert.deepEqual(keys, [
    "dependencies\tsrc/a.ts\tleft-pad",
    "exports\tsrc/a.ts\tunusedA",
    "files\tsrc/a.ts\tsrc/a.ts",
    "types\tsrc/b.ts\tUnusedType",
  ]);
});

test("fails only on new issues and reports resolved ones", () => {
  const result = compareIssueKeys(
    ["exports\tsrc/a.ts\tstillUnused", "files\tsrc/new.ts\tsrc/new.ts"],
    ["exports\tsrc/a.ts\tstillUnused", "exports\tsrc/b.ts\tfixed"],
  );

  assert.deepEqual(result.newIssues, ["files\tsrc/new.ts\tsrc/new.ts"]);
  assert.deepEqual(result.resolvedIssues, ["exports\tsrc/b.ts\tfixed"]);
});

test("ignores malformed entries and unknown types", () => {
  const keys = collectIssueKeys({
    issues: [
      null,
      { file: 42, exports: [{ name: "ignored" }] },
      { file: "src/a.ts", unknownType: [{ name: "ignored" }], exports: [{ name: "kept" }] },
    ],
  });

  assert.deepEqual(keys, ["exports\tsrc/a.ts\tkept"]);
});
