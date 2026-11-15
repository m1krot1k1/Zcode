import { describe, expect, it } from "vitest";
import {
  createBuiltInExploreAgentProfile,
  formatAgentProfileForPrompt,
  formatAgentProfilesForPrompt,
  getSwarmAgentProfiles,
  isModelSelectableAgentProfile,
  SWARM_AGENT_TYPES,
  isBuiltInExploreAgentProfile,
  normalizeAgentProfiles,
  parseAgentProfileFromMarkdown,
  REVIEW_SUBAGENT_TOOL_NAMES,
  ROOT_ONLY_TOOL_NAMES,
  WORKER_SUBAGENT_TOOL_NAMES,
  decideDelegationRoute,
  resolveSwarmParallelism,
  filterAgentTypesForCaller,
  isAgentTypeAllowedForCaller,
  matchAgentTypeInCatalog,
} from "../src/subagent/profile.js";

describe("subagent profile Markdown parser", () => {
  it.each(['{"providerId":"wrong","modelId":"wrong"}', "null", '{"modelId":"broken"}'])(
    "中间字段不参与正式 Markdown 读取：%s",
    (value) => {
      const result = parseAgentProfileFromMarkdown({
        source: "user",
        content: `---
name: reviewer
description: Review changes
modelSelection: ${value}
model: custom-openai/legacy
thoughtLevel: high
---
Review carefully.`,
      });
      expect(result.profile?.modelSelection).toEqual({
        providerId: "custom-openai",
        modelId: "legacy",
        options: { reasoningLevel: "high" },
      });
    },
  );

  it("parses only exact persistent memory scopes", () => {
    const exact = parseAgentProfileFromMarkdown({
      source: "project",
      content: `---
name: reviewer
description: Review changes
memory: project
---
Review carefully.`,
    });
    const padded = parseAgentProfileFromMarkdown({
      source: "project",
      content: `---
name: reviewer
description: Review changes
memory: " project "
---
Review carefully.`,
    });

    expect(exact.diagnostic).toBeUndefined();
    expect(exact.profile?.memory).toBe("project");
    expect(padded.diagnostic?.code).toBe("agent_invalid_memory_scope");
    expect(padded.profile).toMatchObject({ name: "reviewer", description: "Review changes" });
    expect(padded.profile?.memory).toBeUndefined();
  });

  it("preserves an explicitly empty tools list for persistent memory projection", () => {
    const result = parseAgentProfileFromMarkdown({
      source: "project",
      content: `---
name: reviewer
description: Review changes
memory: project
tools: []
---
Review carefully.`,
    });

    expect(result.profile?.tools).toEqual([]);
  });

  it("parses the P0 custom agent fields consumed by zcode-cli", () => {
    const result = parseAgentProfileFromMarkdown({
      source: "project",
      path: "/workspace/.zcode/agents/zcode-reviewer.md",
      content: `---
name: zcode-reviewer
description: 检查实现边界\\n输出中文结论
model: custom-openai/reviewer-model
thoughtLevel: high
tools: Read, Grep Bash(ls -la)
disallowedTools:
  - Edit
  - Write
skills: code review
color: cyan
permissionMode: acceptEdits
maxTurns: "7"
background: "true"
injectAgentsMd: "false"
includeInSwarm: true
mcpServers:
  - local-tools
---
你是 zcode-reviewer。
只输出中文。`,
    });

    expect(result.diagnostic).toBeUndefined();
    expect(result.profile).toMatchObject({
      background: true,
      color: "cyan",
      description: "检查实现边界\n输出中文结论",
      disallowedTools: ["Edit", "Write"],
      maxTurns: 7,
      injectAgentsMd: false,
      includeInSwarm: true,
      modelSelection: {
        providerId: "custom-openai",
        modelId: "reviewer-model",
        options: { reasoningLevel: "high" },
      },
      name: "zcode-reviewer",
      path: "/workspace/.zcode/agents/zcode-reviewer.md",
      skills: ["code", "review"],
      source: "project",
      systemPrompt: "你是 zcode-reviewer。\n只输出中文。",
      tools: ["Read", "Grep", "Bash"],
    });
    expect(result.profile?.mcpServers).toEqual(["local-tools"]);
    expect(result.profile?.permissionMode).toBeUndefined();
  });

  it("preserves concrete provider and custom model values from frontmatter", () => {
    const providerModel = parseAgentProfileFromMarkdown({
      source: "user",
      path: "/home/user/.zcode/agents/reviewer.md",
      content: `---
name: reviewer
description: Use a concrete provider model
model: custom-openai/gpt-5.4
thoughtLevel: high
---
Review carefully.`,
    });
    const customModel = parseAgentProfileFromMarkdown({
      source: "user",
      path: "/home/user/.zcode/agents/reviewer-custom.md",
      content: `---
name: reviewer-custom
description: Use the UI custom model value
model: custom:custom-openai:gpt-5.4
---
Review carefully.`,
    });

    expect(providerModel.profile?.modelSelection).toEqual({
      providerId: "custom-openai",
      modelId: "gpt-5.4",
      options: { reasoningLevel: "high" },
    });
    expect(customModel.profile?.modelSelection).toEqual({
      providerId: "custom-openai",
      modelId: "gpt-5.4",
    });
  });

  it("accepts only server-name lists for mcpServers", () => {
    const invalidFrontmatterValues = [
      "mcpServers: local-tools",
      `mcpServers:
  local-tools:
    type: stdio`,
      "mcpServers: { local-tools: { type: stdio } }",
      "mcpServers: [{ type: stdio, command: local-mcp }]",
      "mcpServers: [local-tools, 42]",
      "mcpServers: [local-tools,, analytics]",
      "mcpServers: [null]",
      "mcpServers: [-1, 1.5]",
      "mcpServers: [[alpha, beta]]",
      "mcpServers:",
    ];

    for (const mcpServers of invalidFrontmatterValues) {
      const result = parseAgentProfileFromMarkdown({
        source: "user",
        content: `---
name: reviewer
description: Review code
${mcpServers}
---
Review carefully.`,
      });

      expect(result.profile).toBeUndefined();
      expect(result.diagnostic?.code).toBe("agent_invalid_mcp_servers");
    }
  });

  it("accepts an explicit empty mcpServers list and trims server names", () => {
    const empty = parseAgentProfileFromMarkdown({
      source: "user",
      content: `---
name: empty-scope
description: Use the parent MCP snapshot
mcpServers: []
---`,
    });
    const scoped = parseAgentProfileFromMarkdown({
      source: "project",
      content: `---
name: scoped
description: Use selected parent MCP servers
mcpServers: [" local-tools ", analytics, "plugin:tools:", "[alpha]"]
---`,
    });

    expect(empty.diagnostic).toBeUndefined();
    expect(empty.profile?.mcpServers).toEqual([]);
    expect(scoped.diagnostic).toBeUndefined();
    expect(scoped.profile?.mcpServers).toEqual([
      "local-tools",
      "analytics",
      "plugin:tools:",
      "[alpha]",
    ]);
  });

  it("keeps invalid nested syntax from reviving a non-MCP list", () => {
    const result = parseAgentProfileFromMarkdown({
      source: "user",
      content: `---
name: reviewer
description: Review code
tools:
  invalid: nested
  - Read
---`,
    });

    expect(result.diagnostic).toBeUndefined();
    expect(result.profile?.tools).toBeUndefined();
  });

  it("formats only named built-in roles for model-facing Agent tool descriptions", () => {
    const prompt = formatAgentProfilesForPrompt([
      {
        name: "zcode-reviewer",
        description: "检查实现边界。",
        source: "project",
        systemPrompt: "只输出中文。",
        tools: ["Read"],
        background: true,
      },
    ]);

    expect(prompt).toContain("Available agent types and the tools they have access to:");
    expect(prompt).not.toContain("general-purpose");
    expect(prompt).not.toContain("Explore");
    for (const role of SWARM_AGENT_TYPES) expect(prompt).toContain(`- ${role}:`);
    expect(prompt).toContain("- zcode-reviewer: 检查实现边界。 (Tools: Read)");
    expect(prompt).toContain("- reviewer:");
    expect(prompt).toContain(
      "(Tools: CodeIndex, Read, Glob, Grep, Bash, WebFetch, WebSearch, Task, Skill, SkillSearch",
    );
    expect(prompt).toContain("(Tools: CodeIndex, Read, Glob, Grep, Write, Edit, Bash");
    expect(prompt).not.toContain("tools: Read");
    expect(prompt).not.toContain("background: true");
    expect(prompt).not.toContain("model:");
  });

  it("assigns explicit identity colors to built-in agents", () => {
    expect(createBuiltInExploreAgentProfile().color).toBe("cyan");
  });

  it("adds only opted-in custom profiles with bounded tools to the swarm roster", () => {
    const profiles = normalizeAgentProfiles([
      {
        name: "custom-debugger",
        description: "Debug a focused issue",
        source: "project",
        systemPrompt: "Inspect evidence, reproduce the issue, and report the root cause.",
        tools: ["Read", "Grep", "Bash"],
        skills: ["zcode-verification"],
        includeInSwarm: true,
      },
      {
        name: "unbounded-debugger",
        description: "Inherits every tool",
        source: "project",
        systemPrompt: "Unbounded",
        tools: ["*"],
        includeInSwarm: true,
      },
      {
        name: "same-name-debugger",
        description: "No explicit tool contract",
        source: "project",
        systemPrompt: "Unbounded by omission",
        includeInSwarm: true,
      },
      {
        name: "not-enabled-debugger",
        description: "Not enabled for Swarm",
        source: "project",
        systemPrompt: "Regular profile only",
        tools: ["Read"],
      },
      {
        name: "REVIEWER",
        description: "Cannot shadow a built-in role",
        source: "project",
        systemPrompt: "Shadow attempt",
        tools: ["Read"],
        includeInSwarm: true,
      },
    ]);

    const swarmProfiles = getSwarmAgentProfiles(profiles);

    expect(swarmProfiles.map(({ name }) => name)).toContain("custom-debugger");
    expect(swarmProfiles.map(({ name }) => name)).not.toContain("unbounded-debugger");
    expect(swarmProfiles.map(({ name }) => name)).not.toContain("same-name-debugger");
    expect(swarmProfiles.map(({ name }) => name)).not.toContain("not-enabled-debugger");
    expect(swarmProfiles.filter(({ name }) => name.toLowerCase() === "reviewer")).toHaveLength(1);
    expect(swarmProfiles.find(({ name }) => name === "custom-debugger")).toMatchObject({
      tools: ["Read", "Grep", "Bash"],
      skills: ["zcode-verification"],
      includeInSwarm: true,
    });
  });

  it("limits delegation to ZCode roles and rejects generic profile IDs", () => {
    const profiles = normalizeAgentProfiles([]);
    const swarmProfiles = getSwarmAgentProfiles(profiles);

    expect(swarmProfiles.map(({ name }) => name)).toEqual(SWARM_AGENT_TYPES);
    const customProfiles = [
      { ...createBuiltInExploreAgentProfile(), source: "user" as const },
      {
        name: "research-helper",
        description: "Workspace research role",
        source: "project" as const,
        systemPrompt: "Research role prompt",
        tools: ["Read"],
      },
      {
        name: "general",
        description: "Generic workspace role",
        source: "project" as const,
        systemPrompt: "Must not enter the ZCode roster",
        tools: ["Read"],
      },
      {
        name: "general-purpose",
        description: "Legacy generic role",
        source: "project" as const,
        systemPrompt: "Must not enter the ZCode roster",
        tools: ["Read"],
      },
      {
        name: "reviewer",
        description: "Workspace attempt to shadow the canonical role",
        source: "project" as const,
        systemPrompt: "Untrusted replacement prompt",
        tools: ["Read"],
      },
    ];
    const mergedProfiles = normalizeAgentProfiles(customProfiles);
    const swarmWithCustomProfiles = getSwarmAgentProfiles(mergedProfiles);
    expect(swarmWithCustomProfiles.map(({ name }) => name)).toEqual(SWARM_AGENT_TYPES);
    expect(swarmWithCustomProfiles.find(({ name }) => name === "reviewer")).toMatchObject({
      source: "built-in",
      description: expect.not.stringContaining("Workspace attempt"),
      tools: expect.arrayContaining(["Read", "Glob", "Grep", "Bash"]),
    });
    expect(swarmWithCustomProfiles.find(({ name }) => name === "reviewer")?.tools).toContain(
      "Task",
    );
    const normalAgentPrompt = formatAgentProfilesForPrompt(mergedProfiles) ?? "";
    expect(normalAgentPrompt).toContain("- research-helper: Workspace research role");
    expect(normalAgentPrompt).not.toContain("general-purpose");
    expect(normalAgentPrompt).not.toContain("- general:");
    // built-in владеет своим именем: custom reviewer не подменяет системную роль.
    expect(normalAgentPrompt).not.toContain("Workspace attempt to shadow the canonical role");
    expect(normalAgentPrompt).toContain(
      "- reviewer: Независимо ищет ошибки, пропущенные случаи и нарушения спецификации; не меняет код.",
    );
    const forgedBuiltInReviewer = {
      name: "reviewer",
      description: "Forged built-in profile",
      source: "built-in" as const,
      systemPrompt: "Forged system prompt",
      tools: ["Read", "Task", "Write"],
    };
    expect(
      getSwarmAgentProfiles([...mergedProfiles, forgedBuiltInReviewer]).find(
        ({ name }) => name === "reviewer",
      ),
    ).toEqual(swarmProfiles.find(({ name }) => name === "reviewer"));
    expect(swarmProfiles.every((profile) => profile.injectAgentsMd)).toBe(true);
    const reviewOnlyRoles = new Set(["reviewer", "security-reviewer"]);
    const leafRoles = new Set(["researcher"]);
    expect(
      swarmProfiles
        .filter((profile) => !reviewOnlyRoles.has(profile.name) && !leafRoles.has(profile.name))
        .every((profile) => profile.tools?.includes("Task")),
    ).toBe(true);
    for (const name of leafRoles) {
      const tools = swarmProfiles.find((profile) => profile.name === name)?.tools ?? [];
      expect(tools, name).not.toContain("Task");
    }
    for (const name of reviewOnlyRoles) {
      const tools = swarmProfiles.find((profile) => profile.name === name)?.tools ?? [];
      expect(tools, name).toContain("Task");
      expect(tools, name).not.toContain("Write");
      expect(tools, name).not.toContain("Edit");
      expect(tools, name).toEqual(expect.arrayContaining(["Read", "Glob", "Grep", "Bash"]));
    }
    expect(swarmProfiles.every((profile) => profile.systemPrompt.includes("下一负责人"))).toBe(
      true,
    );
    const startPrompt = swarmProfiles.find(({ name }) => name === "start")?.systemPrompt ?? "";
    expect(startPrompt).toContain("пользователем разрешение");
    expect(startPrompt).toContain("не обещай возобновление после перезапуска");
    const implementerPrompt =
      swarmProfiles.find(({ name }) => name === "implementer")?.systemPrompt ?? "";
    // Контракт изменился: сначала используется уже готовая подсказка, status/search — только без неё.
    expect(implementerPrompt).toContain("Если в контексте уже есть `code-index hint`");
    expect(implementerPrompt).toContain("сначала вызови CodeIndex status");
    expect(implementerPrompt).toContain("Не дублируй индекс широким Explore/Grep обходом");
    expect(implementerPrompt).toContain("offset = startLine");
    const orchestratorPrompt =
      swarmProfiles.find(({ name }) => name === "orchestrator")?.systemPrompt ?? "";
    expect(orchestratorPrompt).toContain(
      "Не создавай дублирующие или пересекающиеся по файлам ветки",
    );    expect(orchestratorPrompt).toContain("сопоставь каждый запрос пользователя");
    expect(orchestratorPrompt).toContain("не предоставляет");
    expect(swarmProfiles.find(({ name }) => name === "implementer")?.skills).toContain(
      "zcode-systematic-debugging",
    );
    expect(swarmProfiles.find(({ name }) => name === "implementer")?.skills).toContain(
      "zcode-test-driven-development",
    );
    expect(swarmProfiles.find(({ name }) => name === "test-engineer")?.skills).toContain(
      "zcode-test-driven-development",
    );
    expect(swarmProfiles.find(({ name }) => name === "start")?.skills).toContain("task-planning");
    expect(swarmProfiles.find(({ name }) => name === "start")?.skills).toContain("research");
    expect(swarmProfiles.find(({ name }) => name === "start")?.skills).toContain(
      "doc-coauthoring",
    );
    expect(swarmProfiles.find(({ name }) => name === "orchestrator")?.skills).toContain(
      "codebase-design",
    );
    expect(swarmProfiles.find(({ name }) => name === "implementer")?.skills).toContain(
      "image-to-code",
    );
    expect(swarmProfiles.find(({ name }) => name === "implementer")?.skills).toContain(
      "doc-coauthoring",
    );
    expect(swarmProfiles.find(({ name }) => name === "researcher")?.skills).toContain(
      "domain-modeling",
    );
    expect(swarmProfiles.find(({ name }) => name === "implementer")?.skills).toContain(
      "merge-conflict-resolution",
    );
    expect(swarmProfiles.find(({ name }) => name === "implementer")?.skills).toContain(
      "mcp-authoring",
    );
    expect(swarmProfiles.find(({ name }) => name === "test-engineer")?.skills).toContain(
      "performance-tuning",
    );
    expect(swarmProfiles.find(({ name }) => name === "orchestrator")?.skills).toContain("handoff");
    expect(swarmProfiles.find(({ name }) => name === "reviewer")?.skills).toContain("ui-craft");
    expect(swarmProfiles.find(({ name }) => name === "reviewer")?.skills).toContain(
      "image-to-code",
    );
    expect(swarmProfiles.find(({ name }) => name === "implementer")?.skills).toContain(
      "execution-patterns",
    );
    expect(swarmProfiles.find(({ name }) => name === "reviewer")?.skills).toContain(
      "zcode-verification",
    );
    expect(swarmProfiles.find(({ name }) => name === "reviewer")?.skills).toContain("reviewer");
    const reviewerPrompt =
      swarmProfiles.find(({ name }) => name === "reviewer")?.systemPrompt ?? "";
    expect(reviewerPrompt).toContain("researcher-подагентов в пределах доступных runtime-слотов");
    expect(reviewerPrompt).not.toContain("25 минут");
    expect(reviewerPrompt).not.toContain("45 минут");
    expect(swarmProfiles.find(({ name }) => name === "evaluator")?.skills).toContain(
      "completion-gate",
    );
    expect(swarmProfiles.find(({ name }) => name === "self-improver")?.skills).toContain(
      "self-improvement",
    );
    for (const profile of swarmProfiles.filter(({ tools }) => tools.includes("Task"))) {
      expect(profile.skills).toContain("zcode-swarm");
    }
  });

  it("restricts router roles to Task so they cannot read or explore the repository", () => {
    const swarmProfiles = getSwarmAgentProfiles(normalizeAgentProfiles([]));
    for (const name of ["start", "orchestrator"] as const) {
      const profile = swarmProfiles.find((candidate) => candidate.name === name);
      expect(profile?.tools, name).toEqual(["Task"]);
      const prompt = profile?.systemPrompt ?? "";
      expect(prompt, name).toContain("Твой единственный инструмент — Task");
      expect(prompt, name).toContain("не исследу");
      expect(prompt, name).not.toContain("Read-only триаж");
    }
  });

  it("uses explicit AGENTS.md injection defaults for built-in agents", () => {
    expect(createBuiltInExploreAgentProfile().injectAgentsMd).toBe(true);
  });

  it("parses explicit AGENTS.md injection while leaving missing custom values unset", () => {
    const explicit = parseAgentProfileFromMarkdown({
      source: "user",
      content: `---
name: inheriting-reviewer
description: Review with workspace instructions
injectAgentsMd: true
---
Review carefully.`,
    });
    const missing = parseAgentProfileFromMarkdown({
      source: "user",
      content: `---
name: legacy-reviewer
description: Legacy profile without the new field
---
Review carefully.`,
    });

    expect(explicit.profile?.injectAgentsMd).toBe(true);
    expect(missing.profile?.injectAgentsMd).toBeUndefined();
  });

  it("identifies Explore by both name and loader-owned source", () => {
    expect(isBuiltInExploreAgentProfile({ name: "Explore", source: "built-in" })).toBe(true);
    expect(isBuiltInExploreAgentProfile({ name: "Explore", source: "user" })).toBe(false);
    expect(isBuiltInExploreAgentProfile({ name: "Explore", source: "project" })).toBe(false);
    expect(isBuiltInExploreAgentProfile({ name: "general-purpose", source: "built-in" })).toBe(
      false,
    );
  });

  it("keeps a custom Explore profile intact when it overrides the built-in profile", () => {
    const profiles = normalizeAgentProfiles(
      [
        {
          name: "Explore",
          description: "Custom mutable explorer",
          source: "project",
          systemPrompt: "Use the project workflow.",
          modelSelection: { providerId: "custom-openai", modelId: "gpt-5.4" },
          tools: ["Write", "mcp__local-tools__query"],
        },
      ],
      {
        builtInModelSelectionOverrides: {
          Explore: {
            providerId: "custom-openai",
            modelId: "glm-5.2",
            options: { reasoningLevel: "max" },
          },
        },
      },
    );

    expect(profiles.find((profile) => profile.name === "Explore")).toMatchObject({
      source: "project",
      modelSelection: { providerId: "custom-openai", modelId: "gpt-5.4" },
      tools: ["Write", "mcp__local-tools__query"],
    });
  });

  it("formats a custom Explore with its declared tools", () => {
    const prompt = formatAgentProfilesForPrompt([
      {
        name: "Explore",
        description: "Custom mutable explorer",
        source: "user",
        systemPrompt: "Use the user workflow.",
        tools: ["Write", "mcp__local-tools__query"],
      },
    ]);

    expect(prompt).toContain(
      "- Explore: Custom mutable explorer (Tools: Write, mcp__local-tools__query)",
    );
    expect(prompt).not.toContain("Tools: CodeIndex, Read, Bash, WebFetch, WebSearch, TodoWrite");
  });

  it("leaves built-in Explore on inherited model by default", () => {
    expect(createBuiltInExploreAgentProfile().modelSelection).toBeUndefined();
    expect(
      normalizeAgentProfiles([]).find((profile) => profile.name === "Explore")?.modelSelection,
    ).toBeUndefined();
  });

  it("applies built-in model overrides without changing custom profile precedence", () => {
    const profiles = normalizeAgentProfiles(
      [
        {
          name: "code-reviewer",
          description: "Review code",
          source: "user",
          systemPrompt: "Review carefully.",
          modelSelection: { providerId: "custom-openai", modelId: "gpt-5.4" },
        },
      ],
      {
        builtInModelSelectionOverrides: {
          Explore: {
            providerId: "custom-openai",
            modelId: "glm-5.2",
            options: { reasoningLevel: "max" },
          },
        },
      },
    );

    expect(profiles.some((profile) => profile.name === "general-purpose")).toBe(false);
    expect(profiles.find((profile) => profile.name === "Explore")?.modelSelection).toEqual({
      providerId: "custom-openai",
      modelId: "glm-5.2",
      options: { reasoningLevel: "max" },
    });
    expect(profiles.find((profile) => profile.name === "code-reviewer")?.modelSelection).toEqual({
      providerId: "custom-openai",
      modelId: "gpt-5.4",
    });
  });

  it("applies router model overrides to start/orchestrator only", () => {
    const routerSelection = { providerId: "custom-openai", modelId: "cheap-router" };
    const profiles = normalizeAgentProfiles([], {
      builtInModelSelectionOverrides: { start: routerSelection },
    });

    expect(profiles.find((profile) => profile.name === "start")?.modelSelection).toEqual(
      routerSelection,
    );
    // Без override orchestrator продолжает наследовать модель сессии (undefined).
    expect(
      profiles.find((profile) => profile.name === "orchestrator")?.modelSelection,
    ).toBeUndefined();
    // Worker-роли не получают router-override.
    expect(profiles.find((profile) => profile.name === "coder")?.modelSelection).toBeUndefined();
  });

  it("keeps built-in Explore internal while retaining its formatter for compatibility", () => {
    const prompt = formatAgentProfilesForPrompt([], {
      embeddedSearchEnabled: true,
    });

    expect(prompt).not.toContain("Explore");
    const compatibilityLine = formatAgentProfileForPrompt(createBuiltInExploreAgentProfile(), {
      embeddedSearchEnabled: true,
    });
    expect(compatibilityLine).toContain("Tools: CodeIndex, Read, Bash, WebFetch, WebSearch, TodoWrite");
    expect(compatibilityLine).not.toContain("Glob");
    expect(compatibilityLine).not.toContain("Grep");
  });

  it("hides generic compatibility IDs from model-visible agent choices", () => {
    expect(isModelSelectableAgentProfile({ name: "general-purpose", source: "built-in" })).toBe(
      false,
    );
    expect(isModelSelectableAgentProfile({ name: "general", source: "project" })).toBe(false);
    expect(isModelSelectableAgentProfile({ name: "Explore", source: "built-in" })).toBe(false);
    expect(isModelSelectableAgentProfile({ name: "research-helper", source: "project" })).toBe(true);
    expect(isModelSelectableAgentProfile({ name: "Explore", source: "user" })).toBe(true);
  });

  describe("built-in start gateway contract", () => {
    // 回归依据：实测 start 以「Grep/Glob/Bash 不在我的工具集里」为由拒绝执行 L1–L4 自检，
    // 且把该自检当成「小任务」直接口述；这里锁定工具清单、层级语义和禁止自我复用的约束。
    const startProfile = () =>
      getSwarmAgentProfiles(normalizeAgentProfiles([])).find(({ name }) => name === "start");
    const startPrompt = () => startProfile()?.systemPrompt ?? "";

    it("does not advertise root-only tools as subagent capabilities", () => {
      const profiles = getSwarmAgentProfiles(normalizeAgentProfiles([]));

      for (const profile of profiles) {
        for (const tool of ROOT_ONLY_TOOL_NAMES) {
          expect(profile.tools, `${profile.name}: ${tool}`).not.toContain(tool);
        }
      }
    });

    it("does not list tools that have no child runtime handler", () => {
      const profiles = getSwarmAgentProfiles(normalizeAgentProfiles([]));

      for (const profile of profiles) {
        expect(profile.tools).not.toContain("NotebookEdit");
        expect(profile.tools).not.toContain("LSP");
      }
    });

    it("filters the model-visible catalog to the actual provider-visible tools", () => {
      const prompt = formatAgentProfilesForPrompt([], {
        availableToolNames: ["Read", "Glob", "Grep", "Bash", "Task", "Skill"],
      });

      expect(prompt).toContain("(Tools: Read, Glob, Grep, Bash");
      expect(prompt).not.toContain("WebSearch");
      expect(prompt).not.toContain("NotebookEdit");
      expect(prompt).not.toContain("LSP");
    });

    it("routes implementation away from start and forbids orchestrator self-implementation", () => {
      const profiles = getSwarmAgentProfiles(normalizeAgentProfiles([]));
      const start = profiles.find(({ name }) => name === "start")?.systemPrompt ?? "";
      const orchestrator = profiles.find(({ name }) => name === "orchestrator")?.systemPrompt ?? "";

      expect(start).toContain("ты не исполняешь её сам");
      expect(start).toContain("implementer");
      expect(start).toContain("orchestrator");
      expect(start).toContain("Если Task недоступен");
      expect(orchestrator).toContain("Ты не исполнитель");
      expect(orchestrator).toContain("не реализуй ветки сам");
    });

    it("states the single available tool and the L1-L4 nesting chain in the system prompt", () => {
      const prompt = startPrompt();

      expect(prompt).toContain("Твой единственный инструмент — Task");
      expect(prompt).toContain("Read, Glob, Grep, Skill, Bash, Write, Edit");
      expect(prompt).toContain("недоступны");
      expect(prompt).not.toContain("включая Read, Glob, Grep, Write, Edit, Bash");
      for (const tool of ["Read", "Glob", "Grep", "Skill", "Task"]) expect(prompt).toContain(tool);
      for (const level of ["L1", "L2", "L3", "L4"]) expect(prompt).toContain(level);
      expect(prompt).toContain("L4 — достаточная глубина для проверки вложенности");
      expect(prompt).toContain("номер уровня — только запись, а не стоп-условие");
      expect(prompt).toContain("Каждый уровень подтверждается только собственным вызовом Task");
    });

    it("forbids reopening start or orchestrator without a narrower envelope", () => {
      const prompt = startPrompt();

      expect(prompt).toContain("Никогда не вызывай Task(start)");
      expect(prompt).toContain("Task(orchestrator)");
      expect(prompt).toContain("без нового, более узкого конверта");
    });

    it("does not excuse verification requests as trivial chatter", () => {
      const prompt = startPrompt();

      expect(prompt).not.toContain("Небольшой самостоятельный запрос обработай кратко");
      expect(prompt).toContain("Тривиальна только светская реплика без задачи");
      expect(prompt).toContain(
        "Любая задача, требующая изменения файлов, запуска команд, тестов или сбора доказательств",
      );
      expect(prompt).toContain("ты не исполняешь её сам");
    });
  });
});

