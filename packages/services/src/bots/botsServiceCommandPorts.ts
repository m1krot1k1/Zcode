import type { BotCommand, BotInboundMessage, BotOutboundMessage } from "@zcode/shared";

export interface BotsServiceCommandPorts {
  handleApproveCommand(
    message: BotInboundMessage,
    command: Extract<BotCommand, { type: "approve" }>,
  ): Promise<BotOutboundMessage[]>;
  handleConfigListCommand(
    message: BotInboundMessage,
    command: Extract<BotCommand, { type: "mode.list" | "thoughtLevel.list" }>,
  ): Promise<BotOutboundMessage[]>;
  handleConfigSetCommand(
    message: BotInboundMessage,
    command: Extract<BotCommand, { type: "mode.set" | "thoughtLevel.set" }>,
  ): Promise<BotOutboundMessage[]>;
  handleDenyCommand(
    message: BotInboundMessage,
    command: Extract<BotCommand, { type: "deny" }>,
  ): Promise<BotOutboundMessage[]>;
  handleElicitationRespondCommand(
    message: BotInboundMessage,
    command: Extract<BotCommand, { type: "elicitation.respond" }>,
  ): Promise<BotOutboundMessage[]>;
  handleElicitationSubmitCommand(
    message: BotInboundMessage,
    command: Extract<BotCommand, { type: "elicitation.submit" }>,
  ): Promise<BotOutboundMessage[]>;
  handleModelListCommand(
    message: BotInboundMessage,
    command: Extract<BotCommand, { type: "model.list" }>,
  ): Promise<BotOutboundMessage[]>;
  handleModelProviderSetCommand(
    message: BotInboundMessage,
    command: Extract<BotCommand, { type: "model.provider.set" }>,
  ): Promise<BotOutboundMessage[]>;
  handleModelSetCommand(
    message: BotInboundMessage,
    command: Extract<BotCommand, { type: "model.set" }>,
  ): Promise<BotOutboundMessage[]>;
  handleNewCommand(
    message: BotInboundMessage,
    command: Extract<BotCommand, { type: "new" }>,
  ): Promise<BotOutboundMessage[]>;
  handlePermissionRespondCommand(
    message: BotInboundMessage,
    command: Extract<BotCommand, { type: "permission.respond" }>,
  ): Promise<BotOutboundMessage[]>;
  handleReplyListCommand(
    message: BotInboundMessage,
    command: Extract<BotCommand, { type: "reply.list" }>,
  ): Promise<BotOutboundMessage[]>;
  handleReplySetCommand(
    message: BotInboundMessage,
    command: Extract<BotCommand, { type: "reply.set" }>,
  ): Promise<BotOutboundMessage[]>;
  handleStopCommand(
    message: BotInboundMessage,
    command: Extract<BotCommand, { type: "stop" }>,
  ): Promise<BotOutboundMessage[]>;
  handleTaskSetCommand(
    message: BotInboundMessage,
    command: Extract<BotCommand, { type: "task.set" }>,
  ): Promise<BotOutboundMessage[]>;
  handleTopicLeaveCommand(
    message: BotInboundMessage,
    command: Extract<BotCommand, { type: "topic.leave" }>,
  ): Promise<BotOutboundMessage[]>;
  handleUnknownCommand(
    message: BotInboundMessage,
    command: Extract<BotCommand, { type: "unknown" }>,
  ): Promise<BotOutboundMessage[]>;
  handleWorkspaceListCommand(
    message: BotInboundMessage,
    command: Extract<BotCommand, { type: "workspace.list" }>,
  ): Promise<BotOutboundMessage[]>;
  handleWorkspaceSetCommand(
    message: BotInboundMessage,
    command: Extract<BotCommand, { type: "workspace.set" }>,
  ): Promise<BotOutboundMessage[]>;
}
