import type { ComposerInitialConfig } from "@/store/zcodeSessionStoreTypes.js";
import type { ModelSelectionView } from "@zcode/services";
import { isEmbeddingOnlyModelId } from "@zcode/shared";
import {
  firstSelectableModelSelection,
  readComposerRecent,
  resolveDraftInitialModelSelection,
} from "@/lib/composerRecent.js";
import {
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
  type ComposerScope,
  resolveComposerScope,
  readComposerWorkspaceScope,
} from "@/v4/composer/composerDraftStore.js";

/** 普通新任务与首次分享导入共用初始化；保留 Recent 原意图，由公共 View 解析有效选择。 */
export function initializeNewTaskDraft(
  draft: V4ComposerDraft,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  view: ModelSelectionView,
  scope?: ComposerScope,
): V4ComposerDraft {
  const recent = readComposerRecent(workspacePath, workspaceIdentity, undefined, scope);
  const recentSelection = recent?.modelSelection ?? null;
  const resolved = resolveDraftInitialModelSelection(view, recentSelection);
  // Recent может указывать на провайдера, которого ещё нет в текущем каталоге (аккаунт
  // переключился/каталог не догрузился). Не теряем исходный intent в draft: View отдельно
  // отдаёт effectiveSelection, а запись текста должна сохранить именно выбор пользователя.
  // Аккаунт мог смениться, а сама модель остаться в каталоге под другим Provider.
  // В этом случае сохраняем пользовательский intent: View отдельно вычислит effective
  // selection. Если же модели больше нет ни у одного Provider — заменяем на первый
  // доступный, иначе новый черновик останется с несуществующим выбором.
  const modelStillExists = recentSelection
    ? view.providers.some((provider) =>
        provider.models.some((model) => model.modelId === recentSelection.modelId),
      )
    : false;
  const rememberedSelection =
    resolved.selection ??
    (recentSelection &&
    modelStillExists &&
    !isEmbeddingOnlyModelId(recentSelection.modelId)
      ? recentSelection
      : null);
  return {
    ...draft,
    mode: recent?.mode === "plan" ? "build" : (recent?.mode ?? "build"),
    planEnabled: false,
    modelSelection:
      rememberedSelection ?? firstSelectableModelSelection(view) ?? undefined,
  };
}

/** 首次导入由导航动作显式传参；复用历史或已有文字草稿不覆盖。 */
export function resolveImportedComposerConfig(
  result: {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionId: string;
    reused: boolean;
  },
  clientNamespace = "desktop",
): ComposerInitialConfig | undefined {
  const { workspacePath, workspaceIdentity, sessionId, reused } = result;
  if (reused || readV4ComposerDraft(workspacePath, workspaceIdentity, sessionId)) return undefined;
  const scope =
    readComposerWorkspaceScope(workspacePath, workspaceIdentity, clientNamespace) ??
    resolveComposerScope(null, workspaceIdentity, clientNamespace);
  const root = readV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT, scope);
  return root?.mode
    ? {
        mode: root.mode,
        planEnabled: root.planEnabled ?? false,
        modelSelection: root.modelSelection,
      }
    : {};
}
