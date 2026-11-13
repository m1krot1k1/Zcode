import type { WorkConflict } from "./work-ledger.js";
import { normalizeWorkspacePath } from "./work-ledger.js";
import {
  extractTaskPaths,
  forgetWorkClaimHeartbeat,
  heartbeatWorkClaim,
  summarizeWorkIntent,
} from "./work-ledger-wire.js";
import type { RegistryState } from "./registry-state.js";
import type { RuntimeTaskSnapshot } from "./registry-types.js";

export type WorkClaimAdmission =
  | { accepted: true; claimed: boolean }
  | { accepted: false; reason: "write_claim_conflict" | "work_claim_unavailable" };

/**
 * Text-derived путь, который после нормализации совпадает с корнем workspace.
 * Ledger канонизирует корень в "."; используем его же нормализацию, чтобы фильтр
 * admission'а не расходился с conflict-check. Некорректный кандидат не отбрасываем:
 * ledger сам отвергнет его, сохраняя прежний fail-closed контракт.
 */
function resolvesToWorkspaceRoot(path: string, workspacePath: string): boolean {
  try {
    return normalizeWorkspacePath(path, workspacePath) === ".";
  } catch {
    return false;
  }
}

/**
 * Registrar hard gate: проверяет пересечение путей с живыми claim'ами и создаёт claim.
 * Конфликт или недоступность ledger'а отклоняют admission до любых мутаций состояния.
 * Без ledger'а/workspace gate выключен (обратная совместимость).
 */
export function admitWorkClaim(
  state: RegistryState,
  task: RuntimeTaskSnapshot,
  parentAgentId: string | null,
): WorkClaimAdmission {
  const ledger = state.workLedger;
  const workspacePath = task.workspacePath?.trim();
  if (!ledger || !workspacePath) return { accepted: true, claimed: false };
  // 根因: read-only профили (researcher/reviewer/evaluator и т.п.) не пишут файлы, но их
  // prompt-пути трактовались как write-intent: параллельные исследователи с общим файлом
  // падали с write_claim_conflict. Write-capability приходит из профиля, а не из текста.
  if (task.writeCapable === false) return { accepted: true, claimed: false };
  const text = task.prompt || task.description;
  // 根因 (3.17.75): абсолютный корень workspace в prompt'е (в backticks или голым
  // путём) нормализуется ledger'ом в ".", а "." по контракту pathsOverlap
  // пересекается с любым путём. Один такой spawn создавал claim на весь workspace,
  // и все последующие writers получали write_claim_conflict до истечения TTL.
  // 修复依据: text-derived кандидат, резолвящийся в корень, — не write-intent.
  // Фильтруем только производные текста; явный WorkLedger.claim({ paths: ["."] })
  // сохраняет прежнюю семантику "весь workspace".
  //
  // 根因 (3.17.91): orchestrator копирует общий план веток в каждый branch prompt;
  // text extraction принимал чужие пути за write-intent, и независимые ветки
  // падали с write_claim_conflict. Явный writePaths (включая []) — авторитетный
  // scope; эвристика по тексту остаётся только для legacy-вызовов без поля.
  const paths =
    task.writePaths !== undefined
      ? [
          ...new Set(
            task.writePaths
              .map((path) => path.trim())
              .filter((path) => path.length > 0 && !resolvesToWorkspaceRoot(path, workspacePath)),
          ),
        ]
      : extractTaskPaths(text).filter((path) => !resolvesToWorkspaceRoot(path, workspacePath));
  if (paths.length > 0) {
    let conflicts: WorkConflict[];
    try {
      conflicts = ledger.findConflicts({
        workspacePath,
        paths,
        agentId: task.agentId,
      });
    } catch (error) {
      console.warn(`[work-ledger] не удалось проверить конфликты ${task.agentId}:`, error);
      return { accepted: false, reason: "work_claim_unavailable" };
    }
    if (conflicts.length > 0) {
      // Конфликт теперь блокирует spawn: claim не создаётся, budget не тратится.
      return { accepted: false, reason: "write_claim_conflict" };
    }
  }
  // Пустой intent ядро отклоняет, поэтому fallback — description/agentId.
  const intent = summarizeWorkIntent(text) || task.description.trim() || task.agentId;
  try {
    ledger.claim({
      workspacePath,
      agentId: task.agentId,
      parentAgentId,
      profile: task.agentType,
      intent,
      paths,
      ...(task.rootRunId ? { runId: task.rootRunId } : {}),
      ...(task.attemptId ? { attemptId: task.attemptId } : {}),
    });
    return { accepted: true, claimed: true };
  } catch (error) {
    console.warn(`[work-ledger] не удалось объявить ${task.agentId}:`, error);
    return { accepted: false, reason: "work_claim_unavailable" };
  }
}

export function releaseWorkClaim(state: RegistryState, agentId: string): void {
  const ledger = state.workLedger;
  if (!ledger) return;
  try {
    ledger.release(agentId);
    forgetWorkClaimHeartbeat(ledger, agentId);
  } catch (error) {
    console.warn(`[work-ledger] не удалось снять claim ${agentId}:`, error);
  }
}

/**
 * F5: задача может долго не присылать child-события, но registry знает, что она
 * `running`. Перед sweep продлеваем её claim'ы, иначе TTL сделает путь свободным
 * при живой задаче. Журнал пишется не чаще одного раза на агента за sweep.
 */
export function heartbeatActiveWorkClaims(state: RegistryState, now: number = Date.now()): void {
  const ledger = state.workLedger;
  if (!ledger) return;
  const seen = new Set<string>();
  for (const task of state.tasks.values()) {
    if (task.type !== "local_agent" || task.status !== "running") continue;
    const agentId = task.agentId.trim();
    if (agentId.length === 0 || seen.has(agentId)) continue;
    seen.add(agentId);
    try {
      // intervalMs: 0 — periodic sweep сам задаёт частоту; общий throttle-кеш
      // синхронизирует ручные heartbeat'ы с шагом ребёнка.
      heartbeatWorkClaim(ledger, agentId, { now, intervalMs: 0 });
    } catch (error) {
      console.warn(`[work-ledger] heartbeat ${agentId} failed:`, error);
    }
  }
}

/** Periodic materialization: сначала продлевает живые задачи, затем гасит протухшие. */
export function sweepWorkLedger(state: RegistryState, now: number = Date.now()): void {
  heartbeatActiveWorkClaims(state, now);
  try {
    state.workLedger?.sweepStale(now);
  } catch (error) {
    console.warn("[work-ledger] periodic sweep failed:", error);
  }
}