// 回归依据：custom-профиль с именем встроенной роли подменял prompt/tools, поэтому
// каталог и Swarm-контракт зависели от пользовательского файла. Теперь built-in выигрывает.
describe("built-in profile precedence over custom profiles", () => {
  const builtIn = (name: string) =>
    getSwarmAgentProfiles(normalizeAgentProfiles([])).find((profile) => profile.name === name);

  it("keeps start and implementer prompts and tools when a custom profile reuses their names", () => {
    const merged = normalizeAgentProfiles([
      {
        name: "start",
        description: "Custom start",
        source: "project",
        systemPrompt: "CUSTOM_START_PROMPT",
        tools: ["Read", "Write", "Edit", "Bash"],
      },
      {
        name: "implementer",
        description: "Custom implementer",
        source: "user",
        systemPrompt: "CUSTOM_IMPLEMENTER_PROMPT",
        tools: ["Read"],
      },
    ]);

    expect(merged.find((profile) => profile.name === "start")).toEqual(builtIn("start"));
    expect(merged.find((profile) => profile.name === "implementer")).toEqual(builtIn("implementer"));
    expect(merged.find((profile) => profile.name === "start")?.systemPrompt).not.toContain(
      "CUSTOM_START_PROMPT",
    );
    expect(merged.find((profile) => profile.name === "implementer")?.tools).toEqual(
      expect.arrayContaining(["Write", "Edit", "Bash"]),
    );
  });

  it("blocks same-name built-ins regardless of casing", () => {
    const merged = normalizeAgentProfiles([
      {
        name: "Reviewer",
        description: "Case-variant shadow",
        source: "project",
        systemPrompt: "CUSTOM_REVIEWER_PROMPT",
        tools: ["Read"],
      },
    ]);

    expect(merged.filter((profile) => profile.name.toLowerCase() === "reviewer")).toHaveLength(1);
    expect(merged.find((profile) => profile.name === "Reviewer")).toBeUndefined();
  });

  it("adds a custom profile with a unique name", () => {
    const merged = normalizeAgentProfiles([
      {
        name: "mobile-coder",
        description: "Mobile platform specialist",
        source: "project",
        systemPrompt: "MOBILE_CODER_PROMPT",
        tools: ["Read", "Write"],
      },
    ]);

    expect(merged.find((profile) => profile.name === "mobile-coder")).toMatchObject({
      description: "Mobile platform specialist",
      source: "project",
      systemPrompt: "MOBILE_CODER_PROMPT",
      tools: ["Read", "Write"],
    });
    expect(formatAgentProfilesForPrompt(merged)).toContain(
      "- mobile-coder: Mobile platform specialist",
    );
  });
});

