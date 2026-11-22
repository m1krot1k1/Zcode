import { CREATE_WORKFLOW_TOOL_NAME, createSessionId } from "@zcode/contracts";
import type { SessionTaskType } from "@zcode/contracts";
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../src/runtime.js";
import {
  expandSubagentDispatchDisallowRules,
  shouldIncludeTaskAlias,
} from "../src/runtime/helpers/tool-allowlist.js";
import { getTurnTools, type RegularTurnLoopState } from "../src/runtime/methods/turn-loop-state.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { AgentRuntimeDeps } from "../src/runtime/types.js";
import { PermissionService } from "../src/permission/service.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { createTestSessionEventStore } from "./test-event-store.js";

// docs/specs/task-alias-visibility.md: видимость Task alias — одно правило на оба пути
// регистрации built-in инструментов. Регрессия (подтверждена): refresh из
// refreshBranchAwareBuiltInTools не передавал includeTaskAlias, registry.register
// перезаписывал ранее видимый Task entry версией с providerVisible:false, и после
// initializeSessionShellEnvironmentIfNeeded (applySessionShellEnvironment) alias исчезал
// из runtime.getTools(). Тест идёт через публичный путь shell-init, а не через внутренний refresh.

const CMD_SHELL_SELECTION = {
  dialect: "cmd",
  display: { name: "CMD" },
  id: "cmd",
  label: "CMD",
  path: "cmd.exe",
  source: "user-config",
} as const;

function createRuntime(
  taskType: SessionTaskType | undefined,
  deps: Partial<AgentRuntimeDeps> = {},
): AgentRuntime {
  return new AgentRuntime(
    createSessionId(`task-alias-${taskType ?? "default"}`),
    taskType === undefined ? {} : { taskType },
    {
      // includeAgent = Boolean(subagentPort): без порта Agent/Task вообще не регистрируются,
      // а helper решает только видимость alias при уже зарегистрированной записи.
      subagentPort: {} as never,
      toolRegistry: createToolRegistry(),
      ...deps,
      eventStore: deps.eventStore ?? createTestSessionEventStore(),
    },
  );
}

/** Provider-visible набор: toContracts() отбрасывает entries с providerVisible === false. */
function providerVisibleToolNames(runtime: AgentRuntime): string[] {
  return runtime
    .getToolRegistry()
    .toContracts()
    .map((tool) => tool.name);
}

function runtimeToolNames(runtime: AgentRuntime): string[] {
  return runtime.getTools().map((tool) => tool.name);
}

describe("shouldIncludeTaskAlias — единственный владелец правила", () => {
  it.each([
    { taskType: undefined, visible: true },
    { taskType: "interactive" as const, visible: true },
    { taskType: "fork" as const, visible: true },
    { taskType: "selection_side_chat" as const, visible: true },
    { taskType: "subagent_child" as const, visible: true },
    // workflow_parent не входит в явный allow-список: alias скрыт, как у любого taskType вне списка.
    { taskType: "workflow_parent" as const, visible: false },
    { taskType: "workflow_child" as const, visible: false },
    { taskType: "nested_workflow_child" as const, visible: false },
  ])("taskType $taskType → $visible", ({ taskType, visible }) => {
    expect(shouldIncludeTaskAlias(taskType)).toBe(visible);
  });
});

