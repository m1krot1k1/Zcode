import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { clearAppData, getE2EAppDataPaths } from "../../../helpers/desktop-app.js";
import { reloadElectronSessionSafely } from "../../../helpers/e2e-electron-reload.js";
import { getUpstreamRequestEvidence } from "../../../helpers/conversation-session-network.js";
import { resolveSeededReplayBaseUrl } from "../../../helpers/custom-openai-provider-store.js";
import {
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
} from "../../../helpers/v4-conversation.js";

const CASE_MARKER = "E2E_SWARM_CRASH_01";
const CHILD_FIXTURE_IDS = ["swarm-composer-alpha-result", "swarm-composer-beta-result"] as const;
const SYNTHESIS_FIXTURE_ID = "swarm-composer-root-synthesis";

interface SwarmAttemptSnap {
  nodeId: string;
  status: string;
}

interface SwarmSnap {
  attempts: SwarmAttemptSnap[];
  hasGraph: number;
  rootSessionId: string;
  runId: string;
  status: string;
  timeCreated: number;
}

function sessionDbPath() {
  return join(getE2EAppDataPaths().homeDir, ".zcode", "cli", "db", "db.sqlite");
}

function readSwarmSince(startedAt: number): SwarmSnap | null {
  const db = new DatabaseSync(sessionDbPath(), { readOnly: true });
  try {
    const run = db
      .prepare(
        `select root_session_id as rootSessionId, run_id as runId, status, time_created as timeCreated,
                case when graph_json is null then 0 else 1 end as hasGraph
         from swarm_run
         where time_created >= ?
         order by time_created desc, run_id desc
         limit 1`,
      )
      .get(startedAt) as Omit<SwarmSnap, "attempts"> | undefined;
    if (!run) return null;
    const attempts = db
      .prepare(
        `select node_id as nodeId, status
         from swarm_node_attempt
         where run_id = ?
         order by node_id`,
      )
      .all(run.runId) as unknown as SwarmAttemptSnap[];
    return { ...run, attempts };
  } finally {
    db.close();
  }
}

function readSwarm(runId: string): SwarmSnap | null {
  const db = new DatabaseSync(sessionDbPath(), { readOnly: true });
  try {
    const run = db
      .prepare(
        `select root_session_id as rootSessionId, run_id as runId, status, time_created as timeCreated,
                case when graph_json is null then 0 else 1 end as hasGraph
         from swarm_run
         where run_id = ?`,
      )
      .get(runId) as Omit<SwarmSnap, "attempts"> | undefined;
    if (!run) return null;
    const attempts = db
      .prepare(
        `select node_id as nodeId, status
         from swarm_node_attempt
         where run_id = ?
         order by node_id`,
      )
      .all(run.runId) as unknown as SwarmAttemptSnap[];
    return { ...run, attempts };
  } finally {
    db.close();
  }
}

async function enableSwarmToggle() {
  const toggleFound = await browser.execute((testId) => {
    const toggle = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    if (!toggle || toggle.disabled) return false;
    if (toggle.getAttribute("aria-pressed") === "true") return true;
    toggle.click();
    return true;
  }, "v4-composer-swarm-toggle");
  expect(toggleFound).toBe(true);
  await browser.waitUntil(
    async () =>
      browser.execute(
        (testId) =>
          document
            .querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
            ?.getAttribute("aria-pressed") === "true",
        "v4-composer-swarm-toggle",
      ),
    { interval: 50, timeout: 5_000, timeoutMsg: `${CASE_MARKER}: toggle не включился` },
  );
}

async function sendSwarmPrompt() {
  const startedAt = Date.now();
  await enableSwarmToggle();
  await sendV4Prompt(
    `${CASE_MARKER}: split this into two independent tasks, execute both, then synthesize their reports.`,
  );
  return startedAt;
}

