import { useMemo } from "react";
import { WrenchIcon } from "lucide-react";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { getMcpPermissionReason, getMcpPermissionToolName } from "./permissionDialogModel.js";

const MCP_PERMISSION_TOOL_ICON = <WrenchIcon className="size-4 shrink-0 text-foreground-subtle" />;

/**
 * MCP 权限请求不是普通未知工具：单独展示 MCP 名称和协议里的 reason，
 * 不走 fallback 的 raw JSON，避免审批时读调试 payload。
 */
export function McpPermissionBlock(context: ToolCallBlockRenderContext) {
  const { toolCall } = context.toolCallNode;
  const toolName = getMcpPermissionToolName(toolCall) ?? toolCall.title ?? toolCall.kind;
  const reason = getMcpPermissionReason(toolCall);
  const hasKindLabelOverride = context.kindLabelOverride != null;
  const primaryText = useMemo(
    () =>
      hasKindLabelOverride ? (
        <span className="min-w-0 truncate text-foreground-subtle">{toolName}</span>
      ) : reason ? (
        <span className="min-w-0 truncate text-foreground-subtle">{reason}</span>
      ) : null,
    [hasKindLabelOverride, reason, toolName],
  );

  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={MCP_PERMISSION_TOOL_ICON}
      showIcon={context.showIcon !== false}
      canToggle={false}
      kindLabel={context.kindLabelOverride ?? toolName}
      primaryText={primaryText}
      isRunning={context.isRunning}
      content={null}
    />
  );
}