describe("Task alias: первичная регистрация и shell-init refresh совпадают", () => {
  it.each([
    { taskType: undefined, visible: true },
    { taskType: "interactive" as const, visible: true },
    { taskType: "fork" as const, visible: true },
    { taskType: "selection_side_chat" as const, visible: true },
    { taskType: "subagent_child" as const, visible: true },
    { taskType: "workflow_parent" as const, visible: false },
    { taskType: "workflow_child" as const, visible: false },
    { taskType: "nested_workflow_child" as const, visible: false },
  ])(
    "taskType $taskType: Task $visible до и после initializeSessionShellEnvironmentIfNeeded",
    ({ taskType, visible }) => {
      const runtime = createRuntime(taskType);

      // До refresh: первичная сборка (helpers/runtime-tools.ts).
      const visibleBefore = providerVisibleToolNames(runtime);
      const toolsBefore = runtimeToolNames(runtime);
      // Sanity: порт субагентов зарегистрировал dispatch-пару, иначе проверка Task была бы пустой.
      expect(visibleBefore).toContain("Agent");
      expect(visibleBefore.includes("Task")).toBe(visible);
      expect(toolsBefore.includes("Task")).toBe(visible);

      // Реальный путь refresh: applySessionShellEnvironment → refreshBranchAwareBuiltInTools.
      expect(runtime.initializeSessionShellEnvironmentIfNeeded(CMD_SHELL_SELECTION)).toBe(true);

      // После refresh provider-visible набор обязан совпасть с первичной регистрацией.
      const visibleAfter = providerVisibleToolNames(runtime);
      const toolsAfter = runtimeToolNames(runtime);
      expect(visibleAfter.includes("Task")).toBe(visible);
      expect(toolsAfter.includes("Task")).toBe(visible);
      expect(visibleAfter.toSorted()).toEqual(visibleBefore.toSorted());
      expect(toolsAfter.toSorted()).toEqual(toolsBefore.toSorted());
      // embedded search refresh не должен оставить кеш getTools с дорефрешным набором.
      expect(
        runtime
          .getTools()
          .map((tool) => tool.name)
          .toSorted(),
      ).toEqual(visibleAfter.toSorted());
    },
  );

  // Второй контракт refresh (docs/specs/task-alias-visibility.md「Текущее расхождение」):
  // передаётся resolveRuntimeDisallowedTools, а не сырой config.toolDisallowlist, иначе после
  // shell-init структурные запреты workflow_child теряются.
  it("workflow_child после shell-init сохраняет структурный disallowlist", () => {
    const runtime = createRuntime("workflow_child");
    expect(runtime.getToolRegistry().has(CREATE_WORKFLOW_TOOL_NAME)).toBe(false);

    expect(runtime.initializeSessionShellEnvironmentIfNeeded(CMD_SHELL_SELECTION)).toBe(true);

    expect(runtime.getToolRegistry().has(CREATE_WORKFLOW_TOOL_NAME)).toBe(false);
  });

  it("interactive после shell-init сохраняет структурные workflow-инструменты", () => {
    const runtime = createRuntime("interactive");
    expect(runtime.getToolRegistry().has(CREATE_WORKFLOW_TOOL_NAME)).toBe(true);

    expect(runtime.initializeSessionShellEnvironmentIfNeeded(CMD_SHELL_SELECTION)).toBe(true);

    expect(runtime.getToolRegistry().has(CREATE_WORKFLOW_TOOL_NAME)).toBe(true);
  });

  // refresh 刻意不传端口门（includeSendMessage / includeSubmitResult / includeEscalate /
  // includeAutomation / includeOffPeak / includeCodeIndex）：这些门的极性是
  // 「只在 true 时注册」，省略意味着「不重新注册」，首次装配按实际端口建立的记录必须原样保留。
  // `Workflow` (`includeWorkflow`) сюда не входит: его entry закомментирован в builtInTools,
  // порт сам по себе запись не создаёт.
  it("interactive после shell-init сохраняет порт-гейтед инструменты и Task", () => {
    const runtime = createRuntime("interactive", {
      subagentPort: { sendMessage: async () => ({ status: "success" }) } as never,
      workflowSubmitPort: { respond: async () => ({ accept: true }) },
      workflowEscalatePort: {
        escalate: async () => ({ kind: "refused", reason: "no_active_ask", message: "none" }),
      },
      automationPort: {} as never,
      offPeakPort: { create: async () => ({}), list: async () => [] } as never,
      codeIntelligencePort: { query: async () => ({}) } as never,
    });
    const portGatedTools = [
      "SendMessage",
      "submit_result",
      "escalate",
      "CronCreate",
      "OffPeakCreate",
      "CodeIndex",
    ];
    const registry = runtime.getToolRegistry();
    for (const toolName of portGatedTools) {
      expect({ toolName, registered: registry.has(toolName) }).toEqual({
        toolName,
        registered: true,
      });
    }
    expect(providerVisibleToolNames(runtime)).toContain("Task");

    expect(runtime.initializeSessionShellEnvironmentIfNeeded(CMD_SHELL_SELECTION)).toBe(true);

    for (const toolName of portGatedTools) {
      expect({ toolName, registered: registry.has(toolName) }).toEqual({
        toolName,
        registered: true,
      });
    }
    expect(providerVisibleToolNames(runtime)).toContain("Task");
  });

  // subagent_child: RespondToCoordinator — тот же класс порт-гейтед опций, что и выше,
  // но с дополнительным условием taskType. Refresh обязан сохранить запись, не пересоздавая её.
  it("subagent_child после shell-init сохраняет RespondToCoordinator и Task", () => {
    const runtime = createRuntime("subagent_child", {
      coordinatorResponsePort: {
        respond: () => ({ status: "success", responseId: "r1", message: "queued" }),
      } as never,
    });
    const registry = runtime.getToolRegistry();
    expect(registry.has("RespondToCoordinator")).toBe(true);
    expect(providerVisibleToolNames(runtime)).toContain("Task");

    expect(runtime.initializeSessionShellEnvironmentIfNeeded(CMD_SHELL_SELECTION)).toBe(true);

    expect(registry.has("RespondToCoordinator")).toBe(true);
    expect(providerVisibleToolNames(runtime)).toContain("Task");
  });

  // Обратная сторона того же контракта: refresh не воскрешает порт-гейтед инструменты,
  // которых первый вход не регистрировал из-за отсутствия порта.
  it("interactive без портов не получает порт-гейтед инструменты после shell-init", () => {
    const runtime = createRuntime("interactive");
    const registry = runtime.getToolRegistry();
    const portGatedTools = [
      "SendMessage",
      "submit_result",
      "escalate",
      "CronCreate",
      "OffPeakCreate",
      "CodeIndex",
    ];
    for (const toolName of portGatedTools) expect(registry.has(toolName)).toBe(false);

    expect(runtime.initializeSessionShellEnvironmentIfNeeded(CMD_SHELL_SELECTION)).toBe(true);

    for (const toolName of portGatedTools) expect(registry.has(toolName)).toBe(false);
  });
});

