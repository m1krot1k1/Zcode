import { formatBotMessage } from "../../messages.js";
import type { BotOutboundMessage } from "@zcode/shared";
import type { BotStreamingReplyCardState } from "../types.js";
import { formatSelectionCommand, isRecord } from "./common.js";

// 修复原因：飞书 Card JSON 2.0 最多允许 200 个组件或元素。预留 20 个元素给
// 状态行和服务端计数差异，避免长任务在更新阶段被 11310 拒绝后整轮熔断。
const FEISHU_STREAMING_CARD_TAGGED_ELEMENT_BUDGET = 180;

export function addGroupCardContext(
  card: Record<string, unknown>,
  message: BotOutboundMessage,
): Record<string, unknown> {
  const bodyMentions = new Set(
    message.contentParts?.flatMap((part) =>
      part.type === "channelMention" ? [part.targetId] : [],
    ) ?? [],
  );
  if (message.contentParts && isRecord(card.body)) {
    card.body.elements = [
      {
        tag: "markdown",
        content: message.contentParts
          .map((part) =>
            part.type === "channelMention"
              ? `<at id=${part.targetId}></at>`
              : part.text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
          )
          .join(""),
      },
    ];
  }
  // 只接受服务注入的个人 ID，不把正文/姓名解析成提醒，也不允许 all 扩大通知范围。
  const ids = [...new Set(message.mentionedUserIds ?? [])].filter(
    (id) => /^ou_[a-zA-Z0-9_-]+$/u.test(id) && !bodyMentions.has(id),
  );
  if (
    message.providerUserId.startsWith("oc_") &&
    ids.length &&
    isRecord(card.body) &&
    Array.isArray(card.body.elements)
  ) {
    card.body.elements.unshift({
      tag: "markdown",
      content: ids.map((id) => `<at id=${id}></at>`).join(" "),
    });
  }
  if (!message.groupCard) return card;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!isRecord(node)) return;
    if (isRecord(node.value) && typeof node.value.command === "string")
      node.value = { ...node.value, groupCard: message.groupCard };
    for (const value of Object.values(node)) visit(value);
  };
  visit(card);
  return card;
}

export function buildFeishuInteractiveCardPayload(
  message: BotOutboundMessage,
): Record<string, unknown> {
  return addGroupCardContext(buildFeishuInteractiveCardPayloadBody(message), message);
}

export function formatFeishuCardMarkdownContent(text: string): string {
  const lines: Array<{ text: string; hardBreak: boolean }> = [];
  let inCodeFence = false;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      inCodeFence = !inCodeFence;
    }
    if (!inCodeFence && /^-{3,}$/.test(line.trim())) {
      if (lines.length > 0 && lines.at(-1)?.text !== "") {
        lines.push({ text: "", hardBreak: false });
      }
      lines.push({ text: "---", hardBreak: false }, { text: "", hardBreak: false });
      continue;
    }
    lines.push({ text: line, hardBreak: !inCodeFence });
  }
  return lines
    .map((line, index) => {
      if (!line.text || !line.hardBreak || index >= lines.length - 1 || !lines[index + 1]?.text) {
        return line.text;
      }
      // Bugfix: Card JSON 2.0 的 markdown 按标准 Markdown 处理单换行，会把 /status 多行文本折成一行。
      // 飞书通道内把普通单换行转成 hard break，保留业务层给其他 bot 使用的原始文本。
      return `${line.text}  `;
    })
    .join("\n");
}

export function buildFeishuButtonElement(params: {
  text: string;
  type: "default" | "primary";
  command: string;
  originalText: string;
}): Record<string, unknown> {
  return {
    tag: "button",
    text: {
      tag: "plain_text",
      content: params.text,
    },
    type: params.type,
    // Bugfix: Card JSON 2.0 不再支持旧版 action/actions 容器。
    // 按钮必须直接作为 body.elements 组件，并通过 behaviors.callback 回传业务值，否则飞书会返回 HTTP 400。
    behaviors: [
      {
        type: "callback",
        value: {
          command: params.command,
          zcodeCardText: params.originalText,
        },
      },
    ],
  };
}

export function buildFeishuInteractiveCardPayloadBody(
  message: BotOutboundMessage,
): Record<string, unknown> {
  const selection = message.selection;
  if (selection?.action === "queue.cancel") {
    return {
      schema: "2.0",
      config: { wide_screen_mode: true },
      body: {
        padding: "8px 12px 8px 12px",
        elements: [
          {
            tag: "column_set",
            flex_mode: "none",
            horizontal_spacing: "8px",
            columns: [
              {
                tag: "column",
                width: "weighted",
                weight: 1,
                vertical_align: "center",
                elements: [
                  {
                    tag: "markdown",
                    content: formatFeishuCardMarkdownContent(message.text),
                  },
                ],
              },
              {
                tag: "column",
                width: "auto",
                vertical_align: "center",
                elements: selection.options.map((option) =>
                  buildFeishuButtonElement({
                    text: option.label,
                    type: "default",
                    command: formatSelectionCommand(selection, option.id),
                    originalText: message.text,
                  }),
                ),
              },
            ],
          },
        ],
      },
    };
  }
  const elements: Array<Record<string, unknown>> = [
    {
      tag: "markdown",
      content: formatFeishuCardMarkdownContent(message.text),
    },
  ];
  if (selection) {
    elements.push(
      ...selection.options.map((option, index) =>
        buildFeishuButtonElement({
          text: option.label || String(index + 1),
          type: "primary",
          command: formatSelectionCommand(selection, option.id),
          originalText: message.text,
        }),
      ),
      ...(selection.showCancel === false
        ? []
        : [
            buildFeishuButtonElement({
              text:
                selection.cancelLabel ?? formatBotMessage(message.locale, "selectionCancelOption"),
              type: "default",
              // Bugfix: 飞书走结构化选项卡，不应复用微信纯文本菜单的 0 取消语义。
              command: "/cancel",
              originalText: message.text,
            }),
          ]),
    );
  }
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    body: { elements },
  };
}

