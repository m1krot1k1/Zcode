// ProductProjection 域模块：onPermissionRequested, createPendingInteractionFromPermissionEvent, onPermissionResolved, onPermissionDenied 等。
// 函数签名为 (self, ...原方法参数)，方法体从 ProductProjection 原样移出；
// 只依赖上下文接口与类型基座，跨域调用一律经 self 上的方法，不直接 import 其它域模块。

import { PERMISSION_FULL_ACCESS_OPTION_ID } from "@zcode/shared/zcode-protocol-v4";
import type {
  PermissionDeniedPayload,
  PermissionRequestedPayload,
  PermissionResolvedPayload,
  SessionEvent,
  UserInputAutoResolutionUpdatedPayload,
  WorkspaceHookAdmissionUpdatedPayload,
  WorkspaceHookReviewRequestedPayload,
  WorkspaceHookReviewSettledPayload,
  WorkspaceHookReviewSupersededPayload,
} from "@zcode/contracts";
import { AMEND_WORKFLOW_TOOL_NAME, CREATE_WORKFLOW_TOOL_NAME } from "@zcode/contracts";
import { WORKFLOW_REFINE_PERMISSION_OPTION_ID } from "@zcode/shared";
import { verdictWorkspaceHookReviewRequest } from "@zcode/shared/workspace-hook-review-monotonicity";
import type {
  ConversationDelta,
  PendingInteraction,
  ToolCallRow,
  UserInputQuestionPayload,
} from "@zcode/shared/zcode-protocol-v4";
import { workspaceHookReviewRequestPayloadSchema } from "@zcode/shared/zcode-protocol-v4";
import {
  SESSION_ALLOW_PERMISSION_OPTION_KIND,
  buildProtocolPermissionOptions,
} from "../permission-options.js";
import {
  MCP_ELICITATION_INTERACTION,
  MCP_ELICITATION_TOOL_NAME,
  mcpElicitationQuestions,
} from "./mcp-elicitation.js";
import { toProtocolToolCallDisplay } from "./product-projection-types.js";
import type { ProductProjectionContext } from "./product-projection-context.js";

export function onPermissionRequested(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as PermissionRequestedPayload;
  const toolCallId = String(payload.toolCallId);
  const interactionId = payload.requestId ?? `perm-${toolCallId}`;
  const interaction = self.createPendingInteractionFromPermissionEvent(
    event,
    payload,
    toolCallId,
    interactionId,
  );
  const deltas: ConversationDelta[] = [];
  const row = self.findToolRow(toolCallId);
  if (row) {
    deltas.push({
      op: "row.upserted",
      row: {
        ...row,
        status: "pendingApproval",
        approvalInteractionId: interactionId,
      },
    });
  }
  deltas.push({
    op: "state.updated",
    patch: {
      pendingInteractions: [...self.snapshot.pendingInteractions, interaction],
    },
  });
  return deltas;
}

