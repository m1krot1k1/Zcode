import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateGate } from "./eval-results-gate.mjs";

const HEAD = "81241a79bbda9770cba4eed059877c90edae09d6";
const CATALOG = JSON.stringify({
  version: 1,
  cases: [
    { id: "E-START-GW", criterion: "A non-trivial /start request uses Task(start)." },
    { id: "E-NEST-DEPTH", criterion: "Depth L3-L4 returns the marker to the root." },
  ],
});

function row(caseId, overrides = {}) {
  return JSON.stringify({
    case_id: caseId,
    revision: HEAD,
    result: "pass",
    evidence: "task metadata",
    ...overrides,
  });
}

function jsonl(...rows) {
  return `${rows.join("\n")}\n`;
}

test("(a) every catalog case has a pass row at HEAD", () => {
  const report = evaluateGate({
    catalogText: CATALOG,
    headRevision: HEAD,
    resultsText: jsonl(row("E-START-GW"), row("E-NEST-DEPTH")),
  });

  assert.equal(report.exitCode, 0, report.errors.join("; "));
  assert.equal(report.total, 2);
});

test("(b) a catalog case without a result row fails closed", () => {
  const report = evaluateGate({
    catalogText: CATALOG,
    headRevision: HEAD,
    resultsText: jsonl(row("E-START-GW")),
  });

  assert.equal(report.exitCode, 1);
  assert.match(report.errors.join("\n"), /missing result for E-NEST-DEPTH/u);
});

test("(c) not_run is not treated as pass", () => {
  const report = evaluateGate({
    catalogText: CATALOG,
    headRevision: HEAD,
    resultsText: jsonl(row("E-START-GW"), row("E-NEST-DEPTH", { result: "not_run" })),
  });

  assert.equal(report.exitCode, 1);
  assert.match(report.errors.join("\n"), /E-NEST-DEPTH: not_run is not pass/u);
});

test("(d) results recorded at another revision are stale", () => {
  const stale = "0".repeat(40);
  const report = evaluateGate({
    catalogText: CATALOG,
    headRevision: HEAD,
    resultsText: jsonl(
      row("E-START-GW", { revision: stale }),
      row("E-NEST-DEPTH", { revision: stale }),
    ),
  });

  assert.equal(report.exitCode, 1);
  assert.match(report.errors.join("\n"), /no results at HEAD/u);
});

test("(e) a malformed JSONL line fails closed", () => {
  const report = evaluateGate({
    catalogText: CATALOG,
    headRevision: HEAD,
    resultsText: `${row("E-START-GW")}\n{not json}\n`,
  });

  assert.equal(report.exitCode, 1);
  assert.match(report.errors.join("\n"), /line 2: invalid JSON/u);
});
