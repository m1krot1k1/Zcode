import type { CodeIntelligenceService } from "../code-intelligence/contract.js";
import type { IFileService } from "../file/file.js";
import type { IGitService } from "../git/git.js";
import type {
  PromptEnhancerCapabilityIndexProvider,
  PromptEnhancerModelResolver,
  PromptEnhancerTextGenerator,
} from "../prompt-enhancer/index.js";
import type {
  PromptEnhanceContextPorts,
  PromptEnhanceHistoryPort,
} from "../prompt-enhancer/index.js";
import type { ISkillsService } from "../skills/skills.js";
import type { ISubagentsService } from "../subagents/subagents.js";
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { IZCodeSessionService } from "../zcode-session/zcodeSession.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { buildPromptEnhanceCapabilityIndex } from "@zcode/shared";

/**
 * Проводка `PromptEnhancerService` к Host-портам.
 *
 * Здесь только перевод между контрактом сервиса и существующими сервисами Host'а:
 * никакой бизнес-логики улучшения. Каждый порт остаётся опциональным — при отсутствии
 * (Web-remote без индекса, репозиторий без Git) улучшение продолжает работать на черновике.
 */

const logger = createServiceLogger("prompt-enhancer-ports");

/**
 * Installed capability facts for the enhancer. Skills and user agents are already
 * workspace-scoped and cheap after the first scan; MCP/plugin suggestions stay
 * model-proposed until their own consent-driven install surfaces are used.
 *
 * A short TTL prevents one Settings scan per keystroke and keeps the enhancer on the
 * background queue rather than triggering repeated filesystem walks.
 */
export function createPromptEnhancerCapabilityIndexProvider(input: {
  skillsService: Pick<ISkillsService, "list">;
  subagentsService: Pick<ISubagentsService, "list">;
  now?: () => number;
  ttlMs?: number;
}): PromptEnhancerCapabilityIndexProvider {
  const ttlMs = input.ttlMs ?? 60_000;
  const cache = new Map<
    string,
    { expiresAt: number; entries: ReturnType<typeof buildPromptEnhanceCapabilityIndex> }
  >();
  return {
    async list(params) {
      const key = params.workspaceIdentity?.trim() || params.workspacePath;
      const now = input.now?.() ?? Date.now();
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now) return cached.entries;
      const [skillsResult, agentsResult] = await Promise.allSettled([
        input.skillsService.list({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        }),
        input.subagentsService.list({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          mode: "settingsUserOnly",
        }),
      ]);
      const entries = buildPromptEnhanceCapabilityIndex({
        skills:
          skillsResult.status === "fulfilled"
            ? skillsResult.value.skills.map((skill) => ({
                id: skill.id,
                name: skill.name,
                description: skill.description,
                enabled: skill.enabled,
              }))
            : [],
        agents:
          agentsResult.status === "fulfilled"
            ? agentsResult.value.userAgents.map((agent) => ({
                id: agent.id,
                name: agent.name,
                description: agent.description,
                enabled: agent.enabled,
              }))
            : [],
      });
      cache.set(key, { expiresAt: now + ttlMs, entries });
      logger.debug(undefined, "Prompt enhancer capability index built", {
        workspaceKey: key,
        skillCount: entries.filter((entry) => entry.kind === "skill").length,
        agentCount: entries.filter((entry) => entry.kind === "agent").length,
        skillsFailed: skillsResult.status === "rejected",
        agentsFailed: agentsResult.status === "rejected",
      });
      return entries;
    },
  };
}

/** Лимит сообщений/символов совпадает с контрактом context-collector. */
const HISTORY_MESSAGE_LIMIT = 6;
const HISTORY_SCAN_LIMIT = 20;

