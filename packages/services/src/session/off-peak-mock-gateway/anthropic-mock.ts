/* Anthropic 兼容响应构造与 SSE 输出：用于离线/E2E 的确定性 messages 应答。 */
import type { ServerResponse } from "node:http";

export interface AnthropicMockResponse {
  content: readonly Record<string, unknown>[];
  id: string;
  model: string;
  role: "assistant";
  stop_reason: "end_turn" | "tool_use";
  type: "message";
  usage: { input_tokens: number; output_tokens: number };
}

export function anthropicMockResponse(input: {
  content: readonly Record<string, unknown>[];
  stopReason: "end_turn" | "tool_use";
}): AnthropicMockResponse {
  return {
    id: `msg_offpeak_mock_${input.stopReason}`,
    type: "message",
    role: "assistant",
    model: "offpeak-mock",
    stop_reason: input.stopReason,
    content: input.content,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

export function respondWithAnthropicMock(
  res: ServerResponse,
  response: AnthropicMockResponse,
  stream: boolean,
): void {
  if (!stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
    return;
  }

  const events: string[] = [
    anthropicSseEvent("message_start", {
      type: "message_start",
      message: { ...response, content: [], stop_reason: null },
    }),
  ];
  response.content.forEach((block, index) => {
    if (block.type === "tool_use") {
      events.push(
        anthropicSseEvent("content_block_start", {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: {},
          },
        }),
        anthropicSseEvent("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(block.input ?? {}),
          },
        }),
        anthropicSseEvent("content_block_stop", {
          type: "content_block_stop",
          index,
        }),
      );
      return;
    }
    events.push(
      anthropicSseEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      }),
      anthropicSseEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: block.text ?? "" },
      }),
      anthropicSseEvent("content_block_stop", {
        type: "content_block_stop",
        index,
      }),
    );
  });
  events.push(
    anthropicSseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: response.stop_reason, stop_sequence: null },
      usage: response.usage,
    }),
    anthropicSseEvent("message_stop", { type: "message_stop" }),
  );
  res.writeHead(200, {
    "cache-control": "no-cache",
    "content-type": "text/event-stream; charset=utf-8",
  });
  res.end(events.join(""));
}

function anthropicSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
