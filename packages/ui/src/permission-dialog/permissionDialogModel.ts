// 权限确认窗的纯展示模型：选项文案、预览块分流、合成 toolCall 与块 render context。
// 从 PermissionDialog.tsx 拆出，保持原有分流顺序与注释里的产品规则不变。

import type { ReactNode } from "react";
import {
  OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME,
  WORKFLOW_REFINE_PERMISSION_OPTION_ID,
  type PermissionRequestPreview,
  type ZCodePermissionOption,
  type ZCodePermissionRequest,
  type ZCodeProvider,
} from "@zcode/shared";
import {
  getPermissionOptionDisplayKind,
  type PermissionRequestScope,
} from "@/lib/permissionRequest.js";
import type { TaskChatToolCall } from "@/lib/taskChatMessageTypes.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { isPlainRecord, readRawToolCallInput } from "@/ToolCallBlocks/fileSummaryTypes.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import { isSaveWorkflowToolCall } from "@/lib/workflowToolNames.js";

export type PermissionBlockKind =
  | "edit"
  | "execute"
  | "mcp"
  | "web-fetch"
  | "search"
  | "skill"
  | "workflow"
  | "saveWorkflow"
  | "fallback";

interface PermissionBlockInteraction {
  canToggle: boolean;
  forceOpen: boolean;
}

export interface PermissionRuleScope {
  display: string;
  truncated: boolean;
}

const PERMISSION_RULE_SCOPE_MAX_DISPLAY_CHARS = 160;
const NON_USER_FACING_PERMISSION_REASONS = new Set([
  "High risk tools require explicit approval",
  "Tool has side effects and requires approval",
]);

function formatPermissionRuleScope(content: string): PermissionRuleScope {
  const lineBreakIndex = content.search(/\r?\n/);
  const firstLine = lineBreakIndex === -1 ? content : content.slice(0, lineBreakIndex);
  const truncated =
    lineBreakIndex !== -1 || firstLine.length > PERMISSION_RULE_SCOPE_MAX_DISPLAY_CHARS;

  const suffix = " …";
  const visible = firstLine
    .slice(0, PERMISSION_RULE_SCOPE_MAX_DISPLAY_CHARS - suffix.length)
    .trimEnd();
  return { display: `${visible}${suffix}`, truncated };
}

export function readPermissionRuleScopes(option: ZCodePermissionOption): PermissionRuleScope[] {
  const scopes: PermissionRuleScope[] = [];
  for (const update of option.response?.permissionUpdates ?? []) {
    if (update.type !== "addRules" || update.behavior !== "allow") continue;
    for (const rule of update.rules) {
      if (rule.toolName.toLowerCase() !== "bash") continue;
      const content = rule.ruleContent?.trim();
      if (!content?.endsWith(":*")) continue;
      scopes.push(formatPermissionRuleScope(content.slice(0, -2)));
    }
  }
  return scopes.slice(0, 5);
}

export function isOfficialCuaProjectPermission(option: ZCodePermissionOption): boolean {
  return (option.response?.permissionUpdates ?? []).some(
    (update) =>
      update.type === "addRules" &&
      update.behavior === "allow" &&
      update.rules.some((rule) => rule.toolName === OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME),
  );
}

/**
 * workflow Refine（拒绝并附修改意见）。
 * 该选项不渲染成按钮，而是作为反馈行的应答目标：用户在其他确认窗同一行编号输入行里写修改意见，
 * 提交时应答携带 freeText，CLI broker 据此把 deny 升级为带 workflow_refine_feedback 的用户反馈。
 */
export function isWorkflowRefineOption(option: ZCodePermissionOption): boolean {
  return option.optionId === WORKFLOW_REFINE_PERMISSION_OPTION_ID;
}

export function getOptionLabelMessageId(kind: string): string | null {
  switch (getPermissionOptionDisplayKind(kind)) {
    case "allowOnce":
      return "chat.permission.approve";
    case "allowAlways":
      return "chat.permission.approveAlways";
    case "rejectOnce":
      return "chat.permission.deny";
    case "rejectAlways":
      return "chat.permission.denyAlways";
    default:
      return null;
  }
}

const PROVIDER_PERMISSION_OPTION_NAME_LABELS: Partial<
  Record<ZCodeProvider, Record<string, string>>
> = {
  glm: {
    // GLM/ZCode Agent 通过 ZCode Agent 发来的项目级记忆授权文案是英文原文。
    // 这里把已知 provider-native 权限文案统一归一到 i18n，避免被当成自定义选项直出英文。
    "always allow in this project": "chat.permission.allowForProject",
  },
};

interface PermissionOptionNameMessageIds {
  label: string;
  /** 按 name 命中时可覆盖 kind 推导的描述：会话级选项不能沿用「相同请求不再询问」的项目级文案。 */
  description?: string;
}