// 16 канонических ролей: специализированные исполнители, включая debugger.
describe("specialized worker roster", () => {
  const profiles = () => getSwarmAgentProfiles(normalizeAgentProfiles([]));
  const profile = (name: string) => profiles().find((candidate) => candidate.name === name);

  it("ships 16 canonical roles in a stable order, including a debugger", () => {
    expect(SWARM_AGENT_TYPES).toHaveLength(16);
    expect(profiles().map(({ name }) => name)).toEqual([...SWARM_AGENT_TYPES]);
    expect(SWARM_AGENT_TYPES).toContain("debugger");
    expect(profile("debugger")?.description).toContain("первопричину");
    expect(profile("debugger")?.systemPrompt).toContain("Сначала воспроизведи дефект");
  });

  it.each(["coder", "frontend-coder", "backend-coder", "infra-coder"])(
    "%s is a built-in worker with the full toolset and AGENTS.md injection",
    (name) => {
      expect(profile(name)).toMatchObject({
        injectAgentsMd: true,
        source: "built-in",
        tools: [...WORKER_SUBAGENT_TOOL_NAMES],
      });
      expect(profile(name)?.description.length).toBeGreaterThan(0);
      expect(profile(name)?.color).toBeDefined();
      expect(profile(name)?.systemPrompt).toContain("下一负责人");
    },
  );

  it("declares the requested skill allowlists", () => {
    expect(profile("coder")?.skills).toEqual([
      "*",
      "code-craft",
      "zcode-test-driven-development",
      "zcode-verification",
      "reference-first",
      "architecture-governance",
      "dep-refs",
      "zcode-swarm",
    ]);
    expect(profile("frontend-coder")?.skills).toEqual([
      "*",
      "frontend-design",
      "ui-craft",
      "ai-elements",
      "web-design-guidelines",
      "vercel-react-best-practices",
      "zcode-verification",
      "zcode-swarm",
    ]);
    expect(profile("backend-coder")?.skills).toEqual([
      "*",
      "codebase-design",
      "architecture-governance",
      "domain-modeling",
      "performance-tuning",
      "zcode-verification",
      "reference-first",
      "zcode-swarm",
    ]);
    expect(profile("infra-coder")?.skills).toEqual([
      "*",
      "electron",
      "dep-refs",
      "performance-tuning",
      "zcode-verification",
      "reference-first",
      "zcode-swarm",
    ]);
  });

  it("states each specialized role boundary in its prompt", () => {
    expect(profile("coder")?.description).toContain("регрессионными тестами");
    expect(profile("coder")?.systemPrompt).toContain("production-код");
    expect(profile("frontend-coder")?.systemPrompt).toContain("DESIGN.md");
    expect(profile("frontend-coder")?.systemPrompt).toContain("i18n");
    expect(profile("frontend-coder")?.systemPrompt).toContain("desktop");
    expect(profile("backend-coder")?.systemPrompt).toContain("services/runtime/protocol/data");
    expect(profile("backend-coder")?.systemPrompt).toContain("идемпотентность");
    expect(profile("backend-coder")?.systemPrompt).toContain("конкурентных");
    expect(profile("infra-coder")?.systemPrompt).toContain("build/release/CI/scripts/electron");
    expect(profile("infra-coder")?.systemPrompt).toContain("Windows");
    expect(profile("infra-coder")?.systemPrompt).toContain("Linux");
  });

  it("routes start exclusively through the orchestrator instead of direct workers", () => {
    const prompt = profile("start")?.systemPrompt ?? "";

    expect(prompt).toContain('Task(subagent_type: "orchestrator")');
    expect(prompt).toContain("запускает orchestrator");
    expect(prompt).toContain("не запускаешь worker-роли напрямую");
    expect(prompt).toContain("не передаёт task_graph");
    expect(prompt).toContain("следующий wave");
    expect(prompt).toContain("накопленным контекстом");
    expect(prompt).not.toContain("production-код — coder");
    expect(prompt).not.toContain("Сразу маршрутизируй изменяющую работу специализированному исполнителю");
  });

  it("forbids orchestrator recursion and requires partial context for the next wave", () => {
    const prompt = profile("orchestrator")?.systemPrompt ?? "";

    expect(prompt).toContain("Никогда не вызывай Task(start)");
    expect(prompt).toContain("не вызывай Task(orchestrator)");
    expect(prompt).toContain("Планируй для каждой ветки конечный проверяемый объём");
    expect(prompt).toContain("не задавай искусственный тайм-бюджет или deadline");
    expect(prompt).toContain("Runtime ограничивает одновременно активные ветки доступной ёмкостью хоста и провайдера");
    expect(prompt).not.toContain("15 минут своего hard deadline");
    expect(prompt).toContain("следующий wave");
    expect(prompt).toContain("накопленным контекстом");
    expect(prompt).toContain("researcher");
    expect(prompt).toContain("test-engineer");
    expect(prompt).toContain("coder");
  });

  it("plans useful fan-out without a total task-count budget", () => {
    const prompt = profile("orchestrator")?.systemPrompt ?? "";

    expect(prompt).toContain("доступной ёмкостью хоста и провайдера, а не суммарным числом задач");
    expect(prompt).toContain("выбирай debugger");
    expect(prompt).toContain("с именами и описаниями установленных Skills из system-reminder");
    expect(prompt).toContain("Планируй все полезные независимые ветки волнами");
    expect(prompt).toContain("следующую волну после join");
    expect(prompt).toContain("subagent-factory");
    expect(prompt).toContain("не дроби один deliverable на несколько агентов ради количества");
    expect(prompt).not.toContain("remaining_spawns");
    expect(prompt).not.toContain("5–8 действительно независимых областей");
  });

  it("re-dispatches after claim conflict and reacts to each terminal report", () => {
    const prompt = profile("orchestrator")?.systemPrompt ?? "";

    expect(prompt).toContain("write_claim_conflict");
    expect(prompt).toContain("не считай её выполненной");
    expect(prompt).toContain("отложи спавн и повтори после терминала держателя claim");
    expect(prompt).toContain("После каждого терминального отчёта пересматривай план");
    expect(prompt).toContain("SkillSearch/SkillInstall");
    expect(prompt).toContain("requires:");
    expect(prompt).toContain("runtime отклонит spawn до установки");
  });

  it("turns subagent-factory into a real profile author with catalog boundaries", () => {
    const factory = profile("subagent-factory");
    const prompt = factory?.systemPrompt ?? "";

    expect(factory?.description).toContain(".zcode/agents");
    expect(prompt).toContain(".zcode/agents/<kebab-name>.md");
    expect(prompt).toContain("frontmatter");
    expect(prompt).toContain("disallowedTools");
    expect(prompt).toContain("mcpServers");
    for (const role of SWARM_AGENT_TYPES) expect(prompt, role).toContain(role);
    expect(prompt).toContain("general-purpose");
    expect(prompt).toContain("Explore");
    for (const tool of WORKER_SUBAGENT_TOOL_NAMES) expect(prompt, tool).toContain(tool);
    expect(prompt).toContain("следующем turn");
    expect(prompt).toContain("секреты");
    expect(prompt).toContain("разовую задачу");
    expect(prompt).toContain("generic-роль");
    expect(prompt).toContain("не создавай профиль");
    expect(prompt).toContain("существующие роли и навыки");
  });
});

