import type { RuntimeSubagentConfiguration } from "./contract.js";
export const exampleSubagentConfiguration: RuntimeSubagentConfiguration = {
  documents: [
    {
      path: "/project/.zcode/agents/review.md",
      source: "project",
      namespace: "tools",
      content: "---\nname: review\ndescription: Review\n---\nReview the code",
    },
    {
      path: "/project/.zcode/agents/researcher.md",
      source: "project",
      format: "cursor",
      content: "---\nname: researcher\ndescription: Research\n---\nResearch the workspace",
    },
  ],
  state: {
    disabledAgentIds: [],
    builtInModelSelectionOverrides: {},
    pluginAgentModelSelectionOverrides: {},
  },
};