export function createPromptEnhancerPaths(input: {
  zcodeAgentService: Pick<IZCodeAgentService, "generateWorkspaceText">;
  providerRuntime?: {
    modelSelection: {
      getView(): Promise<{
        preferredSelection?: unknown;
        providers?: ReadonlyArray<{
          providerId: string;
          models?: ReadonlyArray<{
            modelId: string;
            config?: { optionSpecs?: { reasoningLevel?: { values?: readonly string[] } } };
          }>;
        }>;
      }>;
    };
  };
}): {
  textGenerator: PromptEnhancerTextGenerator;
  modelResolver: PromptEnhancerModelResolver;
} {
  return {
    textGenerator: {
      async generateText(params) {
        const result = await input.zcodeAgentService.generateWorkspaceText({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          selection: params.selection,
          messages: params.messages,
          querySource: params.querySource,
          ...(params.maxOutputTokens ? { maxOutputTokens: params.maxOutputTokens } : {}),
          signal: params.signal,
        });
        return { text: result.text, selection: result.selection };
      },
    },
    modelResolver: {
      async resolveDefaultSelection() {
        // Улучшение — вспомогательная операция: она не должна наследовать тяжёлую модель
        // сессии. Host использует предпочтительное быстрое выделение, если оно задано.
        const view = await input.providerRuntime?.modelSelection.getView().catch(() => null);
        const preferred = view?.preferredSelection as
          | { providerId?: unknown; modelId?: unknown }
          | undefined;
        if (
          !preferred ||
          typeof preferred.providerId !== "string" ||
          typeof preferred.modelId !== "string"
        ) {
          return null;
        }
        // 修复原因：реестр знает допустимые уровни рассуждений конкретной модели, а сервис
        // раньше жёстко ставил `minimal`. Для провайдеров с единственным `disabled`
        // (например opencode-go-messages/minimax-m3) это давало
        // "Reasoning level is required for ..." и кнопка Enhance не работала.
        const providerView = view?.providers?.find(
          (candidate) => candidate.providerId === preferred.providerId,
        );
        const modelView = providerView?.models?.find(
          (candidate) => candidate.modelId === preferred.modelId,
        );
        const reasoningLevels = modelView?.config?.optionSpecs?.reasoningLevel?.values;
        return {
          providerId: preferred.providerId,
          modelId: preferred.modelId,
          ...(Array.isArray(reasoningLevels) ? { reasoningLevels } : {}),
        };
      },
    },
  };
}

/**
 * Сборщик контекста над существующими сервисами. `codeIntelligenceService` в Web/remote
 * отсутствует (индекс — только локальная Desktop-возможность), поэтому порт тоже опционален.
 */
export function createPromptEnhancerContextPorts(input: {
  codeIntelligenceService?: CodeIntelligenceService;
  gitService?: Pick<IGitService, "getChanges">;
  fileService?: Pick<IFileService, "readTextFile">;
  zcodeSessionService?: Pick<IZCodeSessionService, "readSessionMessages">;
}): PromptEnhanceContextPorts {
  const ports: PromptEnhanceContextPorts = {};

  if (input.codeIntelligenceService) {
    const codeIntelligence = input.codeIntelligenceService;
    ports.codeSearch = {
      async search(params) {
        const response = await codeIntelligence.search({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          query: params.query,
          ...(params.limit ? { limit: params.limit } : {}),
          ...(params.maxTokens ? { maxTokens: params.maxTokens } : {}),
          ...(params.activeFiles?.length ? { activeFiles: params.activeFiles } : {}),
          ...(params.changedFiles?.length ? { changedFiles: params.changedFiles } : {}),
        });
        return {
          results: response.results.map((hit) => ({
            path: hit.path,
            startLine: hit.startLine,
            ...(hit.symbolName ? { symbolName: hit.symbolName } : {}),
            score: hit.score,
          })),
        };
      },
    };
  }

  if (input.gitService) {
    const git = input.gitService;
    ports.git = {
      async getChanges(params) {
        const changes = await git.getChanges({
          workspacePath: params.workspacePath,
          sourceId: "unstaged",
        });
        return changes.map((change) => ({ path: change.path }));
      },
    };
  }

  if (input.fileService) {
    const files = input.fileService;
    ports.files = {
      async readTextFile(params) {
        try {
          const slice = await files.readTextFile({ path: params.path, length: 16_384 });
          if (slice.isBinary) return null;
          return { content: slice.content };
        } catch {
          // Отсутствующий AGENTS.md — норма, а не ошибка контекста.
          return null;
        }
      },
    };
  }

  if (input.zcodeSessionService) {
    const sessions = input.zcodeSessionService;
    const history: PromptEnhanceHistoryPort = {
      async readRecentMessages(params) {
        const messages = await sessions.readSessionMessages({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          sessionId: params.sessionId,
          limit: HISTORY_SCAN_LIMIT,
        });
        const recent = messages.slice(-params.limit);
        return recent.flatMap((message) => {
          const role = message.info.role;
          if (role !== "user" && role !== "assistant") return [];
          const text = message.parts
            .filter((part) => part.type === "text")
            .map((part) => (part as { text: string }).text)
            .join(" ")
            .trim();
          if (text.length === 0) return [];
          return [{ role, text: text.slice(0, 800) }];
        });
      },
    };
    ports.history = history;
  }

  logger.debug(undefined, "Prompt enhancer context ports assembled", {
    codeSearch: ports.codeSearch !== undefined,
    git: ports.git !== undefined,
    files: ports.files !== undefined,
    history: ports.history !== undefined,
    historyLimit: HISTORY_MESSAGE_LIMIT,
  });
  return ports;
}