// docs/specs/agent-capability-gate.md: роль определяет реальный набор инструментов.
// Ожидаемые списки продублированы литералами намеренно — изменение матрицы должно
// требовать явного обновления теста, а не следовать за экспортированной константой.
describe("built-in role capability matrix", () => {
  const builtInProfiles = () => getSwarmAgentProfiles(normalizeAgentProfiles([]));
  const toolsOf = (name: string): readonly string[] =>
    builtInProfiles().find((profile) => profile.name === name)?.tools ?? [];

  const ROUTER_TOOLS = ["Task"];
  const INSPECTION_TOOLS = [
    "CodeIndex",
    "Read",
    "Glob",
    "Grep",
    "Bash",
    "WebFetch",
    "WebSearch",
    "Task",
    "Skill",
    "SkillSearch",
    "SkillInstall",
    "TodoRead",
    "TodoWrite",
    "AskUserQuestion",
    "TaskOutput",
    "TaskStop",
  ];
  const RESEARCHER_TOOLS = INSPECTION_TOOLS.filter((tool) => tool !== "Task");
  const REVIEW_TOOLS = [
    "CodeIndex",
    "Read",
    "Glob",
    "Grep",
    "Bash",
    "WebFetch",
    "WebSearch",
    "Task",
    "Skill",
    "SkillSearch",
    "SkillInstall",
    "TodoRead",
    "TodoWrite",
    "AskUserQuestion",
    "TaskOutput",
    "TaskStop",
  ];
  const WORKER_TOOLS = [
    "CodeIndex",
    "Read",
    "Glob",
    "Grep",
    "Write",
    "Edit",
    "Bash",
    "WebFetch",
    "WebSearch",
    "Task",
    "Skill",
    "SkillSearch",
    "SkillInstall",
    "TodoRead",
    "TodoWrite",
    "AskUserQuestion",
    "TaskOutput",
    "TaskStop",
  ];

  it.each(["start", "orchestrator"])(
    "%s routes without reading or direct mutation tools",
    (name) => {
      const tools = toolsOf(name);

      expect(tools).toEqual(ROUTER_TOOLS);
      expect(tools).not.toContain("Read");
      expect(tools).not.toContain("Glob");
      expect(tools).not.toContain("Grep");
      expect(tools).not.toContain("Skill");
      expect(tools).not.toContain("Write");
      expect(tools).not.toContain("Edit");
      expect(tools).not.toContain("Bash");
    },
  );

  it("researcher inspects with Bash but is a leaf without Task or write tools", () => {
    const tools = toolsOf("researcher");

    expect(tools).toEqual(RESEARCHER_TOOLS);
    expect(tools).not.toContain("Task");
    expect(tools).toContain("Bash");
    expect(tools).not.toContain("Write");
    expect(tools).not.toContain("Edit");
  });

  it("evaluator inspects and may delegate with Bash but cannot write files", () => {
    const tools = toolsOf("evaluator");

    expect(tools).toEqual(INSPECTION_TOOLS);
    expect(tools).toContain("Task");
    expect(tools).toContain("Bash");
    expect(tools).not.toContain("Write");
    expect(tools).not.toContain("Edit");
  });

  it.each(["reviewer", "security-reviewer"])(
    "%s reviews the given diff with bounded researcher delegation",
    (name) => {
      const tools = toolsOf(name);

      expect(tools).toEqual(REVIEW_TOOLS);
      expect(tools).toEqual([...REVIEW_SUBAGENT_TOOL_NAMES]);
      expect(tools).toContain("Task");
      expect(tools).not.toContain("Agent");
      expect(tools).toContain("Bash");
      expect(tools).not.toContain("Write");
      expect(tools).not.toContain("Edit");
    },
  );

  it.each([
    "implementer",
    "coder",
    "frontend-coder",
    "backend-coder",
    "infra-coder",
    "test-engineer",
    "self-improver",
    "knowledge-curator",
    "subagent-factory",
  ])("%s keeps the full worker toolset", (name) => {
    expect(toolsOf(name)).toEqual(WORKER_TOOLS);
  });

  it("keeps bounded parallel delegation on code-writing worker profiles", () => {
    for (const name of [
      "implementer",
      "coder",
      "frontend-coder",
      "backend-coder",
      "infra-coder",
    ] as const) {
      const prompt =
        builtInProfiles().find((profile) => profile.name === name)?.systemPrompt ?? "";
      expect(prompt, name).toContain(
        "worker/researcher-подагентов одним сообщением, с непересекающимися путями и параллелизмом по свободным слотам runtime, не 1",
      );
      expect(prompt, name).toContain("Каждый подагент получает узкий deliverable");
      expect(prompt, name).not.toContain("до двух worker/researcher-подагентов");
    }
  });

  it("covers every built-in swarm role without gaps or duplicates", () => {
    expect(builtInProfiles().map((profile) => profile.name)).toEqual([...SWARM_AGENT_TYPES]);
  });

  it("keeps inspection roles' prompts honest about Bash and write access", () => {
    for (const role of ["researcher", "reviewer", "security-reviewer", "evaluator"] as const) {
      const prompt =
        builtInProfiles().find((profile) => profile.name === role)?.systemPrompt ?? "";

      expect(prompt, role).toContain("Bash");
      expect(prompt, role).toContain("Write/Edit недоступны");
    }
  });

  it("keeps researcher a leaf and forbids re-opening settled facts", () => {
    const prompt =
      builtInProfiles().find((profile) => profile.name === "researcher")?.systemPrompt ?? "";

    expect(prompt).toContain("leaf-исследователь");
    expect(prompt).toContain("не запускай других агентов");
    expect(prompt).toContain("settled facts");
    expect(prompt).not.toContain("запускай researcher-подагентов");
  });

  it("advertises the Task-only router toolset in the orchestrator prompt", () => {
    const prompt =
      builtInProfiles().find((profile) => profile.name === "orchestrator")?.systemPrompt ?? "";

    expect(prompt).toContain("Твой единственный инструмент — Task");
    expect(prompt).toContain("Read, Glob, Grep, Skill, Write, Edit и Bash недоступны");
  });
});

