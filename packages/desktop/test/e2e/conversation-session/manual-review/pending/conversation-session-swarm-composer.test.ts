import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  getUpstreamRequestEvidence,
  waitForUpstreamRequest,
  type UpstreamRequestQuery,
} from "../../../helpers/conversation-session-network.js";
import { resolveSeededReplayBaseUrl } from "../../../helpers/custom-openai-provider-store.js";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";

const CASE_MARKER = "E2E_SWARM_COMPOSER_02";
const ALPHA_PARTIAL = "E2E_SWARM_ALPHA_RUNNING";
const BETA_PARTIAL = "E2E_SWARM_BETA_RUNNING";
const ALPHA_DONE = "E2E_SWARM_ALPHA_RUNNING_COMPOSER_ALPHA_DONE";
const BETA_DONE = "E2E_SWARM_BETA_RUNNING_COMPOSER_BETA_DONE";
const ROOT_DONE = `${CASE_MARKER}_SYNTHESIS_DONE`;
const artifactDir = resolve(process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/swarm-composer");

describe("SWARM-02: явный рой из обычного Composer", () => {
  before(async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("принимает swarm intent, создаёт две реальные дочерние сессии и показывает синтез в исходном чате", async function () {
    this.timeout(180_000);

    const paneBeforeSend = await getV4PaneSnapshot();
    expect(paneBeforeSend.sessionId).toBe("draft");
    const toggleFound = await browser.execute((testId) => {
      const toggle = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
      if (!toggle || toggle.disabled) return false;
      toggle.click();
      return true;
    }, "v4-composer-swarm-toggle");
    expect(toggleFound).toBe(true);
    // React updates the aria state after the click event; reading it in the same DOM task is stale.
    await browser.waitUntil(
      async () =>
        browser.execute(
          (testId) =>
            document
              .querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
              ?.getAttribute("aria-pressed") === "true",
          "v4-composer-swarm-toggle",
        ),
      { interval: 50, timeout: 5000, timeoutMsg: `${CASE_MARKER}: toggle не включился` },
    );
    const enabled = await browser.execute(
      (testId) =>
        document
          .querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
          ?.getAttribute("aria-pressed") === "true",
      "v4-composer-swarm-toggle",
    );
    expect(enabled).toBe(true);

    await sendV4Prompt(
      `${CASE_MARKER}: split this into two independent tasks, execute both, then synthesize their reports.`,
    );
    const accepted = await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId !== null && snapshot.sessionId !== "draft" && snapshot.canStop,
      `${CASE_MARKER}: Composer send не принял swarm turn`,
      60_000,
    );
    const rootSessionId = accepted.sessionId;
    if (!rootSessionId || rootSessionId === "draft") {
      throw new Error(`${CASE_MARKER}: отсутствует root session ID: ${JSON.stringify(accepted)}`);
    }

    await waitForUpstreamRequest(
      { includes: ["Decide whether this task needs independent parallel work", CASE_MARKER] },
      `${CASE_MARKER}: planner request не дошёл до локального scripted provider`,
      60_000,
    );
    const readSwarmRow = (expectedStatus: "running" | "completed") =>
      browser.execute(
        (rootId, rowStatus) => {
          const rows = Array.from(
            document.querySelectorAll<HTMLElement>('[data-row-kind="swarmRun"]'),
          );
          const row = rows.find((candidate) => {
            const buttons = Array.from(
              candidate.querySelectorAll<HTMLButtonElement>(
                'ul li button[data-testid^="v4-subagent-open-side-pane-"]',
              ),
            );
            return buttons.length === 2 && candidate.getAttribute("data-status") === rowStatus;
          });
          if (!row) return null;
          return {
            runId: row.dataset.swarmRunId ?? null,
            status: row.dataset.status ?? null,
            taskCount: row.querySelector("p")?.textContent ?? null,
            children: Array.from(
              row.querySelectorAll<HTMLButtonElement>(
                'ul li button[data-testid^="v4-subagent-open-side-pane-"]',
              ),
            ).map((button) => ({
              sessionId: button.dataset.testid?.replace(/^v4-subagent-open-side-pane-/u, "") ?? "",
              label: button.getAttribute("aria-label"),
            })),
            rootSessionId: rootId,
          };
        },
        rootSessionId,
        expectedStatus,
      );

    // Keep both real child model requests open at local replay gates. Seeing both gates together
    // proves overlap; the runtime row proves both child sessions were admitted before either
    // model response could finish.
    const replayBaseUrl = await resolveSeededReplayBaseUrl();
    if (!replayBaseUrl) throw new Error(`${CASE_MARKER}: локальный replay URL не найден`);
    const childResultFixtureIds = [
      "swarm-composer-alpha-result",
      "swarm-composer-beta-result",
    ] as const;
    await browser.waitUntil(
      async () => {
        const response = await fetch(`${replayBaseUrl}/__e2e__/gates`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error(`Не удалось прочитать replay gates: ${response.status}`);
        const gatedFixtureIds = (await response.json()) as string[];
        return childResultFixtureIds.every((fixtureId) => gatedFixtureIds.includes(fixtureId));
      },
      {
        interval: 100,
        timeout: 60_000,
        timeoutMsg: `${CASE_MARKER}: обе дочерние model requests не ожидали одновременно`,
      },
    );

    const readRunningSubagentIds = () =>
      browser.execute((paneTestId) => {
        const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
        return (pane?.dataset.runningSubagentIds ?? "")
          .split(",")
          .map((sessionId) => sessionId.trim())
          .filter(Boolean);
      }, "v4-session-pane-workspace-main");
    await browser.waitUntil(async () => (await readRunningSubagentIds()).length === 2, {
      interval: 150,
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: pane не показал одновременно обе работающие дочерние сессии`,
    });
    const overlappingChildSessionIds = await readRunningSubagentIds();
    expect(overlappingChildSessionIds).toHaveLength(2);
    expect(overlappingChildSessionIds.every(Boolean)).toBe(true);
    expect(new Set(overlappingChildSessionIds).size).toBe(2);

    await browser.waitUntil(async () => (await readSwarmRow("running"))?.children.length === 2, {
      interval: 150,
      timeout: 15_000,
      timeoutMsg: `${CASE_MARKER}: строка роя не показала child IDs до ответа моделей`,
    });
    const runningEvidence = await readSwarmRow("running");
    expect(runningEvidence?.children.map((child) => child.sessionId).sort()).toEqual(
      [...overlappingChildSessionIds].sort(),
    );
    const runningChildIds = runningEvidence?.children.map((child) => child.sessionId) ?? [];
    if (runningChildIds.length !== 2 || runningChildIds.some((id) => !id)) {
      throw new Error(`${CASE_MARKER}: отсутствуют child IDs для live previews`);
    }
    await browser.waitUntil(
      async () =>
        browser.execute(
          (sessionIds) =>
            sessionIds.every((sessionId) =>
              Boolean(document.querySelector(`[data-testid="v4-subagent-drilldown-${sessionId}"]`)),
            ),
          runningChildIds,
        ),
      {
        interval: 100,
        timeout: 10_000,
        timeoutMsg: `${CASE_MARKER}: строки роя не подключили child previews автоматически`,
      },
    );

    // releaseAfterChunks=3 already delivered each *_RUNNING delta and holds the same HTTP
    // response before *_DONE. This proves the preview is live while the child model is pending.
    await browser.waitUntil(
      async () =>
        browser.execute(
          (sessionIds, alphaPartial, betaPartial) => {
            const previews = sessionIds.map(
              (sessionId) =>
                document.querySelector<HTMLElement>(
                  `[data-testid="v4-subagent-drilldown-${sessionId}"]`,
                )?.textContent ?? "",
            );
            return (
              previews.some((text) => text.includes(alphaPartial)) &&
              previews.some((text) => text.includes(betaPartial))
            );
          },
          runningChildIds,
          ALPHA_PARTIAL,
          BETA_PARTIAL,
        ),
      {
        interval: 150,
        timeout: 15_000,
        timeoutMsg: `${CASE_MARKER}: previews не показали partial child text до завершения моделей`,
      },
    );
    const partialEvidence = await browser.execute(
      (sessionIds, alphaPartial, betaPartial, alphaDone, betaDone) => {
        const previews = sessionIds.map(
          (sessionId) =>
            document.querySelector<HTMLElement>(
              `[data-testid="v4-subagent-drilldown-${sessionId}"]`,
            )?.textContent ?? "",
        );
        return {
          hasAlphaPartial: previews.some((text) => text.includes(alphaPartial)),
          hasBetaPartial: previews.some((text) => text.includes(betaPartial)),
          hasAlphaDone: previews.some((text) => text.includes(alphaDone)),
          hasBetaDone: previews.some((text) => text.includes(betaDone)),
        };
      },
      runningChildIds,
      ALPHA_PARTIAL,
      BETA_PARTIAL,
      ALPHA_DONE,
      BETA_DONE,
    );
    expect(partialEvidence).toEqual({
      hasAlphaPartial: true,
      hasBetaPartial: true,
      hasAlphaDone: false,
      hasBetaDone: false,
    });
    expect((await readRunningSubagentIds()).sort()).toEqual([...overlappingChildSessionIds].sort());
    expect((await getV4PaneSnapshot()).canStop).toBe(true);
    expect(await readSwarmRow("running")).not.toBeNull();
    const pendingChildGatesResponse = await fetch(`${replayBaseUrl}/__e2e__/gates`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(pendingChildGatesResponse.status).toBe(200);
    const pendingChildGates = (await pendingChildGatesResponse.json()) as string[];
    expect(childResultFixtureIds.every((fixtureId) => pendingChildGates.includes(fixtureId))).toBe(
      true,
    );
    expect(pendingChildGates).not.toContain("swarm-composer-root-synthesis");

    const releases = await Promise.all(
      childResultFixtureIds.map((fixtureId) =>
        fetch(`${replayBaseUrl}/__e2e__/release/${encodeURIComponent(fixtureId)}`, {
          method: "POST",
          signal: AbortSignal.timeout(5000),
        }),
      ),
    );
    expect(releases.map((response) => response.status)).toEqual([204, 204]);

    // Root synthesis тоже ждёт на gate: его текст пока не должен отображаться.
    await browser.waitUntil(
      async () => {
        const response = await fetch(`${replayBaseUrl}/__e2e__/gates`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error(`Не удалось прочитать replay gates: ${response.status}`);
        return ((await response.json()) as string[]).includes("swarm-composer-root-synthesis");
      },
      {
        interval: 100,
        timeout: 60_000,
        timeoutMsg: `${CASE_MARKER}: root synthesis не остановился на локальном gate`,
      },
    );

    // browser.execute сериализует callback в renderer: константы тестового процесса туда не замыкаются.
    await browser.waitUntil(
      async () =>
        browser.execute(
          (sessionIds, alphaDone, betaDone) => {
            const previews = sessionIds.map(
              (sessionId) =>
                document.querySelector<HTMLElement>(
                  `[data-testid="v4-subagent-drilldown-${sessionId}"]`,
                )?.textContent ?? "",
            );
            return (
              previews.some((text) => text.includes(alphaDone)) &&
              previews.some((text) => text.includes(betaDone))
            );
          },
          runningChildIds,
          ALPHA_DONE,
          BETA_DONE,
        ),
      {
        interval: 150,
        timeout: 15_000,
        timeoutMsg: `${CASE_MARKER}: автоматические child previews не показали оба ответа`,
      },
    );

    const waitingForRootSynthesis = await getV4PaneSnapshot();
    expect(waitingForRootSynthesis.canStop).toBe(true);
    expect(waitingForRootSynthesis.timelineText).not.toContain(ROOT_DONE);
    // Row tracks child orchestration only; after all children finish it is completed
    // even while the foreground root model is still synthesizing their results.
    expect(await readSwarmRow("completed")).not.toBeNull();

    const releaseSynthesis = await fetch(
      `${replayBaseUrl}/__e2e__/release/swarm-composer-root-synthesis`,
      { method: "POST", signal: AbortSignal.timeout(5000) },
    );
    expect(releaseSynthesis.status).toBe(204);
    await waitForV4TimelineContaining(ROOT_DONE, 90_000);

    await browser.waitUntil(async () => (await readSwarmRow("completed")) !== null, {
      interval: 150,
      timeout: 60_000,
      timeoutMsg: `${CASE_MARKER}: completed swarm row с двумя child session IDs не появился`,
    });

    const evidence = await readSwarmRow("completed");
    if (!evidence) throw new Error(`${CASE_MARKER}: swarm row пропал после ожидания`);
    expect(evidence?.runId).toMatch(/^swarm_/u);
    expect(evidence?.status).toBe("completed");
    expect(evidence?.children).toHaveLength(2);
    const childSessionIds = evidence!.children.map((child) => child.sessionId);
    expect(childSessionIds.every(Boolean)).toBe(true);
    expect(new Set(childSessionIds).size).toBe(2);
    expect(new Set(childSessionIds)).toEqual(new Set(overlappingChildSessionIds));
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === rootSessionId && !snapshot.canStop,
      `${CASE_MARKER}: исходный чат не завершил swarm turn`,
      30_000,
    );

    const expectedFixtures: Array<{ fixtureId: string; query: UpstreamRequestQuery }> = [
      {
        fixtureId: "swarm-composer-root-plan",
        query: {
          includes: ["Decide whether this task needs independent parallel work", CASE_MARKER],
        },
      },
      {
        fixtureId: "swarm-composer-alpha-plan",
        query: {
          includes: [
            "Decide whether this task needs independent parallel work",
            "E2E_SWARM_COMPOSER_ALPHA",
          ],
        },
      },
      {
        fixtureId: "swarm-composer-beta-plan",
        query: {
          includes: [
            "Decide whether this task needs independent parallel work",
            "E2E_SWARM_COMPOSER_BETA",
          ],
        },
      },
      {
        fixtureId: "swarm-composer-alpha-result",
        query: {
          includes: ["E2E_SWARM_COMPOSER_ALPHA"],
          excludes: ["Decide whether this task needs independent parallel work"],
        },
      },
      {
        fixtureId: "swarm-composer-beta-result",
        query: {
          includes: ["E2E_SWARM_COMPOSER_BETA"],
          excludes: ["Decide whether this task needs independent parallel work"],
        },
      },
      {
        fixtureId: "swarm-composer-root-synthesis",
        query: {
          includes: [CASE_MARKER, ALPHA_DONE, BETA_DONE],
          excludes: [
            "Decide whether this task needs independent parallel work",
            "Generate a concise title",
          ],
        },
      },
    ];
    const capturedFixtures = await Promise.all(
      expectedFixtures.map(async ({ fixtureId, query }) => ({
        fixtureId,
        records: await getUpstreamRequestEvidence(query),
      })),
    );
    for (const { fixtureId, records } of capturedFixtures) {
      expect(records.some((record) => record.fixtureId === fixtureId)).toBe(true);
    }
    const synthesis = capturedFixtures
      .find((entry) => entry.fixtureId === "swarm-composer-root-synthesis")
      ?.records.find((record) => record.fixtureId === "swarm-composer-root-synthesis");
    expect(JSON.stringify(synthesis?.requestJson)).toContain(ALPHA_DONE);
    expect(JSON.stringify(synthesis?.requestJson)).toContain(BETA_DONE);

    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      resolve(artifactDir, "swarm-composer.json"),
      JSON.stringify(
        {
          capturedFixtureIds: capturedFixtures.map((item) => item.fixtureId),
          ...evidence,
        },
        null,
        2,
      ),
    );
    await browser.saveScreenshot(resolve(artifactDir, "swarm-composer-completed.png"));
  });
});