// docs/specs/task-alias-visibility.md「Alias-развёртывание disallowlist на границах
// регистрации и permission», TASKALIAS-05/07/08.
//
// Подтверждённый дефект: registerBuiltInTools фильтровал записи по точному имени, поэтому
// toolDisallowlist:["Agent"] оставлял Task provider-visible. Через публичный runtime-путь
// (resolveRuntimeDisallowedTools → registerBuiltInTools) проверяем, что запрет любого имени
// закрывает пару и до, и после shell-init refresh.
describe("Agent/Task disallowlist закрывает оба имени на границе регистрации", () => {
  function runtimeDisallowedToolNames(
    taskType: SessionTaskType | undefined,
    toolDisallowlist: readonly string[],
  ): { visible: string[]; registered: string[] } {
    const runtime = new AgentRuntime(
      createSessionId(`task-alias-disallow-${taskType ?? "default"}-${toolDisallowlist.join("-")}`),
      { ...(taskType === undefined ? {} : { taskType }), toolDisallowlist },
      {
        subagentPort: {} as never,
        toolRegistry: createToolRegistry(),
        eventStore: createTestSessionEventStore(),
      },
    );
    return {
      visible: providerVisibleToolNames(runtime),
      registered: runtimeToolNames(runtime),
    };
  }

  it.each(["Agent", "Task"])(
    "toolDisallowlist:[%s] скрывает и Agent, и Task, а не только точное имя",
    (denied) => {
      const before = runtimeDisallowedToolNames("interactive", [denied]);
      expect({
        Agent: before.visible.includes("Agent"),
        Task: before.visible.includes("Task"),
      }).toEqual({ Agent: false, Task: false });
      expect({
        Agent: before.registered.includes("Agent"),
        Task: before.registered.includes("Task"),
      }).toEqual({ Agent: false, Task: false });
    },
  );

  // Точная проба дефекта: прямой вызов границы регистрации с includeAgent+includeTaskAlias.
  // До исправления фильтр сравнивал точное имя и возвращал Task provider-visible.
  it.each(["Agent", "Task"])(
    "registerBuiltInTools с disallowedTools:[%s] не регистрирует Task",
    (denied) => {
      const registry = createToolRegistry();
      registerBuiltInTools(registry, {
        includeAgent: true,
        includeTaskAlias: true,
        disallowedTools: [denied],
      });
      expect(registry.has("Agent")).toBe(false);
      expect(registry.has("Task")).toBe(false);
      expect(registry.toContracts().map((tool) => tool.name)).not.toContain("Task");
    },
  );

  it("запрет Agent переживает shell-init refresh (второй вход регистрации)", () => {
    const runtime = new AgentRuntime(
      createSessionId("task-alias-disallow-refresh"),
      { taskType: "interactive", toolDisallowlist: ["Agent"] },
      {
        subagentPort: {} as never,
        toolRegistry: createToolRegistry(),
        eventStore: createTestSessionEventStore(),
      },
    );
    expect(providerVisibleToolNames(runtime)).not.toContain("Task");

    expect(runtime.initializeSessionShellEnvironmentIfNeeded(CMD_SHELL_SELECTION)).toBe(true);

    expect(runtime.getToolRegistry().has("Agent")).toBe(false);
    expect(runtime.getToolRegistry().has("Task")).toBe(false);
    expect(providerVisibleToolNames(runtime)).not.toContain("Task");
  });

  it("без disallow Agent и Task остаются provider-visible (регрессия B1)", () => {
    const result = runtimeDisallowedToolNames("interactive", []);
    expect(result.visible).toContain("Agent");
    expect(result.visible).toContain("Task");
    expect(result.registered).toContain("Agent");
    expect(result.registered).toContain("Task");
  });

  it("disallow других инструментов не задевает пару Agent/Task", () => {
    const result = runtimeDisallowedToolNames("interactive", ["CronCreate"]);
    expect(result.visible).toContain("Agent");
    expect(result.visible).toContain("Task");
  });
});