// docs/specs/agent-capability-gate.md: review-тир не делегирует, начинает с выданного
// diff, ограничивает findings и честно возвращает partial/blocked при исчерпании deadline.
describe("review prompt contract", () => {
  const promptOf = (name: string): string =>
    getSwarmAgentProfiles(normalizeAgentProfiles([])).find((profile) => profile.name === name)
      ?.systemPrompt ?? "";

  it.each(["reviewer", "security-reviewer"])(
    "%s reads the provided diff first and avoids broad repository re-traversal",
    (name) => {
      const prompt = promptOf(name);

      expect(prompt).toContain("Первичный вход");
      expect(prompt).toContain("Сначала прочитай diff");
      expect(prompt).toContain("не делай широкий Explore-подобный обход репозитория");
      expect(prompt).toContain("непосредственно требуемые call sites");
    },
  );

  it.each(["reviewer", "security-reviewer"])(
    "%s caps findings at 10 and reports files, tests and checklist",
    (name) => {
      const prompt = promptOf(name);

      expect(prompt).toContain("Максимум 10 подтверждённых findings");
      expect(prompt).toContain("severity, file:line, impact, reproduction/evidence");
      expect(prompt).toContain("раздел gaps");
      expect(prompt).toContain("просмотренные файлы");
      expect(prompt).toContain("фактически запущенные тесты");
      expect(prompt).toContain("использованный чеклист");
    },
  );

  it.each(["reviewer", "security-reviewer"])(
    "%s returns explicit partial/blocked only on real blockage",
    (name) => {
      const prompt = promptOf(name);

      expect(prompt).toContain("partial или blocked");
      expect(prompt).toContain("что просмотрено, что нет");
      expect(prompt).toContain("Не вводи собственный тайм-бюджет");
      expect(prompt).toContain("reviewer-веткам в пределах доступных runtime-слотов");
      expect(prompt).toContain("Не запускай несколько агентов на одинаковый diff или проверку");
      expect(prompt).not.toContain("2–3 параллельных reviewer");
    },
  );

  it("scopes security-reviewer to security-sensitive diffs only", () => {
    const prompt = promptOf("security-reviewer");

    expect(prompt).toContain("только на security-sensitive diff");
    expect(prompt).toContain("аутентификация и авторизация");
    expect(prompt).toContain("границы доверия");
    expect(prompt).toContain("сетевой ввод и парсинг");
    expect(prompt).toContain("разрешения и sandbox");
    expect(prompt).toContain("не запрашивает security-reviewer");
    expect(prompt).toContain("не расширяй область поиска");
  });
});

