/* off-peak 进程内 mock 网关的状态机与路由。
   本地起 127.0.0.1 http 服务完整模拟 额度快照/取号/批量状态/结算/messages。
   票据状态是单实例事实：多窗口多 host 通过固定端口共享同一份内存状态。

   状态机（对齐 D26 两轴的服务端轴）：
   take → queued（FIFO position）；status 轮询触发晋级（轮询即 Promote）：
   取号超过 readyDelayMs → ready（readyDeadline = +readyTtlMs）；ready 超时未发首个
   message → expired；首个 message 准入 → active（activeDeadline = +activeMs）；
   active 到期 → expired，messages 返回 400/3102；settle → settled（幂等）。
   messages 准入前可注入 N 次 429/3105 + Retry-After（模拟资源满载细阀，D24）。 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { respondWithAnthropicMock } from "./anthropic-mock.js";
import { DEFAULT_MOCK_PORT, resolveMockGatewayConfig } from "./config.js";
import { json, readBody } from "./http.js";
import {
  parseMockRequestJson,
  readRequestBoolean,
  readRequestNumber,
  readRequestString,
} from "./request.js";
import {
  buildForegroundSubagentScenarioResponse,
  classifyForegroundSubagentScenarioRequest,
} from "./scenario.js";
import type {
  MockTicket,
  OffPeakMockCapturedRequest,
  OffPeakMockGatewayDeps,
  OffPeakMockGatewayHandle,
  OffPeakMockGatewayOptions,
} from "./types.js";

export async function startOffPeakMockGateway(
  deps: OffPeakMockGatewayDeps,
  options?: OffPeakMockGatewayOptions & { port?: number },
): Promise<OffPeakMockGatewayHandle> {
  const config = resolveMockGatewayConfig(options);
  const tickets = new Map<string, MockTicket>();
  let quotaInjectionsRemaining = config.quotaExhaustedCount;
  const availabilityBlockedUntil = Date.now() + config.availabilityBlockedMs;
  /** taskId → 最新一张票（同 task_id 重新取号后旧票作废）。 */
  const latestByTask = new Map<string, string>();
  const capturedRequests: OffPeakMockCapturedRequest[] = [];
  let invalidTicketRequests = 0;
  let expireNextWake = false;
  let releaseBackground!: () => void;
  const backgroundBarrier = new Promise<void>((resolve) => {
    releaseBackground = resolve;
  });
  let seqCounter = 0;

  /** 懒惰推进时间驱动的状态（轮询/messages 时评估，无后台计时器）。 */
  function advance(ticket: MockTicket, now: number): void {
    if (ticket.state === "queued" && now - ticket.takenAt >= config.readyDelayMs) {
      ticket.state = "ready";
      ticket.readyAt = now;
      ticket.readyDeadline = now + config.readyTtlMs;
    }
    if (
      ticket.state === "ready" &&
      ticket.readyDeadline !== undefined &&
      now > ticket.readyDeadline
    ) {
      ticket.state = "expired";
    }
    if (
      ticket.state === "active" &&
      ticket.activeDeadline !== undefined &&
      now > ticket.activeDeadline
    ) {
      ticket.state = "expired";
    }
  }

  /** 排队位次 = 前面还有多少张未晋级的活票。 */
  function positionOf(ticket: MockTicket): number {
    let ahead = 0;
    for (const other of tickets.values()) {
      if (other.state === "queued" && other.seq < ticket.seq) ahead += 1;
    }
    return ahead + 1;
  }

  async function handleTake(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readBody(req)) as { task_id?: string };
    const taskId = body.task_id;
    if (!taskId) {
      json(res, 400, { code: 3000, msg: "task_id required" });
      return;
    }
    const now = Date.now();
    if (now < availabilityBlockedUntil) {
      json(res, 429, {
        code: 3103,
        msg: "free tier limit reached",
        data: { next_take_at: availabilityBlockedUntil },
      });
      return;
    }
    if (quotaInjectionsRemaining > 0) {
      quotaInjectionsRemaining -= 1;
      json(res, 429, {
        code: 3103,
        msg: "free tier limit reached",
        data: { next_take_at: now + 60_000 },
      });
      return;
    }
    // 同 task_id 重新取号：旧票直接作废（真实服务端旧票已自然终态）。
    const previous = latestByTask.get(taskId);
    if (previous) {
      const old = tickets.get(previous);
      if (old && (old.state === "queued" || old.state === "ready" || old.state === "active")) {
        old.state = "expired";
      }
    }
    seqCounter += 1;
    const ticket: MockTicket = {
      ticketId: `mock-ticket-${seqCounter}`,
      taskId,
      state: "queued",
      takenAt: now,
      queue429Remaining: config.queue429Count,
      seq: seqCounter,
    };
    // readyDelayMs=0 时取号即 ready（低峰空闲直接晋级的形态）。
    advance(ticket, now);
    tickets.set(ticket.ticketId, ticket);
    latestByTask.set(taskId, ticket.ticketId);
    deps.logger.info(
      `mock gateway take task=${taskId} ticket=${ticket.ticketId} state=${ticket.state}`,
    );
    json(res, 200, {
      ticket_id: ticket.ticketId,
      task_id: taskId,
      state: ticket.state,
      accepted: true,
      position: ticket.state === "queued" ? positionOf(ticket) : null,
      next_poll_after: config.nextPollS,
      queued_at: now,
      ...(ticket.readyDeadline ? { ready_deadline: ticket.readyDeadline } : {}),
    });
  }

  function handleAvailability(res: ServerResponse): void {
    const now = Date.now();
    json(res, 200, {
      can_take_number: now >= availabilityBlockedUntil,
      ...(now < availabilityBlockedUntil ? { next_take_at: availabilityBlockedUntil } : {}),
    });
  }

  async function handleStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readBody(req)) as { ticket_ids?: string[] };
    const ids = Array.isArray(body.ticket_ids) ? body.ticket_ids.slice(0, 100) : [];
    const now = Date.now();
    const entries = ids.map((id) => {
      const ticket = tickets.get(id);
      if (!ticket) return { ticket_id: id, state: "not_found" as const };
      advance(ticket, now);
      return {
        ticket_id: ticket.ticketId,
        task_id: ticket.taskId,
        state: ticket.state,
        position: ticket.state === "queued" ? positionOf(ticket) : null,
        ...(ticket.activeDeadline ? { active_deadline: ticket.activeDeadline } : {}),
      };
    });
    json(res, 200, { next_poll_after: config.nextPollS, tickets: entries });
  }

  function handleSettle(res: ServerResponse, ticketId: string): void {
    const ticket = tickets.get(ticketId);
    if (ticket) ticket.state = "settled";
    // 幂等：未知票也 200。
    json(res, 200, {
      ticket_id: ticketId,
      state: "settled",
      settled_at: Date.now(),
    });
  }

  async function handleMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ticketId = String(req.headers["x-off-peak-ticket-id"] ?? "");
    const ticket = tickets.get(ticketId);
    const now = Date.now();
    if (ticket) advance(ticket, now);
    if (!ticket || ticket.state === "expired" || ticket.state === "settled") {
      json(res, 400, { code: 3102, msg: "wrong off-peak ticket" });
      return;
    }
    if (config.scenario === "invalid-ticket") {
      // 让 E2E 走真实的 3102 终态路径：客户端必须重取票/保留原任务身份，
      // 且不能把失败的闲时请求偷偷改发到普通 Chat provider。
      invalidTicketRequests += 1;
      json(res, 400, { code: 3102, msg: "wrong off-peak ticket" });
      return;
    }
    if (ticket.state === "queued") {
      // 粗阀未开就来了 message：按细阀排队应答（客户端不应走到这，防御分支）。
      json(
        res,
        429,
        { code: 3105, msg: "not ready" },
        { "retry-after": String(config.retryAfterS) },
      );
      return;
    }
    if (ticket.queue429Remaining > 0) {
      ticket.queue429Remaining -= 1;
      json(
        res,
        429,
        { code: 3105, msg: "model concurrency saturated (mock)" },
        { "retry-after": String(config.retryAfterS) },
      );
      return;
    }
    if (ticket.state === "ready") {
      // ready 5min 内首个 message 即准入 active，进入 3h 窗口。
      ticket.state = "active";
      ticket.activeDeadline = now + config.activeMs;
      deps.logger.info(
        `mock gateway admitted ticket=${ticketId} activeDeadline=${ticket.activeDeadline}`,
      );
    }
    // admitted：原样代理到真实上游（SSE 透传）。
    const requestBody = await (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks);
    })();
    const requestJson = parseMockRequestJson(requestBody);
    if (config.scenario === "foreground-subagents" || config.scenario === "capture") {
      const stage = classifyForegroundSubagentScenarioRequest(requestJson);
      const maxTokens = readRequestNumber(requestJson, "max_tokens");
      const model = readRequestString(requestJson, "model");
      capturedRequests.push({
        hasApiKey: Boolean(req.headers["x-api-key"]),
        hasAuthorization: Boolean(req.headers.authorization),
        hasCodingPlanApiKey: Boolean(req.headers["x-coding-plan-api-key"]),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(model ? { model } : {}),
        requestJson,
        stage,
        ticketId,
        ...(typeof req.headers["bigmodel-organization"] === "string"
          ? { organization: req.headers["bigmodel-organization"] }
          : {}),
        ...(typeof req.headers["bigmodel-project"] === "string"
          ? { project: req.headers["bigmodel-project"] }
          : {}),
      });
      if (expireNextWake && stage === "parent-wakeup") {
        expireNextWake = false;
        ticket.state = "expired";
        invalidTicketRequests++;
        capturedRequests[capturedRequests.length - 1]!.stage = "parent-wakeup-expired";
        json(res, 400, { code: 3102, msg: "wrong off-peak ticket" });
        return;
      }
      const scripted =
        config.scenario === "foreground-subagents"
          ? buildForegroundSubagentScenarioResponse(
              stage,
              (server.address() as { port: number }).port,
            )
          : null;
      if (scripted) {
        if (stage.startsWith("background-")) await backgroundBarrier;
        respondWithAnthropicMock(res, scripted, readRequestBoolean(requestJson, "stream"));
        return;
      }
    }
    let upstream: { url: string; headers: Record<string, string> } | null;
    try {
      upstream = await deps.resolveUpstream();
    } catch (error) {
      deps.logger.warn("mock gateway resolveUpstream failed:", error);
      upstream = null;
    }
    if (!upstream) {
      // 离线/E2E：回一段固定的非流式 Anthropic 响应，agent loop 立即拿到 stop 收尾。
      json(res, 200, {
        id: "msg_offpeak_mock",
        type: "message",
        role: "assistant",
        model: "offpeak-mock",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Off-peak mock run completed." }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      return;
    }
    try {
      const upstreamResponse = await fetch(upstream.url, {
        method: "POST",
        headers: {
          "content-type": String(req.headers["content-type"] ?? "application/json"),
          ...(req.headers["anthropic-version"]
            ? { "anthropic-version": String(req.headers["anthropic-version"]) }
            : {}),
          ...upstream.headers,
        },
        body: new Uint8Array(requestBody),
      });
      const responseHeaders: Record<string, string> = {};
      upstreamResponse.headers.forEach((value, key) => {
        // hop-by-hop 头不透传。
        if (
          ["transfer-encoding", "connection", "content-length", "content-encoding"].includes(key)
        ) {
          return;
        }
        responseHeaders[key] = value;
      });
      res.writeHead(upstreamResponse.status, responseHeaders);
      if (!upstreamResponse.body) {
        res.end();
        return;
      }
      const reader = upstreamResponse.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } catch (error) {
      deps.logger.warn("mock gateway upstream proxy failed:", error);
      json(res, 502, { code: 2001, msg: "mock upstream proxy failed" });
    }
  }

  const server: Server = createServer((req, res) => {
    const url = req.url ?? "";
    void (async () => {
      if (
        req.method === "GET" &&
        url === "/__e2e/off-peak/background-bash" &&
        config.scenario === "foreground-subagents"
      ) {
        capturedRequests.push({
          stage: "bash-started",
          requestJson: {},
          ticketId: "",
          hasApiKey: false,
          hasAuthorization: false,
          hasCodingPlanApiKey: false,
        });
        await backgroundBarrier;
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("E2E_OFFPEAK_BACKGROUND_BASH_OK");
        return;
      }
      if (
        req.method === "POST" &&
        url === "/__e2e/off-peak/release-background" &&
        config.scenario === "foreground-subagents"
      ) {
        const input = (await readBody(req)) as { expireOnWake?: boolean };
        expireNextWake = input.expireOnWake === true;
        releaseBackground();
        json(res, 200, { released: true });
        return;
      }
      if (
        req.method === "GET" &&
        url === "/__e2e/off-peak/requests" &&
        (config.scenario === "foreground-subagents" ||
          config.scenario === "capture" ||
          config.scenario === "invalid-ticket")
      ) {
        json(res, 200, {
          invalidTicketRequests,
          requests: capturedRequests,
        });
        return;
      }
      if (req.method === "GET" && url === "/api/v1/off-peak/ticket/availability") {
        handleAvailability(res);
        return;
      }
      if (req.method !== "POST") {
        json(res, 405, { msg: "method not allowed" });
        return;
      }
      if (url === "/api/v1/off-peak/ticket") {
        await handleTake(req, res);
        return;
      }
      if (url === "/api/v1/off-peak/ticket/status") {
        await handleStatus(req, res);
        return;
      }
      const settleMatch = /^\/api\/v1\/off-peak\/ticket\/([^/]+)\/settle$/.exec(url);
      if (settleMatch) {
        handleSettle(res, decodeURIComponent(settleMatch[1]!));
        return;
      }
      if (url === "/api/v1/off-peak/anthropic/v1/messages") {
        await handleMessages(req, res);
        return;
      }
      json(res, 404, { msg: `no mock route for ${url}` });
    })().catch((error) => {
      deps.logger.warn("mock gateway handler failed:", error);
      try {
        json(res, 500, { msg: "mock gateway internal error" });
      } catch {
        // 响应已发出，忽略。
      }
    });
  });

  const requestedPort =
    options?.port ??
    (Number(process.env["ZCODE_OFFPEAK_MOCK_PORT"]) > 0
      ? Number(process.env["ZCODE_OFFPEAK_MOCK_PORT"])
      : DEFAULT_MOCK_PORT);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(requestedPort, "127.0.0.1", () => resolve());
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      // 多窗口：另一个 host 已起网关，共用它的票据状态（票在共享 sqlite 里跨 host 流转，
      // mock 状态必须单实例，否则 A 取的票在 B 的网关查不到）。
      const origin = `http://127.0.0.1:${requestedPort}`;
      deps.logger.info(`off-peak mock gateway reusing existing instance at ${origin}`);
      return {
        origin,
        port: requestedPort,
        external: true,
        close: async () => {},
      };
    }
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("off-peak mock gateway failed to bind");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  deps.logger.info(`off-peak mock gateway listening at ${origin}`);
  return {
    origin,
    port: address.port,
    external: false,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
