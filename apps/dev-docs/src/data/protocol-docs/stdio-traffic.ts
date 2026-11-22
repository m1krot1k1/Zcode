import type { StdioTrafficFrame, StdioTrafficLogField } from "./types.js";

export const stdioTrafficLogFields: StdioTrafficLogField[] = [
  {
    name: "ts",
    type: "ISO timestamp",
    meaning: "proxy 写入磁盘的时间，用于按本机时间排序和定位。",
  },
  {
    name: "workspaceKey",
    type: "string",
    meaning: "身份隔离 key，远程 workspace 使用 workspaceIdentity，本地回退 workspacePath。",
  },
  {
    name: "pid",
    type: "number",
    meaning: "agent 子进程 pid；同一个 workspace 重启后会出现新的 pid 文件。",
  },
  {
    name: "direction",
    type: "app-to-agent | agent-to-app | agent-stderr",
    meaning: "帧方向：写入 stdin、读取 stdout，或 agent stderr 旁路。",
  },
  {
    name: "raw",
    type: "string",
    meaning: "原始行内容。stdout/stdin 必须保持一行 JSON，stderr 可以是普通文本。",
  },
  {
    name: "message",
    type: "object | null",
    meaning: "raw 可解析为 ZCode Protocol 消息时的结构化结果；stderr 或解析失败时为空。",
  },
  {
    name: "parseError",
    type: "string | null",
    meaning: "解析失败原因。proxy 不应因此截断转发，只在查看器里标红。",
  },
];

export const stdioTrafficFrames: StdioTrafficFrame[] = [
  {
    id: "frame-001",
    timestamp: "10:42:18.124",
    direction: "app-to-agent",
    kind: "request",
    method: "session/create",
    messageId: "1",
    summary: "创建本地 workspace 会话",
    bytes: 428,
    linkedId: "frame-002",
    raw: `{
  "id": 1,
  "method": "session/create",
  "params": {
    "workspace": {
      "workspacePath": "/Users/dev/workspace/z-code",
      "workspaceKey": "/Users/dev/workspace/z-code"
    },
    "deliveryKind": "desktop-continuous"
  }
}`,
  },
  {
    id: "frame-002",
    timestamp: "10:42:18.191",
    direction: "agent-to-app",
    kind: "response",
    messageId: "1",
    sessionId: "sess_6b6a",
    summary: "返回 SessionStateSnapshot",
    bytes: 1816,
    latencyMs: 67,
    linkedId: "frame-001",
    raw: `{
  "id": 1,
  "result": {
    "session": {
      "sessionId": "sess_6b6a",
      "status": "ready"
    },
    "runtime": {
      "eventSeq": 0,
      "deliveryKind": "desktop-continuous"
    }
  }
}`,
  },
  {
    id: "frame-003",
    timestamp: "10:42:21.004",
    direction: "app-to-agent",
    kind: "request",
    method: "session/send",
    messageId: "2",
    sessionId: "sess_6b6a",
    inputId: "inp_a31c",
    summary: "提交用户输入并立即 ACK",
    bytes: 612,
    linkedId: "frame-004",
    raw: `{
  "id": 2,
  "method": "session/send",
  "params": {
    "sessionId": "sess_6b6a",
    "inputId": "inp_a31c",
    "content": "看一下 stdio traffic"
  }
}`,
  },
  {
    id: "frame-004",
    timestamp: "10:42:21.011",
    direction: "agent-to-app",
    kind: "response",
    messageId: "2",
    sessionId: "sess_6b6a",
    inputId: "inp_a31c",
    summary: "session/send ack，不等待模型完成",
    bytes: 96,
    latencyMs: 7,
    linkedId: "frame-003",
    raw: `{
  "id": 2,
  "result": {
    "accepted": true,
    "inputId": "inp_a31c"
  }
}`,
  },
  {
    id: "frame-005",
    timestamp: "10:42:21.036",
    direction: "agent-to-app",
    kind: "notification",
    method: "session/event",
    sessionId: "sess_6b6a",
    inputId: "inp_a31c",
    summary: "turn.started 事件，payload 回带 inputId",
    bytes: 744,
    raw: `{
  "method": "session/event",
  "params": {
    "sessionId": "sess_6b6a",
    "seq": 1,
    "traceId": "tr_9f20",
    "payload": {
      "type": "turn.started",
      "inputId": "inp_a31c",
      "turnId": "turn_01"
    }
  }
}`,
  },
  {
    id: "frame-006",
    timestamp: "10:42:21.212",
    direction: "agent-stderr",
    kind: "stderr",
    sessionId: "sess_6b6a",
    summary: "agent stderr 只作为旁路观察，不进入协议解析",
    bytes: 118,
    raw: "[zcode-agent] model provider ready provider=glm model=glm-4.7",
  },
  {
    id: "frame-007",
    timestamp: "10:42:22.842",
    direction: "agent-to-app",
    kind: "notification",
    method: "session/event",
    sessionId: "sess_6b6a",
    inputId: "inp_a31c",
    summary: "assistant text part delta",
    bytes: 532,
    raw: `{
  "method": "session/event",
  "params": {
    "sessionId": "sess_6b6a",
    "seq": 8,
    "payload": {
      "type": "message.part.delta",
      "inputId": "inp_a31c",
      "delta": "可以，用 traffic inspector 看。"
    }
  }
}`,
  },
  {
    id: "frame-008",
    timestamp: "10:42:24.509",
    direction: "agent-to-app",
    kind: "notification",
    method: "session/event",
    sessionId: "sess_6b6a",
    inputId: "inp_a31c",
    summary: "turn.completed，UI 用 inputId 收口",
    bytes: 604,
    raw: `{
  "method": "session/event",
  "params": {
    "sessionId": "sess_6b6a",
    "seq": 12,
    "payload": {
      "type": "turn.completed",
      "inputId": "inp_a31c",
      "resultType": "success"
    }
  }
}`,
  },
];
