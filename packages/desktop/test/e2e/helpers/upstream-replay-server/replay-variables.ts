import { resolveUpstreamModels } from "../upstream-recorded-models.js";
import type {
  ReplayVariables,
  UpstreamReplayFixture,
  UpstreamReplayTextResponse,
  UpstreamReplayToolUseResponse,
} from "./types.js";

// 夹具未写模型时，回放响应使用与 E2E 供应商相同的模型（环境变量或录制模型）。
const DEFAULT_REPLAY_MODEL = resolveUpstreamModels().model;
const LATEST_AGENT_ID_REPLAY_TOKEN = "{{latestAgentId}}";
const LATEST_BASH_TASK_ID_REPLAY_TOKEN = "{{latestBashTaskId}}";
const MEMORY_ROOT_REPLAY_TOKEN = "{{memoryRoot}}";
const LATEST_AUTOMATION_ID_REPLAY_TOKEN = "{{latestAutomationId}}";
export const BROWSER_FIXTURE_URL_REPLAY_TOKEN = "{{browserFixtureUrl}}";
const LATEST_BROWSER_TAB_ID_REPLAY_TOKEN = "{{latestBrowserTabId}}";
const LATEST_BROWSER_TAB_A_ID_REPLAY_TOKEN = "{{latestBrowserTabAId}}";
const LATEST_BROWSER_TAB_B_ID_REPLAY_TOKEN = "{{latestBrowserTabBId}}";

export function resolveFixtureResponseBody(
  response: UpstreamReplayFixture["response"],
  variables: ReplayVariables,
): { body: string; headers: Record<string, string> } {
  if (response.body !== undefined) {
    return {
      body: applyReplayVariablesToString(response.body, variables),
      headers: response.headers ?? {},
    };
  }

  if (response.toolUses?.length) {
    return {
      body: buildToolUsesSseBody(
        response.toolUses.map((toolUse) => resolveReplayToolUse(toolUse, variables)),
      ),
      headers: withEventStreamHeaders(response.headers),
    };
  }

  if (response.toolUse) {
    return {
      body: buildToolUseSseBody(resolveReplayToolUse(response.toolUse, variables)),
      headers: withEventStreamHeaders(response.headers),
    };
  }

  if (response.toolUses?.length) {
    return {
      body: buildToolUsesSseBody(response.toolUses),
      headers: withEventStreamHeaders(response.headers),
    };
  }

  if (response.text !== undefined) {
    return {
      body: buildTextSseBody(resolveReplayText(response.text, variables)),
      headers: withEventStreamHeaders(response.headers),
    };
  }

  return {
    body: "",
    headers: response.headers ?? {},
  };
}

export function extractReplayVariables(requestText: string, requestJson: unknown): ReplayVariables {
  const requestContent = `${requestText}\n${JSON.stringify(requestJson ?? {})}`;
  const browserTabIds = readLatestBrowserTabIds(requestJson);
  return {
    browserFixtureUrl: readBrowserFixtureUrl(requestContent),
    ...browserTabIds,
    latestAgentId: readLatestAgentId(requestContent),
    latestBashTaskId: readLatestBashTaskId(requestContent),
    memoryRoot: readMemoryRoot(requestContent),
    latestAutomationId: readLatestAutomationId(requestJson),
  };
}

function readLatestBrowserTabIds(
  value: unknown,
): Pick<ReplayVariables, "latestBrowserTabAId" | "latestBrowserTabBId" | "latestBrowserTabId"> {
  const ids = {
    e2eBrowserTabAId: [] as string[],
    e2eBrowserTabBId: [] as string[],
    e2eBrowserTabId: [] as string[],
  };
  const names = Object.keys(ids) as Array<keyof typeof ids>;
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      // Bug 根因：真实 Node REPL tool_result 是 `=> { ... }\nStructured content:`，
      // 不是可直接 JSON.parse 的纯 JSON；只解析带 E2E 命名空间的显式字段，避免
      // 从任意 tab 文本猜 id，让 replay 真正模拟模型读取上一条工具结果。
      for (const name of names) {
        const pattern = new RegExp(`["']${name}["']\\s*:\\s*["']([^"']+)["']`, "gu");
        for (const match of candidate.matchAll(pattern)) {
          if (match[1]?.trim()) ids[name].push(match[1].trim());
        }
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    for (const [key, child] of Object.entries(candidate)) {
      if (names.includes(key as keyof typeof ids) && typeof child === "string" && child.trim()) {
        ids[key as keyof typeof ids].push(child.trim());
      }
      visit(child);
    }
  };

  visit(value);
  return {
    latestBrowserTabAId: ids.e2eBrowserTabAId.at(-1),
    latestBrowserTabBId: ids.e2eBrowserTabBId.at(-1),
    latestBrowserTabId: ids.e2eBrowserTabId.at(-1),
  };
}

