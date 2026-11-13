export const protocolSurfaces = [
  {
    id: "transport",
    title: "Transport Envelope",
    summary:
      "轻量 JSON-RPC 风格：request 有 id/method/params/trace，notification 有 method/params/trace，response 有 id/result 或 id/error。",
    fields: [
      "id",
      "method",
      "params",
      "trace.traceId",
      "trace.parentId",
      "trace.spanId",
      "trace.traceparent",
    ],
    conceptIds: ["traceId", "eventEnvelope"],
  },
  {
    id: "session-methods",
    title: "Session APIs",
    summary:
      "session/create/resume/read/subscribe/send/stop/fork/compact/rewind/close。协议实体叫 session，不叫 task。",
    fields: ["session/create", "session/read", "session/subscribe", "session/send", "session/stop"],
    conceptIds: ["sessionId", "sessionSend", "eventSeq"],
  },
  {
    id: "state-methods",
    title: "State Mutation APIs",
    summary:
      "会话模型选择、思考深度和模式由 agent server 维护；Provider 配置由 Environment Config 与进程 Registry 管理。",
    fields: [
      "session/setModel",
      "session/setThoughtLevel",
      "session/setMode",
      "workspace/readPresentation",
    ],
    conceptIds: ["sessionId", "workspaceKey"],
  },
  {
    id: "blocking",
    title: "Blocking Interactions",
    summary:
      "权限和用户输入走 server-to-client request，host 负责 owner 路由与 pending request 恢复。",
    fields: ["interaction/requestPermission", "interaction/requestUserInput", "pendingRequestIds"],
    conceptIds: ["permissionRequest", "deliveryKind", "sessionId"],
  },
];
