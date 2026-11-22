import { buildContextAndNetworkScenarios } from "./scenarioContextAndNetwork.js";
import { buildErrorAndIdentityScenarios } from "./scenarioErrorsAndIdentity.js";
import { buildToolAndTimingScenarios } from "./scenarioToolsAndTiming.js";
import { buildTurnScenarios } from "./scenarioTurns.js";
import type { ConversationTelemetryParityScenario } from "./types.js";

// 19 个差分 case 的受控输入按主题拆分到同目录模块，由本文件按 TDP01→TDP19 的顺序拼接；
// 新旧驱动共用同一份定义，避免各自复制后悄悄漂移。
function buildScenarios(): ConversationTelemetryParityScenario[] {
  return [
    ...buildTurnScenarios(),
    ...buildToolAndTimingScenarios(),
    ...buildContextAndNetworkScenarios(),
    ...buildErrorAndIdentityScenarios(),
  ];
}

const SCENARIOS = new Map(buildScenarios().map((item) => [item.caseId, item]));

export function getConversationTelemetryParityScenario(
  caseId: string,
): ConversationTelemetryParityScenario {
  const found = SCENARIOS.get(caseId);
  if (!found) {
    throw new Error(`Unknown conversation telemetry parity case: ${caseId}`);
  }
  return found;
}