function readBrowserFixtureUrl(value: string): string | undefined {
  // 修复原因：Browser Use E2E 的本地 HTTP server 使用随机端口，provider replay
  // 必须从用户 marker 回填真实 URL，不能依赖固定端口或公网页面制造并发/网络抖动。
  const match = value.match(
    /E2E_BROWSER_FIXTURE_URL:(https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/[^\s"'<>),]*)/u,
  );
  return match?.[1];
}

function readLatestAgentId(value: string): string | undefined {
  const matches = [...value.matchAll(/agentId:\s*(agent_[A-Za-z0-9_-]+)/gu)];
  return matches.at(-1)?.[1];
}

function readLatestBashTaskId(value: string): string | undefined {
  // Bash task ID 每次运行都不同；只从真实 launch result 回填，不能把 Agent ID 当作 Bash ID。
  const matches = [
    ...value.matchAll(/Command running in background with ID:\s*([A-Za-z0-9_-]+)\./gu),
  ];
  return matches.at(-1)?.[1];
}

function readMemoryRoot(value: string): string | undefined {
  // Memory root 由 Runtime 按 workspace 计算，fixture 不能硬编码本机绝对路径。
  // 只从已经进入 provider request 的既有 Memory prompt 提取路径并回填 tool input。
  const matches = [
    ...value.matchAll(/persistent(?:,\s*)? file-based memory(?: system)? at `([^`]+?)[/\\]`/giu),
  ];
  return matches.at(-1)?.[1];
}

function readLatestAutomationId(value: unknown): string | undefined {
  const ids: string[] = [];
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          visit(JSON.parse(trimmed) as unknown);
          return;
        } catch {
          // tool_result 可能是带前后说明的文本，继续用正则提取其中的 JSON 字段。
        }
      }
      for (const match of candidate.matchAll(
        /["'](?:automationId|automation_id)["']\s*:\s*["']([^"']+)["']/gu,
      )) {
        if (match[1]?.trim()) ids.push(match[1].trim());
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    for (const [key, child] of Object.entries(candidate)) {
      if (
        (key === "automationId" || key === "automation_id") &&
        typeof child === "string" &&
        child.trim()
      ) {
        ids.push(child.trim());
      }
      visit(child);
    }
  };

  visit(value);
  return ids.at(-1);
}

function resolveReplayToolUse(
  toolUse: UpstreamReplayToolUseResponse,
  variables: ReplayVariables,
): UpstreamReplayToolUseResponse {
  return {
    ...toolUse,
    id: toolUse.id === undefined ? undefined : applyReplayVariablesToString(toolUse.id, variables),
    input: applyReplayVariables(toolUse.input, variables) as Record<string, unknown>,
    messageId:
      toolUse.messageId === undefined
        ? undefined
        : applyReplayVariablesToString(toolUse.messageId, variables),
  };
}

function resolveReplayText(
  textResponse: UpstreamReplayTextResponse | string,
  variables: ReplayVariables,
): UpstreamReplayTextResponse | string {
  if (typeof textResponse === "string") {
    return applyReplayVariablesToString(textResponse, variables);
  }
  return {
    ...textResponse,
    id:
      textResponse.id === undefined
        ? undefined
        : applyReplayVariablesToString(textResponse.id, variables),
    text: applyReplayVariablesToString(textResponse.text, variables),
  };
}

function applyReplayVariables(value: unknown, variables: ReplayVariables): unknown {
  if (typeof value === "string") {
    return applyReplayVariablesToString(value, variables);
  }
  if (Array.isArray(value)) {
    return value.map((item) => applyReplayVariables(item, variables));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, applyReplayVariables(child, variables)]),
  );
}

function applyReplayVariablesToString(value: string, variables: ReplayVariables): string {
  let resolved = value;
  if (variables.latestBrowserTabId !== undefined) {
    resolved = resolved
      .split(LATEST_BROWSER_TAB_ID_REPLAY_TOKEN)
      .join(variables.latestBrowserTabId);
  }
  if (variables.latestBrowserTabAId !== undefined) {
    resolved = resolved
      .split(LATEST_BROWSER_TAB_A_ID_REPLAY_TOKEN)
      .join(variables.latestBrowserTabAId);
  }
  if (variables.latestBrowserTabBId !== undefined) {
    resolved = resolved
      .split(LATEST_BROWSER_TAB_B_ID_REPLAY_TOKEN)
      .join(variables.latestBrowserTabBId);
  }
  if (variables.latestAgentId !== undefined) {
    resolved = resolved.split(LATEST_AGENT_ID_REPLAY_TOKEN).join(variables.latestAgentId);
  }
  if (variables.latestBashTaskId !== undefined) {
    resolved = resolved.split(LATEST_BASH_TASK_ID_REPLAY_TOKEN).join(variables.latestBashTaskId);
  }
  if (variables.memoryRoot !== undefined) {
    resolved = resolved.split(MEMORY_ROOT_REPLAY_TOKEN).join(variables.memoryRoot);
  }
  if (variables.latestAutomationId !== undefined) {
    resolved = resolved.split(LATEST_AUTOMATION_ID_REPLAY_TOKEN).join(variables.latestAutomationId);
  }
  if (variables.browserFixtureUrl !== undefined) {
    resolved = resolved.split(BROWSER_FIXTURE_URL_REPLAY_TOKEN).join(variables.browserFixtureUrl);
  }
  return resolved;
}

function withEventStreamHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  return {
    "cache-control": "no-cache",
    "content-type": "text/event-stream; charset=utf-8",
    ...headers,
  };
}

function buildToolUseSseBody(toolUse: UpstreamReplayToolUseResponse): string {
  return buildToolUsesSseBody([toolUse]);
}

function buildToolUsesSseBody(toolUses: UpstreamReplayToolUseResponse[]): string {
  const firstToolUse = toolUses[0];
  const messageId = firstToolUse?.messageId ?? `msg_${sanitizeSseId(firstToolUse?.name ?? "tool")}`;
  const inputTokens = firstToolUse?.inputTokens;
  const outputTokens = toolUses.reduce((sum, toolUse) => sum + (toolUse.outputTokens ?? 16), 0);
  return [
    sseEvent("message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: firstToolUse?.model ?? DEFAULT_REPLAY_MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: replayUsage(inputTokens, 0),
      },
    }),
    ...toolUses.flatMap((toolUse, index) => buildToolUseContentBlockEvents(toolUse, index)),
    sseEvent("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: "tool_use",
        stop_sequence: null,
      },
      usage: replayUsage(inputTokens, outputTokens),
    }),
    sseEvent("message_stop", { type: "message_stop" }),
  ].join("");
}

function buildToolUseContentBlockEvents(
  toolUse: UpstreamReplayToolUseResponse,
  index: number,
): string[] {
  const toolCallId = toolUse.id ?? `toolu_${sanitizeSseId(toolUse.name)}`;
  const inputJson = JSON.stringify(toolUse.input);
  return [
    sseEvent("content_block_start", {
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: toolCallId,
        name: toolUse.name,
        input: {},
      },
    }),
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: {
        type: "input_json_delta",
        partial_json: inputJson,
      },
    }),
    sseEvent("content_block_stop", {
      type: "content_block_stop",
      index,
    }),
  ];
}

function buildTextSseBody(textResponse: UpstreamReplayTextResponse | string): string {
  const text = typeof textResponse === "string" ? textResponse : textResponse.text;
  const id =
    typeof textResponse === "string"
      ? "msg_upstream_e2e_text"
      : (textResponse.id ?? "msg_upstream_e2e_text");
  const model =
    typeof textResponse === "string"
      ? DEFAULT_REPLAY_MODEL
      : (textResponse.model ?? DEFAULT_REPLAY_MODEL);
  const inputTokens = typeof textResponse === "string" ? undefined : textResponse.inputTokens;
  const outputTokens = typeof textResponse === "string" ? undefined : textResponse.outputTokens;

  return [
    sseEvent("message_start", {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: replayUsage(inputTokens, 0),
      },
    }),
    sseEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "text",
        text: "",
      },
    }),
    sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "text_delta",
        text,
      },
    }),
    sseEvent("content_block_stop", {
      type: "content_block_stop",
      index: 0,
    }),
    sseEvent("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: "end_turn",
        stop_sequence: null,
      },
      usage: replayUsage(inputTokens, outputTokens ?? 12),
    }),
    sseEvent("message_stop", { type: "message_stop" }),
  ].join("");
}

function replayUsage(inputTokens = 128, outputTokens = 0) {
  return {
    input_tokens: inputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: outputTokens,
    service_tier: "standard",
  };
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sanitizeSseId(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}
