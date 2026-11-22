/// <reference types="node" />
// ============================================================
// Этап 5: стресс-тест конкурентности субагентов Swarm (Инкремент 4.1)
// ============================================================
//
// Проверяемые инварианты `WorkLedger` (единственный владелец write-claim'ов):
//  1. Параллельные субагенты с общими writePaths получают конфликт, а не
//     перезапись: ровно один победитель на путь, остальные — `write_claim_conflict`.
//  2. Субагенты с непересекающимися путями запускаются все, без ложных конфликтов.
//  3. DAG-волны: следующий слой стартует только после release предыдущего;
//     бюджет claim'ов не «залипает» между волнами.
//  4. Отмена в середине освобождает claim, и путь снова доступен.
//  5. Нет накопления claim'ов (утечки состояния) после сотен циклов claim/release.

import { describe, expect, it } from "vitest";
import { WorkLedger } from "../src/runtime-task/work-ledger.js";

const WORKSPACE = "/swarm/workspace";

/** Ledger без записи на диск: стресс-тест не должен трогать ~/.zcode. */
function createLedger(): WorkLedger {
  return new WorkLedger({ journalPath: null });
}

function claim(
  ledger: WorkLedger,
  agentId: string,
  paths: readonly string[],
  intent = `work ${agentId}`,
) {
  return ledger.claim({ workspacePath: WORKSPACE, agentId, intent, paths });
}

describe("Этап 5 — стресс конкурентности субагентов Swarm", () => {
  it("32 субагента с общим writePath: ровно один выигрывает claim", () => {
    const ledger = createLedger();
    const count = 32;
    const sharedPath = "src/shared.ts";

    // Первый claim создаёт владельца; последующие видят конфликт.
    const results = Array.from({ length: count }, (_, index) =>
      claim(ledger, `agent-${index}`, [sharedPath]),
    );

    const winners = results.filter((result) => result.conflicts.length === 0);
    const conflicted = results.filter((result) => result.conflicts.length > 0);
    expect(winners).toHaveLength(1);
    expect(conflicted).toHaveLength(count - 1);
    // Конфликт всегда указывает на держателя и конкретный путь.
    for (const result of conflicted) {
      expect(result.conflicts[0]?.path).toContain("shared.ts");
      expect(result.conflicts[0]?.holders[0]?.agentId).toBe("agent-0");
    }

    console.info(
      `[stress][swarm][shared-path] n=${count} winners=${winners.length} conflicts=${conflicted.length}`,
    );
  }, 30_000);

  it("24 субагента с непересекающимися writePaths не конфликтуют", () => {
    const ledger = createLedger();
    const count = 24;

    const results = Array.from({ length: count }, (_, index) =>
      claim(ledger, `solo-${index}`, [`src/module-${index}.ts`]),
    );

    expect(results.every((result) => result.conflicts.length === 0)).toBe(true);
    console.info(`[stress][swarm][disjoint] n=${count} conflicts=0`);
  }, 30_000);

  it("DAG-волны: следующий слой стартует после release предыдущего", () => {
    const ledger = createLedger();
    const waves = 4;
    const perWave = 6;
    const conflictCounts: number[] = [];

    for (let wave = 0; wave < waves; wave += 1) {
      const results = Array.from({ length: perWave }, (_, index) =>
        claim(ledger, `wave${wave}-agent${index}`, ["src/shared-dag.ts"]),
      );
      conflictCounts.push(results.filter((result) => result.conflicts.length > 0).length);
      // Освобождаем всю волну, кроме последней: волна N+1 должна видеть чистый путь.
      for (let index = 0; index < perWave; index += 1) {
        ledger.release(`wave${wave}-agent${index}`);
      }
    }

    // В каждой волне конфликтуют все, кроме первого.
    expect(conflictCounts).toEqual(
      Array.from({ length: waves }, () => perWave - 1),
    );
    // После последнего release путь снова свободен.
    expect(ledger.findConflicts({ workspacePath: WORKSPACE, paths: ["src/shared-dag.ts"] })).toEqual(
      [],
    );

    console.info(
      `[stress][swarm][dag] waves=${waves} perWave=${perWave} conflictsPerWave=${conflictCounts.join(",")}`,
    );
  }, 30_000);

  it("отмена в середине волны освобождает writePaths", () => {
    const ledger = createLedger();
    const path = "src/cancel-target.ts";

    const first = claim(ledger, "cancel-owner", [path]);
    expect(first.conflicts).toEqual([]);
    // Пока владелец активен — путь занят.
    expect(ledger.findConflicts({ workspacePath: WORKSPACE, paths: [path] })).toHaveLength(1);

    const released = ledger.release("cancel-owner");
    expect(released).toHaveLength(1);
    expect(released[0]?.status).toBe("released");
    // После отмены путь свободен и новый субагент проходит.
    expect(ledger.findConflicts({ workspacePath: WORKSPACE, paths: [path] })).toEqual([]);
    expect(claim(ledger, "cancel-retry", [path]).conflicts).toEqual([]);

    console.info(`[stress][swarm][cancel] released=${released.length} pathReusable=true`);
  }, 30_000);

  it("нет накопления claim'ов после 500 циклов claim + release", () => {
    const ledger = createLedger();
    const path = "src/loop.ts";

    for (let index = 0; index < 500; index += 1) {
      const agentId = `loop-${index}`;
      claim(ledger, agentId, [path]);
      ledger.release(agentId);
    }

    // Ни одного активного claim'а: путь свободен, конфликтов нет.
    expect(ledger.findConflicts({ workspacePath: WORKSPACE, paths: [path] })).toEqual([]);
    expect(ledger.list({ status: "active" })).toHaveLength(0);

    console.info("[stress][swarm][leaks] cycles=500 activeClaims=0");
  }, 60_000);
});