const GLOBAL_PERMISSION_OPTION_NAME_LABELS: Record<string, PermissionOptionNameMessageIds> = {
  "full access": {
    label: "chat.permission.fullAccess",
    description: "chat.permission.fullAccess.description",
  },
  "always allow in this project": { label: "chat.permission.allowForProject" },
  "always allow computer use in this project": { label: "chat.permission.cua.allowForProject" },
  // workflow 运行确认窗的会话免确认：
  // CLI 侧 name 是匹配键，wire kind 是 allowAlways（排序 / 样式同 always allow）。
  "always allow in this session": {
    label: "chat.permission.workflow.allowForSession",
    description: "chat.permission.workflow.allowForSession.description",
  },
};

export function getProviderOptionNameMessageIds(
  provider: ZCodeProvider | undefined,
  name: string,
): PermissionOptionNameMessageIds | null {
  const normalizedName = name.trim().replace(/\s+/g, " ").toLowerCase();
  const global = GLOBAL_PERMISSION_OPTION_NAME_LABELS[normalizedName];
  if (global) {
    return global;
  }
  const providerLabel = provider
    ? PROVIDER_PERMISSION_OPTION_NAME_LABELS[provider]?.[normalizedName]
    : undefined;
  return providerLabel ? { label: providerLabel } : null;
}

export function getOptionDescriptionMessageId(
  kind: string,
  scope: PermissionRequestScope,
): string | null {
  switch (getPermissionOptionDisplayKind(kind)) {
    case "allowOnce":
      return "chat.permission.allowOnce.description";
    case "allowAlways":
      return `chat.permission.allowAlways.description.${scope}`;
    case "rejectOnce":
      return "chat.permission.denyOnce.description";
    case "rejectAlways":
      return `chat.permission.denyAlways.description.${scope}`;
    default:
      return null;
  }
}

export function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readUserFacingPermissionReason(value: unknown): string | null {
  const reason = readNonEmptyString(value);
  // 通用权限策略原因用于协议诊断，不是能帮助用户判断本次操作的具体说明。
  // 之前 UI 无差别展示 reason，导致权限弹窗重复出现和“等待确认”语义相同的英文文案。
  return reason && !NON_USER_FACING_PERMISSION_REASONS.has(reason) ? reason : null;
}

export function getPermissionDisplayReason(request: ZCodePermissionRequest): string | null {
  const rawInput = readRawToolCallInput(request.raw);
  const inputReason = isPlainRecord(rawInput)
    ? (readUserFacingPermissionReason(rawInput.description) ??
      readUserFacingPermissionReason(rawInput.reason) ??
      readUserFacingPermissionReason(rawInput.summary))
    : null;
  const rawReason = isPlainRecord(request.raw)
    ? readUserFacingPermissionReason(request.raw.reason)
    : null;

  return inputReason ?? readUserFacingPermissionReason(request.description) ?? rawReason;
}

export function getMcpPermissionToolName(toolCall: TaskChatToolCall): string | null {
  const rawToolName = isPlainRecord(toolCall.raw)
    ? (readNonEmptyString(toolCall.raw.toolName) ?? readNonEmptyString(toolCall.raw.tool_name))
    : null;
  const toolName =
    readNonEmptyString(toolCall.toolName) ??
    rawToolName ??
    readNonEmptyString(toolCall.kind) ??
    readNonEmptyString(toolCall.title);

  return toolName?.startsWith("mcp__") ? toolName : null;
}

export function getMcpPermissionReason(toolCall: TaskChatToolCall): string | null {
  return isPlainRecord(toolCall.raw) ? readNonEmptyString(toolCall.raw.reason) : null;
}