// Permission boundary: context.toolName приходит именем конкретной записи, поэтому прямой или
// hook-инициированный вызов Task обязан получать тот же deny, что и Agent. Проверяем на
// реальном PermissionService с alwaysAsk-capability — там rule.disallowedTools стоит до ask.
describe("PermissionService: disallowlist Agent/Task закрывает alias", () => {
  const alwaysAskCapability = {
    alwaysAsk: true,
    readOnly: true,
    sideEffectScope: "none" as const,
    needsApproval: false,
  };

  function check(disallowed: string[], toolName: string) {
    const service = new PermissionService({
      allowedTools: new Set(),
      allowMediumRiskInAutoMode: false,
      autoApproveHighRisk: false,
      disallowedTools: new Set(disallowed),
    });
    return service.checkPermission(
      { input: {}, mode: "build", riskLevel: "low", toolName },
      alwaysAskCapability,
    );
  }

  it.each([
    { disallowed: ["Agent"], invoked: "Task" },
    { disallowed: ["Task"], invoked: "Agent" },
  ])("$disallowed denies $invoked by rule.disallowedTools", ({ disallowed, invoked }) => {
    expect(check(disallowed, invoked)).toMatchObject({
      decision: "deny",
      ruleId: "rule.disallowedTools",
    });
  });

  it("разрешённая пара не получает deny: Task доходит до обычного alwaysAsk", () => {
    expect(check([], "Task")).toMatchObject({ decision: "ask", ruleId: "tool.alwaysAsk" });
  });

  it("disallow другого инструмента не блокирует Task", () => {
    expect(check(["CronCreate"], "Task")).toMatchObject({
      decision: "ask",
      ruleId: "tool.alwaysAsk",
    });
  });

  // Второй и третий call-site в checkPermission: обычная (build) ветка и ветка
  // requiresUserInteraction. Обе обязаны отвечать так же, как для Agent.
  it("build-ветка без alwaysAsk тоже блокирует alias по rule.disallowedTools", () => {
    const service = new PermissionService({
      allowedTools: new Set(),
      allowMediumRiskInAutoMode: false,
      autoApproveHighRisk: false,
      disallowedTools: new Set(["Agent"]),
    });
    expect(
      service.checkPermission({ input: {}, mode: "build", riskLevel: "low", toolName: "Task" }),
    ).toMatchObject({ decision: "deny", ruleId: "rule.disallowedTools" });
    expect(
      service.checkPermission({ input: {}, mode: "build", riskLevel: "low", toolName: "Bash" }),
    ).not.toMatchObject({ ruleId: "rule.disallowedTools" });
  });

  it("requiresUserInteraction-ветка блокирует alias до ask", () => {
    const service = new PermissionService({
      allowedTools: new Set(),
      allowMediumRiskInAutoMode: false,
      autoApproveHighRisk: false,
      disallowedTools: new Set(["Task"]),
    });
    expect(
      service.checkPermission(
        { input: {}, mode: "build", riskLevel: "low", toolName: "Agent" },
        { requiresUserInteraction: true },
      ),
    ).toMatchObject({ decision: "deny", ruleId: "rule.disallowedTools" });
  });

  // Реальная capability записи Task (permission: subagent, readOnly), а не синтетическая:
  // в build-режиме без запрета она даёт allow, с запретом Agent — deny.
  it("блокирует Task с фактической capability записи из registry", () => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry, { includeAgent: true, includeTaskAlias: true });
    const taskEntry = registry.get("Task");
    expect(taskEntry).toBeDefined();
    const capability = {
      ...taskEntry!.permission,
      readOnly: taskEntry!.metadata.readOnly,
      sideEffectScope: taskEntry!.metadata.sideEffectScope,
      riskLevel: taskEntry!.metadata.riskLevel,
      needsApproval: taskEntry!.metadata.needsApproval,
    };

    const allowed = new PermissionService({
      allowedTools: new Set(),
      allowMediumRiskInAutoMode: false,
      autoApproveHighRisk: false,
      disallowedTools: new Set(),
    });
    expect(
      allowed.checkPermission(
        { input: {}, mode: "build", riskLevel: "low", toolName: "Task" },
        capability,
      ),
    ).toMatchObject({ decision: "allow" });

    const denied = new PermissionService({
      allowedTools: new Set(),
      allowMediumRiskInAutoMode: false,
      autoApproveHighRisk: false,
      disallowedTools: new Set(["Agent"]),
    });
    expect(
      denied.checkPermission(
        { input: {}, mode: "build", riskLevel: "low", toolName: "Task" },
        capability,
      ),
    ).toMatchObject({ decision: "deny", ruleId: "rule.disallowedTools" });
  });
});

