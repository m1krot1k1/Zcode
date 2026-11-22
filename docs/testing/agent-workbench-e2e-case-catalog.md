# Agent Workbench E2E case catalog

## Scope

The desktop workspace side pane exposes a dashboard that combines the existing subagent profile service with the local code-index service. This case covers the real launcher route and rendered read model without making a model/provider request or starting a code scan.

## Accepted case

### AWB-E2E-001 — Open the workspace dashboard from the new-tab launcher

- Setup: desktop app with a draft workspace and Side Pane available; provider execution is disabled.
- Action: expand Side Pane, open the new-tab launcher, choose Agent Workbench.
- Assertions: the active tab is workspace-keyed Agent Workbench; the role roster, capacity projection, active-task branch area, and local code-index sections render; the index reports one of the explicit states (`unindexed`, `indexing`, `ready`, `degraded`).
- Boundaries: this case verifies UI wiring and status projection only. SQLite/indexing/search behavior is covered by the code-intelligence service tests; model-backed execution is out of scope.
- Spec: `packages/desktop/test/e2e/ui-shell/agent-workbench.test.ts`.
