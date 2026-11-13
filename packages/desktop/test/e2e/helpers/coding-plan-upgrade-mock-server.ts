// Публичный вход E2E-фикстуры Coding Plan: реализация разложена по модулям
// в ./coding-plan-upgrade-mock-server/, здесь сохраняется прежний API.
export {
  resolveCodingPlanUpgradeMockScenario,
  shouldPrepareCodingPlanUpgradeMockForBuild,
  type CodingPlanUpgradeMockRequest,
  type CodingPlanUpgradeMockScenario,
  type CodingPlanUpgradeMockServer,
} from "./coding-plan-upgrade-mock-server/contracts.js";
export {
  resetCodingPlanUpgradeMockServer,
  startCodingPlanUpgradeMockServer,
} from "./coding-plan-upgrade-mock-server/server.js";