// Routing architecture: one caller-scoped filter feeds both the visible catalog and
// Agent/Task admission. start is a gateway, orchestrator is the only dispatcher.
describe("caller-scoped agent catalog", () => {
  const profiles = () => getSwarmAgentProfiles(normalizeAgentProfiles([]));
  const namesFor = (caller?: string) =>
    filterAgentTypesForCaller(profiles(), caller).map((profile) => profile.name);

  it("gives start exactly one delegation target", () => {
    expect(namesFor("start")).toEqual(["orchestrator"]);
  });

  it("gives orchestrator worker roles but not the router roles", () => {
    const names = namesFor("orchestrator");

    expect(names).toEqual(
      expect.arrayContaining([
        "researcher",
        "reviewer",
        "security-reviewer",
        "test-engineer",
        "evaluator",
        "implementer",
        "coder",
        "frontend-coder",
        "backend-coder",
        "infra-coder",
        "subagent-factory",
      ]),
    );
    expect(names).not.toContain("start");
    expect(names).not.toContain("orchestrator");
  });

  it.each(["reviewer", "security-reviewer", "evaluator"] as const)(
    "gives %s only the model-selectable researcher entry",
    (caller) => {
      const visible = filterAgentTypesForCaller(profiles(), caller);

      expect(visible.map((profile) => profile.name)).toEqual(["researcher"]);
      expect(visible.every(isModelSelectableAgentProfile)).toBe(true);
    },
  );

  it("gives researcher no delegation catalog because it is a leaf", () => {
    expect(filterAgentTypesForCaller(profiles(), "researcher")).toEqual([]);
  });

  it("leaves root and main sessions unrestricted", () => {
    expect(filterAgentTypesForCaller(profiles(), undefined)).toEqual(profiles());
    expect(filterAgentTypesForCaller(profiles(), "")).toEqual(profiles());
    expect(namesFor(undefined)).toEqual(expect.arrayContaining(["start", "orchestrator", "coder"]));
  });

  it("shares the admission predicate with the catalog", () => {
    expect(isAgentTypeAllowedForCaller("orchestrator", "start")).toBe(true);
    expect(isAgentTypeAllowedForCaller("coder", "start")).toBe(false);
    expect(isAgentTypeAllowedForCaller("orchestrator", "orchestrator")).toBe(false);
    expect(isAgentTypeAllowedForCaller("start", "orchestrator")).toBe(false);
    expect(isAgentTypeAllowedForCaller("coder", "orchestrator")).toBe(true);
    expect(isAgentTypeAllowedForCaller("coder", undefined)).toBe(true);
    expect(isAgentTypeAllowedForCaller("researcher", "researcher")).toBe(false);
  });

  it.each(["reviewer", "security-reviewer", "evaluator"] as const)(
    "admits only researcher for inspection caller %s",
    (caller) => {
      const forbiddenTargets = [
        "reviewer",
        "security-reviewer",
        "evaluator",
        "coder",
        "test-engineer",
        "start",
        "orchestrator",
      ];

      expect(isAgentTypeAllowedForCaller("researcher", caller)).toBe(true);
      for (const target of forbiddenTargets) {
        expect(isAgentTypeAllowedForCaller(target, caller), `${caller} -> ${target}`).toBe(false);
      }
    },
  );

  it("admits no delegation target for researcher caller", () => {
    for (const target of ["researcher", "coder", "start", "orchestrator"]) {
      expect(isAgentTypeAllowedForCaller(target, "researcher"), `researcher -> ${target}`).toBe(
        false,
      );
    }
  });

  it("keeps runner-resolvable fuzzy role names admissible", () => {
    expect(matchAgentTypeInCatalog("coder", ["coder", "researcher"])).toBe("exact");
    expect(matchAgentTypeInCatalog("Coder", ["coder", "researcher"])).toBe("normalized");
    expect(matchAgentTypeInCatalog("foo bar", ["foo-bar", "foo_bar"])).toBe("ambiguous");
    expect(matchAgentTypeInCatalog("report.v2", ["report-v2"])).toBe("none");
  });
});