export function resolvePermissionBlockKind(
  preview: PermissionRequestPreview,
  toolCall: TaskChatToolCall,
  rawFileSummaries: ToolCallBlockRenderContext["rawFileSummaries"],
): PermissionBlockKind {
  // SaveWorkflow 按**工具名**最先判定，早于文件摘要与 family 分流。它归一化入参里带着 `path`
  // 与完整 `script`，任何一条「看起来像写文件」的启发式都可能把它吸进 edit 块；而 workflow
  // family 一旦登记这个名字，它又会掉进运行确认块（图 + Refine，对一次写盘完全是错的语言）。
  if (isSaveWorkflowToolCall(toolCall)) {
    return "saveWorkflow";
  }

  if (rawFileSummaries.length > 0 || preview.fileChanges.length > 0) {
    return "edit";
  }

  const identity = resolveToolCallIdentity(toolCall);

  if (getMcpPermissionToolName(toolCall)) {
    // MCP 权限请求不是普通未知工具；以前走 fallback 会把 raw JSON 摊开，并把工具名显示两次。
    // 这里单独展示 MCP 名称和协议里的 reason，避免用户在审批时读调试 payload。
    return "mcp";
  }

  // 权限弹窗之前单独猜 kind/title/rawInput.skill，和聊天区分流规则会漂移。
  // 这里复用固定 tool identity，让 Skill 权限请求在确认前后都走同一套语义。
  if (identity.family === "skill") {
    return "skill";
  }

  if (identity.family === "workflow") {
    // 工作流确认窗的主体是因果图 + 折叠脚本，和聊天区同一 tool identity 分流；
    // 必须早于 search/execute 判定，否则脚本里的命令片段会把它误判成普通命令确认。
    return "workflow";
  }

  if (identity.family === "web-fetch") return "web-fetch";
  if (identity.family === "search") {
    // WebFetch/WebSearch 权限请求以前落到 fallback，会把整包 toolCall JSON 打出来。
    // 这里和聊天区一样走 search renderer，只展示用户关心的 URL/query 摘要。
    return "search";
  }

  if (preview.command) {
    return "execute";
  }

  return "fallback";
}

function getPermissionBlockInteraction(blockKind: PermissionBlockKind): PermissionBlockInteraction {
  switch (blockKind) {
    case "edit":
      return {
        canToggle: false,
        forceOpen: false,
      };
    case "mcp":
    case "skill":
    case "web-fetch":
    case "search":
    case "execute":
    case "workflow":
    case "saveWorkflow":
    case "fallback":
      // 这里是权限弹窗的中间态展示，不提供收起/展开交互，避免用户把关键内容藏起来。
      // workflow / saveWorkflow 只为穷尽性列在这里：它们由各自的专用块直接渲染，不走通用块，
      // 块内脚本折叠是 spec 记录的刻意例外（图、名称与落点仍不可折叠）。
      return {
        canToggle: false,
        forceOpen: true,
      };
  }
}

export function buildPermissionToolCall(
  request: ZCodePermissionRequest,
  preview: PermissionRequestPreview,
): TaskChatToolCall {
  const rawInput = readRawToolCallInput(request.raw);

  return {
    toolId: `permission:${request.requestId}`,
    kind: request.kind,
    title: request.title ?? request.description ?? preview.title,
    input: rawInput ?? preview.command ?? request.raw,
    status: "completed",
    raw: request.raw,
  };
}

export function buildPermissionBlockContext(
  toolCall: TaskChatToolCall,
  rawFileSummaries: ToolCallBlockRenderContext["rawFileSummaries"],
  workspacePath: string,
  blockKind: PermissionBlockKind,
  kindLabelOverride: ReactNode,
  theme: ToolCallBlockRenderContext["theme"],
  codePreviewSettings: ToolCallBlockRenderContext["codePreviewSettings"],
): ToolCallBlockRenderContext {
  const { canToggle, forceOpen } = getPermissionBlockInteraction(blockKind);

  return {
    nestedToolRenderer: ToolCallBlock,
    toolCallNode: {
      toolCall,
      childToolCalls: [],
    } as ToolCallBlockRenderContext["toolCallNode"],
    workspacePath,
    // store 耦合剥离：展示组件不再自取 store，主题/代码预览设置由对话框宿主注入。
    theme,
    codePreviewSettings,
    displayModel: {
      inlinePreview: { type: "none" },
      planResult: null,
      viewerSource: null,
      viewerLabelId: "codeViewer.viewCode",
      showSummaryFileLink: false,
      showInput: false,
      showOutput: false,
      showKind: false,
    },
    viewerSource: null,
    rawFileSummaries,
    // 权限弹窗等待用户确认时工具还没有执行，不能复用 running 状态。
    // 之前 Bash 权限会显示“执行中”并带 loading，遮住真正的申请原因。
    isRunning: false,
    // 权限预览使用合成 completed 节点，必须显式区分，避免误报“没有输出”。
    isPermissionPreview: true,
    statusLabel: "",
    childToolList: null,
    showIcon: true,
    kindLabelOverride,
    canToggle,
    forceOpen,
    onOpenCodeViewer: undefined,
    onOpenBrowserUrl: undefined,
  };
}

/**
 * 保存确认窗：聚焦滚动区里最后一个控件（区内只有展开钮与脚本开关）。区不在或没有控件即返回 false，
 * 交回选项列表自己的循环。
 */
export function focusLastSaveWorkflowControl(root: HTMLElement | null): boolean {
  const controls = root?.querySelectorAll<HTMLElement>(
    "[data-permission-dialog-scroll] button:not([disabled])",
  );
  const last = controls === undefined ? undefined : controls[controls.length - 1];
  if (last === undefined) return false;
  last.focus();
  return true;
}