export function createPendingInteractionFromPermissionEvent(
  self: ProductProjectionContext,
  event: SessionEvent,
  payload: PermissionRequestedPayload,
  toolCallId: string,
  interactionId: string,
): PendingInteraction {
  if (isAskUserQuestionToolName(payload.toolName)) {
    // AskUserQuestion 的 permission_requested 只是 runtime 等待态；
    // v4 UI 需要结构化 questions 才能回填 answers，而不是 Allow/Deny 权限弹窗。
    return {
      interactionId,
      kind: "userInput",
      anchorRowId: self.toolRowIdByCallId.get(toolCallId) ?? null,
      createdAt: self.ms(event),
      payload: {
        kind: "userInput",
        prompt: payload.reason,
        freeText: true,
        toolCallId,
        toolName: payload.toolName,
        traceId: event.traceId,
        input: payload.input,
        schema: { toolName: payload.toolName },
        questions: readAskUserQuestionPayloadQuestions(payload.input),
        ...(payload.origin ? { origin: payload.origin } : {}),
      },
    };
  }
  if (payload.toolName === MCP_ELICITATION_TOOL_NAME) {
    // MCP elicitation：requestedSchema → 结构化问题，
    // 与 broker 用同一映射，v4 UI 复用 ElicitationDialog。
    const elicitation = isPlainRecord(payload.input) ? payload.input : {};
    return {
      interactionId,
      kind: "userInput",
      anchorRowId: self.toolRowIdByCallId.get(toolCallId) ?? null,
      createdAt: self.ms(event),
      payload: {
        kind: "userInput",
        prompt: payload.reason,
        freeText: true,
        toolCallId,
        toolName: payload.toolName,
        traceId: event.traceId,
        input: payload.input,
        schema: {
          interaction: MCP_ELICITATION_INTERACTION,
          serverName: elicitation.serverName,
          requestedSchema: elicitation.requestedSchema,
        },
        questions: mcpElicitationQuestions(payload.reason, elicitation.requestedSchema),
        ...(payload.origin ? { origin: payload.origin } : {}),
      },
    };
  }
  if (isExitPlanModeToolName(payload.toolName)) {
    // ExitPlanMode 复用 userInput/elicitation 通道承载计划审批反馈；
    // 普通 permission payload 无法表达 approve/custom feedback 的业务语义。
    return {
      interactionId,
      kind: "userInput",
      anchorRowId: self.toolRowIdByCallId.get(toolCallId) ?? null,
      createdAt: self.ms(event),
      payload: {
        kind: "userInput",
        prompt: payload.reason,
        freeText: true,
        toolCallId,
        toolName: payload.toolName,
        traceId: event.traceId,
        input: payload.input,
        schema: { interaction: "plan_approval", toolName: payload.toolName },
        questions: [createExitPlanModeApprovalQuestion(payload.reason)],
        ...(payload.origin ? { origin: payload.origin } : {}),
      },
    };
  }
  const askDisplay = toProtocolToolCallDisplay(payload.display);
  return {
    interactionId,
    kind: "permission",
    anchorRowId: self.toolRowIdByCallId.get(toolCallId) ?? null,
    createdAt: self.ms(event),
    payload: {
      kind: "permission",
      toolCallId,
      toolName: payload.toolName,
      summary: payload.reason,
      detail: payload.input,
      freeText: true,
      ...(payload.approvalMode !== "user-once" &&
      payload.fullAccessSupported === true &&
      !payload.origin &&
      !payload.optionsPolicy
        ? {
            fullAccessOption: {
              optionId: PERMISSION_FULL_ACCESS_OPTION_ID,
              label: "Full access",
              kind: "custom" as const,
              response: { decision: "deny" as const, reason: "Full access requires V4 approval" },
            },
          }
        : {}),
      ...(payload.origin ? { origin: payload.origin } : {}),
      ...(askDisplay ? { display: askDisplay } : {}),
      options: [
        ...buildProtocolPermissionOptions({
          approvalMode: payload.approvalMode,
          input: payload.input,
          suggestedPermissionUpdates: payload.suggestedPermissionUpdates,
          ...(payload.optionsPolicy ? { optionsPolicy: payload.optionsPolicy } : {}),
          toolName: payload.toolName,
        }).map((option) => ({
          optionId:
            option.kind === "allow_once"
              ? "allowOnce"
              : option.kind === "allow_always"
                ? "allowAlways"
                : option.optionId,
          label: option.name,
          // 会话免确认的 kind 映到闭集里的 allowAlways（排序槽位 / 样式与 always allow 同），
          // optionId 原样 allowSession——broker 靠它精确命中，GUI 靠 name 本地化。
          kind:
            option.kind === "allow_once"
              ? ("allowOnce" as const)
              : option.kind === "allow_always" ||
                  option.kind === SESSION_ALLOW_PERMISSION_OPTION_KIND
                ? ("allowAlways" as const)
                : ("deny" as const),
          response: option.response,
        })),
        // workflow Refine 只在 v4 投放（legacy 选项列表刻意不含，见 session-mapper 注释）。
        // 静态 response 是普通 deny：任何不认识该
        // optionId 的消费面（无 freeText 的应答）都退化为拒绝，反馈升级只发生在
        // interaction-broker 对 freeText 的特判里。
        ...(payload.toolName === CREATE_WORKFLOW_TOOL_NAME ||
        payload.toolName === AMEND_WORKFLOW_TOOL_NAME
          ? [
              {
                optionId: WORKFLOW_REFINE_PERMISSION_OPTION_ID,
                label: "Refine",
                kind: "custom" as const,
                response: { decision: "deny" as const, reason: "Denied" },
              },
            ]
          : []),
      ],
    },
  };
}

export function onPermissionResolved(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as PermissionResolvedPayload;
  return self.settlePermission(
    String(payload.toolCallId),
    payload.decision === "deny" ? "cancelled" : "running",
  );
}

export function onPermissionDenied(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as PermissionDeniedPayload;
  return self.settlePermission(String(payload.toolCallId), "cancelled");
}

export function onWorkspaceHookReviewRequested(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as WorkspaceHookReviewRequestedPayload;
  const request = workspaceHookReviewRequestPayloadSchema.parse(payload.request);
  const current = self.snapshot.pendingInteractions.find(
    (item) => item.payload.kind === "workspaceHookReview",
  );
  if (current?.payload.kind === "workspaceHookReview") {
    const verdict = verdictWorkspaceHookReviewRequest(current.payload, request);
    // 跨 flow 只能在 onSessionResumed 已清空旧 review 后接管（epoch 应用策略在
    // onSessionResumed）；其余 stale/replay/conflict 均不得覆盖或延长当前 authority。
    if (verdict !== "same_flow_advance") {
      return [];
    }
  }
  const interaction: PendingInteraction = {
    interactionId: request.interactionId,
    kind: "workspaceHookReview",
    anchorRowId: null,
    createdAt: request.createdAt,
    payload: request,
  };
  // 同 flow 的更高 generation 是唯一合法替换；Runtime 重启的跨 flow 接管必须先经过
  // SessionResumed 清旧 authority。这里仍原子替换，避免历史异常状态残留多个 review。
  const pendingInteractions = self.snapshot.pendingInteractions.filter(
    (item) => item.payload.kind !== "workspaceHookReview",
  );
  pendingInteractions.push(interaction);
  return [{ op: "state.updated", patch: { pendingInteractions } }];
}

