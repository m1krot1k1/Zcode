/**
 * Workspace slice: действия над состоянием workspace (активная задача, composer,
 * черновик, провайдер, инициализация, model switch, конфигурация, список задач).
 *
 * Реализация разложена по модулям в ./workspace-slice; файл остаётся публичным
 * barrel'ом. Порядок ключей сохраняется как в исходном монолитном slice, чтобы
 * состав и порядок мутаций store не менялись.
 */
import { createConfigActions } from "./workspace-slice/config.js";
import { createComposerActions } from "./workspace-slice/composer.js";
import { createDraftActions } from "./workspace-slice/draft.js";
import { createModelSwitchActions } from "./workspace-slice/model-switch.js";
import { createProviderActions } from "./workspace-slice/provider.js";
import { createTaskListActions } from "./workspace-slice/task-list.js";
import { createTaskNavigationActions } from "./workspace-slice/task-navigation.js";
import type { WorkspaceSliceSet } from "./workspace-slice/types.js";
import { createWorkspaceInitActions } from "./workspace-slice/workspace-init.js";

export function createWorkspaceSlice(set: WorkspaceSliceSet) {
  return {
    ...createTaskNavigationActions(set),
    ...createComposerActions(set),
    ...createDraftActions(set),
    ...createProviderActions(set),
    ...createWorkspaceInitActions(set),
    ...createModelSwitchActions(set),
    ...createConfigActions(set),
    ...createTaskListActions(set),
  };
}
