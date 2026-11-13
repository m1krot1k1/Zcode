// Публичный вход upstream E2E helper-ов. Реализация разделена по назначению
// в подкаталоге upstream-provider/: конфигурация окружения, fixture провайдера,
// выбор модели/思考深度 и диагностические утилиты. Имена и поведение прежние.
export {
  UPSTREAM_ALTERNATE_MODEL,
  UPSTREAM_ALTERNATE_PROVIDER_ID,
  UPSTREAM_ALTERNATE_PROVIDER_NAME,
  UPSTREAM_MODEL,
  UPSTREAM_MODEL_VALUES,
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_PROVIDER_NAME,
  UPSTREAM_PROVIDER_NAV_KEY,
  UPSTREAM_SECONDARY_MODEL,
  UPSTREAM_SECONDARY_THOUGHT_LEVEL,
  UPSTREAM_THOUGHT_LEVEL,
  getUpstreamApiKey,
  getUpstreamProviderModelValues,
  getUpstreamThoughtLevelLabels,
} from "./upstream-provider/config.js";
export {
  getSelectedUpstreamModelLabel,
  selectRegistryProviderModelById,
  selectUpstreamModel,
  selectUpstreamModelById,
  selectUpstreamProviderModelById,
  waitForModelSwitchIdle,
  waitForUpstreamModelSelected,
} from "./upstream-provider/model-selection.js";
export {
  ensureUpstreamModelForE2E,
  ensureUpstreamProviderForE2E,
} from "./upstream-provider/provider-fixture.js";
export {
  getSelectedUpstreamThoughtLevelLabel,
  selectUpstreamThoughtLevel,
  selectUpstreamThoughtLevelValue,
  waitForUpstreamThoughtLevelSelectedValue,
} from "./upstream-provider/thought-level.js";
