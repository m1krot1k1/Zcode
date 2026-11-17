import type { CodeIntelligenceService } from "../code-intelligence/contract.js";
import type { IGitService } from "../git/git.js";
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { IZCodeSessionService } from "../zcode-session/zcodeSession.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type {
  ChatAutocompleteContextPorts,
  ChatAutocompleteModelResolver,
  ChatAutocompleteTextGenerator,
} from "./service.js";

/**
 * Проводка `ChatAutocompleteService` к Host-портам.
 *
 * Здесь только перевод между контрактом сервиса и существующими сервисами Host'а:
 * никакой бизнес-логики подсказок. Каждый порт опционален — Web-remote без индекса
 * или репозиторий без Git продолжают отдавать ghost-текст на одном префиксе.
 */

const logger = createServiceLogger("chat-autocomplete-ports");

/** Лимиты совпадают с контрактом сервиса: история и диффы не должны раздувать промпт. */
const HISTORY_SCAN_LIMIT = 12;
const DIFF_SCAN_LIMIT = 24;

export function createChatAutocompletePaths(input: {
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
  textGenerator: ChatAutocompleteTextGenerator;
  modelResolver: ChatAutocompleteModelResolver;
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
        // Ghost-подсказка обязана быть быстрой: наследовать тяжёлую модель сессии нельзя.
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
        // 修复原因: ghost-подсказка раньше уходила с захардкоженным `reasoningLevel: "none"`.
        // Модели с другим набором уровней (например только `disabled`) отклоняли запрос,
        // поэтому сервису нужно передать реальный список из реестра.
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

export function createChatAutocompleteContextPorts(input: {
  codeIntelligenceService?: CodeIntelligenceService;
  gitService?: Pick<IGitService, "getChanges">;
  zcodeSessionService?: Pick<IZCodeSessionService, "readSessionMessages">;
}): ChatAutocompleteContextPorts {
  const ports: ChatAutocompleteContextPorts = {};

  if (input.zcodeSessionService) {
    const sessions = input.zcodeSessionService;
    ports.history = {
      async readRecentMessages(params) {
        // ZCodeSession читает сообщения только по sessionId; без него истории нет.
        if (!params.sessionId) return [];
        const messages = await sessions.readSessionMessages({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          sessionId: params.sessionId,
          limit: HISTORY_SCAN_LIMIT,
        });
        return messages.slice(-params.limit).flatMap((message) => {
          const role = message.info.role;
          if (role !== "user" && role !== "assistant") return [];
          const text = message.parts
            .filter((part) => part.type === "text")
            .map((part) => (part as { text: string }).text)
            .join(" ")
            .trim();
          // Обрезаем: история — подсказка о теме, а не источник для модели.
          return text ? [{ role, text: text.slice(0, 400) }] : [];
        });
      },
    };
  }

  if (input.gitService) {
    const git = input.gitService;
    ports.diffs = {
      async listChangedFiles(params) {
        const changes = await git.getChanges({
          workspacePath: params.workspacePath,
          sourceId: "unstaged",
        });
        return changes
          .slice(0, Math.min(params.limit, DIFF_SCAN_LIMIT))
          .map((change) => change.path);
      },
    };
  }

  if (input.codeIntelligenceService) {
    const codeIntelligence = input.codeIntelligenceService;
    ports.codeSearch = {
      async search(params) {
        const response = await codeIntelligence.search({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          query: params.query,
          limit: params.limit,
          // Ghost-подсказка не должна платить за векторный ранкинг: лексического поиска достаточно.
          lexicalOnly: true,
          maxTokens: 400,
        });
        return response.results.map((hit) => ({
          path: hit.path,
          ...(hit.symbolName ? { symbolName: hit.symbolName } : {}),
        }));
      },
    };
  }

  logger.debug(undefined, "Chat autocomplete context ports assembled", {
    codeSearch: ports.codeSearch !== undefined,
    diffs: ports.diffs !== undefined,
    history: ports.history !== undefined,
  });
  return ports;
}