async function waitForBoundary(
  startedAt: number,
  label: string,
  ready: (snap: SwarmSnap) => boolean,
  missed: (snap: SwarmSnap) => boolean,
  timeoutMs = 25_000,
) {
  const deadline = Date.now() + timeoutMs;
  let last: SwarmSnap | null = null;
  while (Date.now() < deadline) {
    last = readSwarmSince(startedAt);
    if (last && ready(last)) return last;
    if (last && missed(last)) {
      throw new Error(`${CASE_MARKER}: граница «${label}» уже пройдена ${JSON.stringify(last)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`${CASE_MARKER}: граница «${label}» не достигнута ${JSON.stringify(last)}`);
}

async function replayBaseUrl() {
  const baseUrl = await resolveSeededReplayBaseUrl();
  if (!baseUrl) throw new Error(`${CASE_MARKER}: локальный replay URL не найден`);
  return baseUrl;
}

async function waitForGates(fixtureIds: readonly string[], timeoutMsg: string) {
  const baseUrl = await replayBaseUrl();
  await browser.waitUntil(
    async () => {
      const response = await fetch(`${baseUrl}/__e2e__/gates`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`Не удалось прочитать replay gates: ${response.status}`);
      const gated = (await response.json()) as string[];
      return fixtureIds.every((fixtureId) => gated.includes(fixtureId));
    },
    { interval: 100, timeout: 60_000, timeoutMsg },
  );
}

async function releaseGate(fixtureId: string) {
  const baseUrl = await replayBaseUrl();
  const response = await fetch(`${baseUrl}/__e2e__/release/${encodeURIComponent(fixtureId)}`, {
    method: "POST",
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status !== 204) {
    throw new Error(`${CASE_MARKER}: не удалось отпустить ${fixtureId}: ${response.status}`);
  }
}

async function countModelRequests() {
  const [marker, alpha, beta] = await Promise.all([
    getUpstreamRequestEvidence({ includes: [CASE_MARKER] }),
    getUpstreamRequestEvidence({ includes: ["E2E_SWARM_COMPOSER_ALPHA"] }),
    getUpstreamRequestEvidence({ includes: ["E2E_SWARM_COMPOSER_BETA"] }),
  ]);
  return { alpha: alpha.length, beta: beta.length, marker: marker.length };
}

interface LiveProcess {
  command: string;
  pid: number;
  ppid: number;
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function signalKillAgent(pid: number) {
  try {
    // detached spawn: pid группы совпадает с pid агента, вместе с ним уходят потомки.
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    try {
      process.kill(pid, "SIGKILL");
    } catch (inner) {
      if ((inner as NodeJS.ErrnoException).code !== "ESRCH") throw inner;
    }
  }
}

function listLiveProcesses(): LiveProcess[] {
  const listing = execFileSync("ps", ["-axww", "-o", "pid=,ppid=,command="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const processes: LiveProcess[] = [];
  for (const line of listing.split("\n")) {
    const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line.trim());
    if (!match) continue;
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3] ?? "",
    });
  }
  return processes;
}

function isE2EElectronMain(command: string) {
  const name = command.trim();
  return (
    name === "ZCode E2E" ||
    name.includes("Electron.app/Contents/MacOS/Electron") ||
    /(^|\/)Electron(?:\s|$)/u.test(name)
  );
}

/**
 * CLI ставит process.title = zcode-cli, и macOS ps показывает только этот заголовок:
 * argv app-server и env в строке процесса уже не видны. Команда Electron main
 * тоже схлопывается в `ZCode E2E`. Агент — прямой потомок zcode-host, чей родитель
 * держит дочерний процесс с профилем этого E2E.
 */
function listCrashAgentPids() {
  const processes = listLiveProcesses();
  const childrenByParent = new Map<number, LiveProcess[]>();
  for (const item of processes) {
    const children = childrenByParent.get(item.ppid);
    if (children) children.push(item);
    else childrenByParent.set(item.ppid, [item]);
  }
  const mainPids = new Set(
    processes
      .filter((item) => {
        const children = childrenByParent.get(item.pid) ?? [];
        const ownsE2EProfile =
          item.command.includes(".e2e-cache/desktop-e2e") ||
          children.some((child) => child.command.includes(".e2e-cache/desktop-e2e"));
        return ownsE2EProfile && isE2EElectronMain(item.command);
      })
      .map((item) => item.pid),
  );
  const hostPids = new Set(
    processes
      .filter((item) => item.command.startsWith("zcode-host-") && mainPids.has(item.ppid))
      .map((item) => item.pid),
  );
  const matched = processes
    .filter((item) => {
      const name = item.command.trim();
      return (name === "zcode-cli" || name.startsWith("zcode-cli ")) && hostPids.has(item.ppid);
    })
    .map((item) => item.pid);
  return { hosts: hostPids.size, matched };
}

async function killAgentProcesses() {
  const { hosts, matched } = listCrashAgentPids();
  if (matched.length === 0) {
    throw new Error(
      `${CASE_MARKER}: нет CLI-агента zcode-cli у zcode-host этого E2E (host: ${hosts})`,
    );
  }
  for (const pid of matched) signalKillAgent(pid);
  await browser.waitUntil(async () => matched.every((pid) => !isProcessAlive(pid)), {
    timeout: 15_000,
    timeoutMsg: `${CASE_MARKER}: агент не завершился после SIGKILL ${matched.join(",")}`,
  });
}

async function swarmRowStatus(runId: string) {
  return browser.execute((id) => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-row-kind="swarmRun"]'));
    return rows.find((row) => row.dataset.swarmRunId === id)?.getAttribute("data-status") ?? "";
  }, runId);
}

async function crashAndReopen(
  before: SwarmSnap,
  expectedStatuses: string[],
  expectedRun: { journal: string; ui: string },
) {
  const confirmed = readSwarm(before.runId);
  if (
    !confirmed ||
    confirmed.status !== before.status ||
    confirmed.attempts.map((attempt) => attempt.status).join() !==
      before.attempts.map((attempt) => attempt.status).join()
  ) {
    throw new Error(
      `${CASE_MARKER}: журнал изменился до SIGKILL ${JSON.stringify(before)} -> ${JSON.stringify(confirmed)}`,
    );
  }
  await killAgentProcesses();
  const requestsBefore = await countModelRequests();
  await reloadElectronSessionSafely(browser);
  await selectV4TaskById(before.rootSessionId, 30_000);
  await browser.waitUntil(
    async () =>
      (await readSwarm(before.runId))?.status === expectedRun.journal &&
      (await swarmRowStatus(before.runId)) === expectedRun.ui,
    {
      interval: 200,
      timeout: 30_000,
      timeoutMsg: `${CASE_MARKER}: после открытия чата run не стал ${expectedRun.journal}/${expectedRun.ui}`,
    },
  );
  const after = readSwarm(before.runId);
  expect(after?.attempts.map((attempt) => attempt.status)).toEqual(expectedStatuses);
  const stableSince = Date.now();
  await browser.waitUntil(
    async () => {
      const requestsAfter = await countModelRequests();
      if (
        requestsAfter.marker !== requestsBefore.marker ||
        requestsAfter.alpha !== requestsBefore.alpha ||
        requestsAfter.beta !== requestsBefore.beta
      ) {
        throw new Error(
          `${CASE_MARKER}: после перезапуска появился новый model request ${JSON.stringify(requestsBefore)} -> ${JSON.stringify(requestsAfter)}`,
        );
      }
      return Date.now() - stableSince >= 3_000;
    },
    {
      interval: 200,
      timeout: 8_000,
      timeoutMsg: `${CASE_MARKER}: не удалось подтвердить отсутствие нового model request`,
    },
  );
}

describe("SWARM-42: обрыв агента на границах роя", () => {
  before(async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("после commit графа холодное открытие не запускает child", async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E();
    const startedAt = await sendSwarmPrompt();
    const snap = await waitForBoundary(
      startedAt,
      "graph",
      (row) => row.hasGraph === 1 && row.status === "planning" && row.attempts.length === 0,
      (row) => row.attempts.length > 0 || (row.hasGraph === 1 && row.status !== "planning"),
    );
    await crashAndReopen(snap, [], { journal: "interrupted", ui: "failed" });
  });

  it("после резервирования обоих узлов попытки становятся interrupted", async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E();
    const startedAt = await sendSwarmPrompt();
    const snap = await waitForBoundary(
      startedAt,
      "reservation",
      (row) =>
        row.status === "running" &&
        row.attempts.length === 2 &&
        row.attempts.every((attempt) => attempt.status === "dispatching"),
      (row) => row.attempts.some((attempt) => attempt.status !== "dispatching"),
      40_000,
    );
    await crashAndReopen(snap, ["interrupted", "interrupted"], {
      journal: "interrupted",
      ui: "failed",
    });
  });

  it("во время выполнения child SIGKILL не создаёт новый model request", async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E();
    const startedAt = await sendSwarmPrompt();
    await waitForGates(
      CHILD_FIXTURE_IDS,
      `${CASE_MARKER}: обе дочерние модели не удерживались одновременно`,
    );
    const snap = await waitForBoundary(
      startedAt,
      "execution",
      (row) =>
        row.status === "running" &&
        row.attempts.length === 2 &&
        row.attempts.every((attempt) => attempt.status === "running"),
      () => false,
      20_000,
    );
    await crashAndReopen(snap, ["interrupted", "interrupted"], {
      journal: "interrupted",
      ui: "failed",
    });
  });

  it("во время синтеза root завершённые попытки не перезапускаются", async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E();
    const startedAt = await sendSwarmPrompt();
    await waitForGates(CHILD_FIXTURE_IDS, `${CASE_MARKER}: дочерние модели не дошли до gate`);
    await releaseGate(CHILD_FIXTURE_IDS[0]);
    await releaseGate(CHILD_FIXTURE_IDS[1]);
    await waitForGates([SYNTHESIS_FIXTURE_ID], `${CASE_MARKER}: синтез root не удерживался`);
    const snap = await waitForBoundary(
      startedAt,
      "synthesis",
      (row) =>
        row.status === "completed" &&
        row.attempts.length === 2 &&
        row.attempts.every((attempt) => attempt.status === "completed"),
      () => false,
      30_000,
    );
    await crashAndReopen(snap, ["completed", "completed"], {
      journal: "completed",
      ui: "completed",
    });
  });
});
