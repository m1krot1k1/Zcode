# Agent Workbench E2E coverage matrix

| Case ID     | Surface           | Provider request | Workspace identity | Roster  | Index status           | Search/index actions | Spec                               |
| ----------- | ----------------- | ---------------- | ------------------ | ------- | ---------------------- | -------------------- | ---------------------------------- |
| AWB-E2E-001 | Desktop Side Pane | none             | current workspace  | renders | renders explicit state | not invoked          | `ui-shell/agent-workbench.test.ts` |

Service tests cover workspace identity isolation, ignore/secret filtering, incremental writes, lexical/semantic ranking, graph queries, failed-generation preservation, and workspace-local deletion.
