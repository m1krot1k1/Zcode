import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createInMemorySessionEventStore, createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  type AgentRuntime,
  type AgentRuntimeInternal,
  PermissionService,
  defaultPermissionConfig,
} from "@zcode/core";
import { createModelTelemetry } from "@zcode/telemetry";
import { createRootTraceContext, createSessionId } from "@zcode/contracts";
import {
  createScriptWorkflowAgentRuntime,
  type ScriptWorkflowAgentRuntimeDeps,
} from "../src/app/script-workflow-child-runtime.js";
import { createTestAgentRuntime, createTestModelFactory } from "./helpers/test-agent-runtime.js";

/**
 * Дочерние runtime обязаны получить объявленные факты модели (`modelFacts`).
 *
 * Bug 根因（2026-11-28, живой симптом владельца): гейт перехвата отказа читает допустимый
 * `reasoningLevel` из `runtime.modelFacts`. В главной сессии порт есть, а в дочерних runtime —
 * нет: `script-workflow-child-runtime.ts` и `workflow-facade.ts` его не передавали, а
 * `subagent/port.ts` не пробрасывал. Без фактов `takeoverModelOptions` возвращает опции без
 * уровня → `modelFactory` бросает `invalid_model_request` → честная ветка пробрасывает ошибку →
 * orchestrator уходит на raw-путь, где tools не передаются вовсе, и резервная модель отвечает
 * текстом. Ровно «стала или нет? не стала», но только в /start, swarm и субагентах.
 *
 * Класс тот же, что и у четырёх предыдущих швов: факт измерен в одном месте и не доехал до
 * решения на границе — на этот раз через конструктор дочернего runtime.
 */
describe("child runtime inherits modelFacts", () => {
  const parentSessionId = createSessionId("facts-parent");
  let tempRoot: string;
  let sessionStore: ReturnType<typeof createSqliteSessionStore>;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "zcode-facts-"));
    sessionStore = createSqliteSessionStore({ path: join(tempRoot, "sessions.sqlite") });
  });

  afterEach(async () => {
    await rm(tempRoot, { force: true, recursive: true });
  });

  const FACTS = {
    optionSpecs: () => ({ reasoningLevel: { values: ["low"] } }),
    supportsToolCall: () => true,
  } as never;

  function parentRuntime(): AgentRuntime {
    return createTestAgentRuntime(
      parentSessionId,
      { workingDirectory: tempRoot },
      {
        eventStore: createInMemorySessionEventStore(),
        sessionStore,
        modelFactory: createTestModelFactory({}),
      } as never,
    );
  }

  function deps(runtime: AgentRuntime): ScriptWorkflowAgentRuntimeDeps {
    return {
      agentTelemetry: createModelTelemetry().agentExecution,
      appOptions: { env: {} },
      appVersion: "0.0.0-test",
      configResult: {
        config: {
          features: { skill: false },
          modelStream: { idleTimeoutMs: 0 },
          network: {},
          skillOverrides: {},
          skills: { enabled: false, roots: [] },
        },
      },
      fileSystemPort: createNodeFileSystemAdapter(),
      imageProcessorPort: {},
      logger: undefined,
      modelFactory: createTestModelFactory({}),
      modelFacts: FACTS,
      permissionService: new PermissionService(defaultPermissionConfig),
      runtime,
      runtimeConfig: { workingDirectory: tempRoot },
      sessionId: parentSessionId,
      sessionStore,
      storageRoot: tempRoot,
      workingDirectory: tempRoot,
    } as unknown as ScriptWorkflowAgentRuntimeDeps;
  }

  function factsOf(runtime: AgentRuntime): unknown {
    return (runtime as unknown as AgentRuntimeInternal).modelFacts;
  }

  it("script workflow child (legacy workflow + dwf actor) получает тот же порт фактов", () => {
    const runtime = parentRuntime();
    const child = createScriptWorkflowAgentRuntime({
      childSessionId: createSessionId("facts-child-legacy"),
      deps: deps(runtime),
      request: { opts: {} } as never,
      traceContext: createRootTraceContext({ sessionId: parentSessionId }),
    });

    // Идентичность, а не «похожий объект»: порт читает registry владельца, второй экземпляр
    // означал бы вторую проекцию одних и тех же фактов.
    expect(factsOf(child)).toBe(FACTS);
  });

  it("dwf actor с configOverrides тоже сохраняет факты", () => {
    const runtime = parentRuntime();
    const child = createScriptWorkflowAgentRuntime({
      childSessionId: createSessionId("facts-child-actor"),
      configOverrides: { workflowActor: { name: "reviewer", persona: "You review." } },
      deps: deps(runtime),
      request: { opts: {} } as never,
      traceContext: createRootTraceContext({ sessionId: parentSessionId }),
    });

    expect(factsOf(child)).toBe(FACTS);
  });

  /**
   * `workflow-facade.ts` раньше принимал `modelFacts` в `CreateWorkflowFacadeDeps` и молча
   * выбрасывал: `create-app-surface.ts` его присылал, объявление было, передачи в
   * `new AgentRuntime(...)` — нет. Поведенчески это не наблюдаемо без сборки целого app
   * (facade требует telemetry, config, MCP, permission-сервис и десяток портов), поэтому
   * проверяется само место конструирования, и это ограничение названо прямо.
   *
   * Что доказывает тест: объект deps для `new AgentRuntime(...)` внутри createWorkflowChildRuntime
   * содержит модель-факты из `deps`. Что НЕ доказывает: что порт реально читает registry —
   * это доказывает первый тест на живом child runtime script-workflow-пути.
   */
  it("workflow-facade передаёт modelFacts в конструктор child runtime", () => {
    const facade = readFileSync(
      new URL("../src/app/workflow-facade.ts", import.meta.url),
      "utf8",
    );
    const childRegion = facade.slice(facade.indexOf("function createWorkflowChildRuntime"));
    const constructorRegion = childRegion.slice(childRegion.indexOf("new AgentRuntime("));

    // Только регион конструктора: объявление поля в `CreateWorkflowFacadeDeps` тоже содержит
    // это слово, и проверка по всему файлу проходила бы при пустой передаче.
    expect(constructorRegion).toContain("modelFacts: deps.modelFacts");
  });

  /**
   * То же для субагентского порта: `subagent/port.ts` конструирует child runtime внутри
   * `run()`, и `modelFacts` там не передавался вовсе. Здесь проверяется строка передачи;
   * полный прогон субагента живёт в subagent-explore.test.ts и не различает этот шов.
   */
  it("subagent port передаёт modelFacts в конструктор child runtime", () => {
    const port = readFileSync(
      new URL(
        "../../core/src/runtime/methods/subagent/port.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const constructorRegion = port.slice(port.indexOf("const childRuntime = new AgentRuntime("));

    expect(constructorRegion).toContain("modelFacts: this.modelFacts");
  });
});