function formatFeishuStreamingStatus(state: BotStreamingReplyCardState): string {
  // Bugfix: 流式卡片状态行由 provider 生成，必须读取 BotService 传入的 locale，
  // 否则中文环境里会固定显示 Running/Completed。
  const locale = state.locale;
  const status = state.status;
  if (status === "completed") {
    return formatBotMessage(locale, "streamingStatusCompleted");
  }
  if (status === "error") {
    return formatBotMessage(locale, "streamingStatusFailed");
  }
  return formatBotMessage(locale, "streamingStatusRunning");
}

function buildFeishuStreamingToolPanel(
  toolSummaries: readonly string[],
  options: { expanded: boolean; title: string },
): Record<string, unknown> | null {
  const summaries = toolSummaries
    .map((summary) => summary.trim())
    .filter((summary) => summary.length > 0);
  if (summaries.length === 0) {
    return null;
  }
  return {
    tag: "collapsible_panel",
    // Bugfix: 流式卡片运行中需要让用户看到当前工具摘要；任务终态后再自动收起，减少最终消息占用空间。
    expanded: options.expanded,
    // Bugfix: Tool summaries 之前只是裸 collapsible panel，和正文没有清晰视觉边界。
    // 飞书 Card JSON 2.0 的折叠面板本身支持背景与边框，这里把它作为 <tools> 容器承载 header/content。
    background_color: "grey-50",
    border: {
      color: "grey",
      corner_radius: "8px",
    },
    padding: "8px 8px 8px 8px",
    header: {
      title: {
        tag: "plain_text",
        content: `🛠️ ${options.title} (${summaries.length})`,
      },
      vertical_align: "center",
      padding: "8px 8px 8px 8px",
      icon: {
        tag: "standard_icon",
        token: "down-small-ccm_outlined",
        color: "grey",
        size: "16px 16px",
      },
      icon_position: "right",
      icon_expanded_angle: -180,
    },
    elements: [
      {
        tag: "markdown",
        content: formatFeishuCardMarkdownContent(summaries.join("\n")),
      },
    ],
  };
}

export function buildFeishuStreamingCardPayload(
  state: BotStreamingReplyCardState,
): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [];
  for (const block of state.blocks) {
    if (block.type === "message") {
      const text = block.text.trim();
      if (text) {
        elements.push({
          tag: "markdown",
          content: formatFeishuCardMarkdownContent(text),
        });
      }
      continue;
    }
    const toolPanel = buildFeishuStreamingToolPanel(block.summaries, {
      expanded: block.expanded ?? state.status === "running",
      title: block.title?.trim() || formatBotMessage(state.locale, "streamingToolSummaries"),
    });
    if (toolPanel) {
      elements.push(toolPanel);
    }
  }
  if (elements.length === 0) {
    elements.push({
      tag: "markdown",
      content: " ",
    });
  }
  if (state.status !== "sealed") {
    elements.push({
      tag: "markdown",
      content: formatFeishuCardMarkdownContent(formatFeishuStreamingStatus(state)),
    });
  }
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    body: { elements },
  };
}

function countTaggedElements(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countTaggedElements(item), 0);
  }
  if (!value || typeof value !== "object") {
    return 0;
  }
  const record = value as Record<string, unknown>;
  return (
    (typeof record.tag === "string" ? 1 : 0) +
    Object.values(record).reduce<number>((total, item) => total + countTaggedElements(item), 0)
  );
}

export function countFeishuCardTaggedElements(state: BotStreamingReplyCardState): number {
  return countTaggedElements(buildFeishuStreamingCardPayload(state));
}

export function splitFeishuStreamingCardStates(
  state: BotStreamingReplyCardState,
): BotStreamingReplyCardState[] {
  const blockGroups: BotStreamingReplyCardState["blocks"][] = [];
  let current: BotStreamingReplyCardState["blocks"] = [];
  for (const block of state.blocks) {
    const candidate = [...current, block];
    // 始终为状态行预留预算，使 running/completed 切换不会改变既有分段边界。
    const candidateState = {
      ...state,
      blocks: candidate,
      status: "running" as const,
    };
    if (
      current.length > 0 &&
      countFeishuCardTaggedElements(candidateState) > FEISHU_STREAMING_CARD_TAGGED_ELEMENT_BUDGET
    ) {
      blockGroups.push(current);
      current = [block];
    } else {
      current = candidate;
    }
  }
  blockGroups.push(current);
  return blockGroups.map((blocks, index) => ({
    ...state,
    blocks,
    status: index === blockGroups.length - 1 ? state.status : "sealed",
  }));
}
