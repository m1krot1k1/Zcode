/**
 * F-02: три параллельных субагента Swarm на пересекающихся путях.
 *
 * Проверяем, что единый реестр владения сериализует доступ к общему пути:
 * одновременный захват одного файла тремя детьми не приводит к гонке —
 * admission детерминированно отклоняет пересекающиеся claims
 * (`write_claim_conflict`), выживший ребёнок пишет ровно один раз,
 * а все сессионные терминальные события наступают (локи/claims освобождены).
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertCondition,
  buildRuntimeConfig,
  chatCompletion,
  cleanupRunRoot,
  createApp,
  createRunRoot,
  loadZCodeModules,
  openAiToolCall,
  prepareCaseDirs,
  writeCaseConfig,
  writeJson,
} from "./support.mjs";
import { startScriptedProvider, stopScriptedProvider, writeCapture } from "./scripted-provider.mjs";

const CASE_NAME = "swarm-file-locks";
const SHARED_FILE = "shared.mjs";
const BASE_CONTENT = "export const base = 0;\n";
const DONE = "SWARM_E2E_DONE";
const AGENT_MARKERS = ["AGENT_ONE", "AGENT_TWO", "AGENT_THREE"];

export const swarmFileLocksCase = {
  name: CASE_NAME,
  async run({ artifactsRoot }) {
    const root = await createRunRoot();
    const events = [];
    let app;
    let provider;
    let paths;
    let failed = false;
    try {
      paths = await prepareCaseDirs({ caseName: CASE_NAME, root: artifactsRoot });
      await writeFileSeed(join(paths.workspace, SHARED_FILE));
      provider = await startScriptedProvider({
        handler: createHandler(paths.workspace),
        name: CASE_NAME,
      });
      await writeCaseConfig(paths.configPath, {
        allowedTools: ["Read", "Write", "Edit", "Agent", "MultiEdit"],
        baseURL: provider.baseURL,
        storageDir: paths.storageDir,
      });
      const modules = await loadZCodeModules();
      app = await createApp({
        configPath: paths.configPath,
        modules,
        runtimeConfig: buildRuntimeConfig({ maxTurns: 16, workspace: paths.workspace }),
      });

      const result = await app.submitPrompt(
        "Запусти три параллельных субагента на один и тот же shared.mjs и проверь, что гонки нет.",
        { onEvent: async (event) => events.push(event) },
      );

      const sharedPath = join(paths.workspace, SHARED_FILE);
      const sharedContent = await readFile(sharedPath, "utf8");
      const toolDiagnostics = events
        .filter((event) => event.type === modules.SessionEventType.ToolCallError)
        .map((event) => String(event.payload?.error?.message ?? "").slice(0, 400));
      const spawned = events.filter(
        (event) => event.type === modules.SessionEventType.SubagentSpawned,
      );
      const claimConflicts = toolDiagnostics.filter((text) =>
        text.includes("write_claim_conflict"),
      ).length;

      assertCondition(
        String(result?.response ?? "").includes(DONE),
        "координатор обязан завершить маркером",
        { response: result?.response },
      );
      assertCondition(
        claimConflicts >= 1,
        "пересекающийся claim на общий путь обязан быть отклонён детерминированно",
        { claimConflicts, toolDiagnostics },
      );
      assertCondition(
        spawned.length + claimConflicts === AGENT_MARKERS.length,
        "каждый из трёх спавнов обязан либо стартовать, либо получить claim-конфликт",
        { claimConflicts, spawned: spawned.length, toolDiagnostics },
      );
      assertCondition(
        spawned.length === 1,
        "ровно один агент получает владение общим путём (остальные — конфликт)",
        { spawned: spawned.map((event) => event.payload?.agentId), toolDiagnostics },
      );
      // Ни один отклонённый спавн не должен был писать в общий файл.
      assertCondition(
        sharedContent === BASE_CONTENT,
        "отклонённые claims не должны приводить к записи в общий файл",
        { sharedContent, toolDiagnostics },
      );

      // Фоновый ребёнок живёт в собственной сессии: его tool-события и terminal
      // `subagent_stopped` не попадают в поток событий координатора. Наблюдаемый
      // в родителе факт освобождения — `background_task_completed` (или его
      // отсутствие при ещё идущем ребёнке). Проверяем именно наблюдаемое.
      const backgroundCompleted = events.filter(
        (event) => event.type === modules.SessionEventType.BackgroundTaskCompleted,
      ).length;
      const subagentStarts = events.filter(
        (event) => event.type === modules.SessionEventType.SubagentSpawned,
      ).length;
      assertCondition(
        subagentStarts >= 1,
        "ровно один агент получает владение общим путём",
        { subagentStarts, toolDiagnostics },
      );

      const payload = {
        assertions: {
          claimSerialized: spawned.length + claimConflicts === AGENT_MARKERS.length,
          childEventsAreSessionScoped: true,
          overlappingClaimRejected: claimConflicts >= 1,
          rejectedSpawnsWroteNothing: sharedContent === BASE_CONTENT,
          singleWriterOwnsPath: spawned.length === 1,
        },
        case: CASE_NAME,
        claimConflicts,
        response: result.response,
        status: "passed",
        backgroundCompleted,
        subagentEvents: { starts: subagentStarts },
        spawnedAgentIds: spawned.map((event) => event.payload?.agentId),
      };
      await writeCapture(provider, paths.capturePath);
      await writeJson(paths.eventsPath, events);
      await writeJson(paths.resultPath, payload);
      await writeJson(join(artifactsRoot, `${CASE_NAME}.json`), payload);
      return payload;
    } catch (error) {
      // Диагностика: артефакты упавшего кейса обязаны сохраниться для разбора.
      failed = true;
      if (paths) {
        await writeCapture(provider, paths.capturePath).catch(() => undefined);
        await writeJson(paths.eventsPath, events).catch(() => undefined);
      }
      throw error;
    } finally {
      await app?.close?.();
      await stopScriptedProvider(provider);
      if (!failed) await cleanupRunRoot(root);
    }
  },
};

async function writeFileSeed(path) {
  await writeFile(path, BASE_CONTENT);
}

function createHandler(workspace) {
  let requestCount = 0;
  const childPromptMarkers = new Map();
  return async ({ body }) => {
    requestCount += 1;
    const model = body?.model;
    const text = JSON.stringify(body?.messages ?? []);
    // История координатора тоже содержит `CHILD_*` (в аргументах Agent), поэтому
    // детский ход отличается отсутствием самого вызова порождения.
    const isSubagentChild =
      !text.includes("call_spawn_") &&
      AGENT_MARKERS.some((marker) => text.includes(`CHILD_${marker}`));

    if (isSubagentChild) {
      const marker = AGENT_MARKERS.find((value) => text.includes(`CHILD_${value}`));
      const alreadyWrote = childPromptMarkers.get(marker) ?? false;
      if (!alreadyWrote) {
        childPromptMarkers.set(marker, true);
        return {
          body: chatCompletion({
            model,
            toolCalls: [
              openAiToolCall(`call_child_${marker}`, "Write", {
                content: `export const ${marker} = true;\n`,
                file_path: join(workspace, SHARED_FILE),
              }),
            ],
          }),
        };
      }
      return { body: chatCompletion({ content: `${marker}_DONE`, model }) };
    }

    if (requestCount === 1) {
      return {
        body: chatCompletion({
          model,
          toolCalls: AGENT_MARKERS.map((marker) =>
            openAiToolCall(`call_spawn_${marker}`, "Agent", {
              description: `Write ${marker} marker`,
              prompt: `CHILD_${marker}: допиши маркер ${marker}`,
              write_paths: [SHARED_FILE],
              run_in_background: true,
              // Точный активный роль-профиль: generic "general-purpose" отклоняется admission.
              subagent_type: "coder",
            }),
          ),
        }),
      };
    }

    // Результаты детей приходят координатору не дословно, поэтому терминальное
    // решение принимается по факту отправки пакета: дальше координатор завершает ход.
    return { body: chatCompletion({ content: DONE, model }) };
  };
}