describe("delegation routing gate", () => {
  it("answers social-only requests directly", () => {
    expect(decideDelegationRoute({ role: "start", socialOnly: true })).toMatchObject({
      route: "answer_directly",
      maxParallel: 0,
    });
  });

  it("never lets start or orchestrator integrate implementation inline", () => {
    for (const role of ["start", "orchestrator"] as const) {
      expect(
        decideDelegationRoute({ role, serialDependencies: true, integrationOwnedByCaller: true }),
      ).toMatchObject({ route: "delegate_single", maxParallel: 1 });
    }
  });

  it("orchestrates two or more independent workstreams", () => {
    expect(decideDelegationRoute({ role: "root", independentWorkstreams: 3 })).toMatchObject({
      route: "orchestrate",
      maxParallel: 3,
    });
  });

  it("keeps serial caller-owned integration in the root", () => {
    expect(
      decideDelegationRoute({ role: "root", serialDependencies: true, integrationOwnedByCaller: true }),
    ).toMatchObject({ route: "integrate_inline", maxParallel: 0 });
  });

  it("delegates a single bounded task even from the root", () => {
    expect(decideDelegationRoute({ role: "root" })).toMatchObject({
      route: "delegate_single",
      maxParallel: 1,
    });
  });

  it("uses workstream count and explicit concurrency preference, ignoring legacy task budgets", () => {
    expect(
      decideDelegationRoute({
        role: "start",
        independentWorkstreams: 6,
        userMaxParallel: 8,
      }),
    ).toMatchObject({ route: "orchestrate", maxParallel: 6 });

    expect(
      decideDelegationRoute({
        role: "root",
        independentWorkstreams: 6,
        userMaxParallel: 2,
      }),
    ).toMatchObject({ route: "orchestrate", maxParallel: 2 });
  });

  it("allows read-only triage in place and still delegates implementation", () => {
    expect(decideDelegationRoute({ role: "start", readOnly: true })).toMatchObject({
      route: "integrate_inline",
      maxParallel: 0,
    });
    expect(decideDelegationRoute({ role: "start" })).toMatchObject({ route: "delegate_single" });
  });

  it("embeds the routing contract in start and orchestrator prompts", () => {
    const profiles = getSwarmAgentProfiles(normalizeAgentProfiles([]));

    for (const name of ["start", "orchestrator"]) {
      const prompt = profiles.find((profile) => profile.name === name)?.systemPrompt ?? "";
      expect(prompt).toContain("Перед действием классифицируй задачу");
      expect(prompt).toContain("integrate_inline");
      expect(prompt).toContain("max_parallel");
    }
  });

  it("clamps the runtime swarm DAG parallelism through the routing gate", () => {
    expect(
      resolveSwarmParallelism({ nodeCount: 6, requestedMaxParallel: 8 }),
    ).toMatchObject({ route: "orchestrate", maxParallel: 6 });
    expect(
      resolveSwarmParallelism({ nodeCount: 2, requestedMaxParallel: 8 }),
    ).toMatchObject({ route: "orchestrate", maxParallel: 2 });
  });
});