// docs/specs/task-alias-visibility.md「Alias-развёртывание disallowlist на трёх границах」,
// TASKALIAS-09/10.
//
// Подтверждённый дефект: buildTurnDisallowedTools проверял `has("Agent") || has("Task")`
// inline и не разбирал rule syntax, поэтому turn-level `["Agent(*)"]` не скрывал Task,
// хотя registration и permission boundary уже разворачивали правило через общий helper.
// Тест идёт через публичный getTurnTools, а не через приватный buildTurnDisallowedTools.
describe("turn boundary: Agent/Task disallowlist использует общий helper", () => {
  const turnTools = ["Agent", "Task", "Bash", "Read"];

  function stateOf(toolDisallowlist?: readonly string[]): RegularTurnLoopState {
    return { toolDisallowlist, turnTraceContext: {} } as unknown as RegularTurnLoopState;
  }

  function namesAfterTurnDisallow(toolDisallowlist?: readonly string[]): string[] {
    const runtime = {
      config: {},
      getTools: () => turnTools.map((name) => ({ name })),
    } as unknown as AgentRuntimeInternal;
    return getTurnTools(runtime, stateOf(toolDisallowlist)).map((tool) => tool.name);
  }

  it('toolDisallowlist:["Agent(*)"] скрывает оба имени', () => {
    expect(namesAfterTurnDisallow(["Agent(*)"])).toEqual(["Bash", "Read"]);
  });

  it.each(["Agent(*)", "Agent(researcher)", "Task(fork)"])(
    "scoped-правило %s трактуется как полный запрет dispatch-пары",
    (rule) => {
      expect(namesAfterTurnDisallow([rule])).toEqual(["Bash", "Read"]);
      expect(expandSubagentDispatchDisallowRules([rule])).toEqual(
        expect.arrayContaining(["Agent", "Task"]),
      );
    },
  );

  it('toolDisallowlist:["Task"] скрывает оба имени', () => {
    expect(namesAfterTurnDisallow(["Task"])).toEqual(["Bash", "Read"]);
  });

  it('toolDisallowlist:["Bash"] не трогает пару Agent/Task', () => {
    expect(namesAfterTurnDisallow(["Bash"])).toEqual(["Agent", "Task", "Read"]);
  });

  it("обычный turn без disallow сохраняет Agent и Task", () => {
    expect(namesAfterTurnDisallow(undefined)).toEqual(turnTools);
    expect(namesAfterTurnDisallow([])).toEqual(turnTools);
  });
});