export function onWorkspaceHookReviewSettled(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as WorkspaceHookReviewSettledPayload;
  return self.removeWorkspaceHookReview(payload.interactionId);
}

export function onWorkspaceHookReviewSuperseded(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as WorkspaceHookReviewSupersededPayload;
  return self.removeWorkspaceHookReview(payload.interactionId);
}

export function removeWorkspaceHookReview(
  self: ProductProjectionContext,
  interactionId: string,
): ConversationDelta[] {
  const pendingInteractions = self.snapshot.pendingInteractions.filter(
    (item) =>
      !(item.payload.kind === "workspaceHookReview" && item.interactionId === interactionId),
  );
  return pendingInteractions.length === self.snapshot.pendingInteractions.length
    ? []
    : [{ op: "state.updated", patch: { pendingInteractions } }];
}

export function onWorkspaceHookAdmissionUpdated(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as WorkspaceHookAdmissionUpdatedPayload;
  const workspaceHookAdmission =
    payload.pendingCount === 0
      ? null
      : {
          pendingCount: payload.pendingCount,
          bundleDigest: payload.bundleDigest,
          ...(payload.workspaceIdentity ? { workspaceIdentity: payload.workspaceIdentity } : {}),
        };
  return [{ op: "state.updated", patch: { workspaceHookAdmission } }];
}

export function onUserInputAutoResolutionUpdated(
  self: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as UserInputAutoResolutionUpdatedPayload;
  let changed = false;
  const pendingInteractions = self.snapshot.pendingInteractions.map((interaction) => {
    if (
      interaction.interactionId !== payload.interactionId ||
      interaction.payload.kind !== "userInput"
    ) {
      return interaction;
    }
    changed = true;
    return {
      ...interaction,
      autoResolution: payload.autoResolution,
    };
  });
  return changed ? [{ op: "state.updated", patch: { pendingInteractions } }] : [];
}

export function settlePermission(
  self: ProductProjectionContext,
  toolCallId: string,
  status: ToolCallRow["status"],
): ConversationDelta[] {
  const deltas: ConversationDelta[] = [];
  const row = self.findToolRow(toolCallId);
  if (row) {
    const next: ToolCallRow = { ...row, status };
    delete next.approvalInteractionId;
    deltas.push({ op: "row.upserted", row: next });
  }
  const remaining = self.snapshot.pendingInteractions.filter(
    (item) =>
      !(
        (item.payload.kind === "permission" || item.payload.kind === "userInput") &&
        item.payload.toolCallId === toolCallId
      ),
  );
  if (remaining.length !== self.snapshot.pendingInteractions.length) {
    deltas.push({
      op: "state.updated",
      patch: { pendingInteractions: remaining },
    });
  }
  return deltas;
}
function isAskUserQuestionToolName(value: string | undefined): boolean {
  return value === "AskUserQuestion";
}

function isExitPlanModeToolName(value: string | undefined): boolean {
  return value === "ExitPlanMode";
}

function createExitPlanModeApprovalQuestion(reason: string): UserInputQuestionPayload {
  return {
    question: reason,
    header: "Plan",
    options: [
      {
        value: "approve",
        label: "Approve",
        description: "Exit plan mode and start implementation.",
      },
    ],
  };
}

function readAskUserQuestionPayloadQuestions(input: unknown): UserInputQuestionPayload[] {
  const rawQuestions = readRawAskUserQuestions(input);
  return rawQuestions
    .map(normalizeAskUserQuestionPayloadQuestion)
    .filter((question): question is UserInputQuestionPayload => question !== null);
}

function readRawAskUserQuestions(input: unknown): unknown[] {
  if (!isPlainRecord(input)) {
    return [];
  }
  if (Array.isArray(input.questions)) {
    return input.questions;
  }
  return typeof input.question === "string" && Array.isArray(input.options) ? [input] : [];
}

function normalizeAskUserQuestionPayloadQuestion(
  value: unknown,
): UserInputQuestionPayload | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  const question = nonEmptyString(value.question);
  const header = nonEmptyString(value.header) ?? question;
  const rawOptions = Array.isArray(value.options) ? value.options : [];
  const options = rawOptions
    .map(normalizeAskUserQuestionPayloadOption)
    .filter((option): option is UserInputQuestionPayload["options"][number] => option !== null);
  if (!question || !header || options.length === 0) {
    return null;
  }
  return {
    question,
    header,
    options,
    ...(value.multiSelect === true ? { multiSelect: true } : {}),
  };
}

function normalizeAskUserQuestionPayloadOption(
  value: unknown,
): UserInputQuestionPayload["options"][number] | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  const label = nonEmptyString(value.label) ?? nonEmptyString(value.value);
  const optionValue = nonEmptyString(value.value) ?? label;
  if (!label || !optionValue) {
    return null;
  }
  return {
    value: optionValue,
    label,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.preview === "string" ? { preview: value.preview } : {}),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
