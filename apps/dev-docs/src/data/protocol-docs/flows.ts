import type { FlowStep } from "./types.js";

export const flows: FlowStep[] = [
  {
    id: "create-session",
    title: "创建会话",
    actor: "UI -> host -> agent server",
    detail:
      "UI 调用 session/create，传 workspace/mode/model。server 生成 sessionId 和 root traceContext，返回 SessionStateSnapshot。",
    conceptIds: ["sessionId", "traceId", "workspaceKey"],
  },
  {
    id: "send-input",
    title: "提交输入",
    actor: "UI",
    detail:
      "UI 为本次输入生成 inputId，写入 activeInputId，然后调用 session/send({ sessionId, inputId, content })。",
    conceptIds: ["inputId", "activeInputId", "sessionSend"],
  },
  {
    id: "ack-background",
    title: "立即 ACK",
    actor: "agent server",
    detail:
      "session/send 只确认收到输入，不等待模型输出。后台 turn 继续运行，状态变化由 events/state.updated 推送。",
    conceptIds: ["sessionSend", "eventEnvelope"],
  },
  {
    id: "turn-events",
    title: "事件回流",
    actor: "agent runtime -> host -> UI",
    detail:
      "turn.started/completed/failed payload 回带 inputId；event envelope 保留 traceId 和 seq。",
    conceptIds: ["inputId", "traceId", "eventSeq"],
  },
  {
    id: "terminal-guard",
    title: "终态收口",
    actor: "UI projection",
    detail:
      "completed/failed 只有在 event.inputId 匹配 activeInputId 时才能关闭当前 assistant。旧 input 的迟到事件会被忽略。",
    conceptIds: ["activeInputId", "inputId", "taskRuntimeState"],
  },
  {
    id: "remote-replay",
    title: "远控恢复",
    actor: "web remote",
    detail:
      "web-remote-replayable 使用 snapshot + afterSeq + mirror batch 恢复。legacy runId 字段按 inputId 语义处理。",
    conceptIds: ["deliveryKind", "eventSeq", "taskStreamMirrorBatch"],
  },
];
