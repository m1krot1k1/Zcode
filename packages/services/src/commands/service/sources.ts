import { join, relative } from "node:path";
import {
  ZCODE_COMMAND_AGENT_SOURCE,
  ZCODE_COMMAND_AGENT_SOURCES,
  type CommandAgentSource,
  type CommandConfig,
  type SettingsDirectoryLocation,
  type SettingsDirectorySource,
  type UserCommand,
} from "@zcode/shared";
import type { CommandFileFormat } from "../commandFileParser.js";
import { resolveUserHomeDir } from "./userConfig.js";

export interface CommandAgentSourceDescriptor {
  agentSource: CommandAgentSource;
  directorySource: SettingsDirectorySource;
  userDirectorySegments: readonly string[];
  workspaceDirectorySegments: readonly string[];
  fileExtension: ".md" | ".toml";
  format: CommandFileFormat;
  namespaceSeparator: "/" | ":";
  supportsArgumentHint: boolean;
}

export const DEFAULT_COMMAND_AGENT_SOURCE: CommandAgentSource = ZCODE_COMMAND_AGENT_SOURCE;
const COMMAND_AGENT_SOURCE_ORDER: readonly CommandAgentSource[] = ZCODE_COMMAND_AGENT_SOURCES;

export const ZCODE_COMMAND_DESCRIPTOR: CommandAgentSourceDescriptor = {
  agentSource: "zcodeAgent",
  directorySource: "zcode",
  userDirectorySegments: [".zcode", "commands"],
  workspaceDirectorySegments: [".zcode", "commands"],
  fileExtension: ".md",
  format: "markdown",
  namespaceSeparator: "/",
  supportsArgumentHint: true,
};

const COMMAND_AGENT_SOURCE_DESCRIPTORS: Record<CommandAgentSource, CommandAgentSourceDescriptor> = {
  zcodeAgent: ZCODE_COMMAND_DESCRIPTOR,
};

export const COMMAND_DIRECTORY_SOURCE_DESCRIPTORS: readonly CommandAgentSourceDescriptor[] = [
  ZCODE_COMMAND_DESCRIPTOR,
  {
    ...ZCODE_COMMAND_DESCRIPTOR,
    directorySource: "agents",
    userDirectorySegments: [".agents", "commands"],
    workspaceDirectorySegments: [".agents", "commands"],
  },
];

export function getCommandSourceDescriptor(
  agentSource: CommandAgentSource = DEFAULT_COMMAND_AGENT_SOURCE,
): CommandAgentSourceDescriptor {
  return COMMAND_AGENT_SOURCE_DESCRIPTORS[agentSource];
}

export function getUserCommandsRoot(agentSource?: CommandAgentSource): string {
  const descriptor = getCommandSourceDescriptor(agentSource);
  return join(resolveUserHomeDir(), ...descriptor.userDirectorySegments);
}

export function getUserCommandsRootForDescriptor(descriptor: CommandAgentSourceDescriptor): string {
  return join(resolveUserHomeDir(), ...descriptor.userDirectorySegments);
}

export function getCommandsRootForStorage(params: {
  descriptor: CommandAgentSourceDescriptor;
  storageLevel?: "user" | "project";
  workspacePath?: string;
}): {
  commandsRoot: string;
  scope: UserCommand["scope"];
  projectPath?: string;
} {
  if (params.storageLevel === "project") {
    if (!params.workspacePath) {
      throw new Error("Missing workspace path for project command");
    }
    return {
      commandsRoot: join(params.workspacePath, ...params.descriptor.workspaceDirectorySegments),
      scope: "project",
      projectPath: params.workspacePath,
    };
  }

  return {
    commandsRoot: getUserCommandsRootForDescriptor(params.descriptor),
    scope: "global",
  };
}

function getLocationScope(scope: UserCommand["scope"]): SettingsDirectoryLocation["scope"] {
  return scope === "project" ? "project" : "user";
}

export function buildCommandLocation(params: {
  descriptor: CommandAgentSourceDescriptor;
  commandsRoot: string;
  scope: UserCommand["scope"];
  projectPath?: string;
}): SettingsDirectoryLocation {
  return {
    source: params.descriptor.directorySource,
    scope: getLocationScope(params.scope),
    directoryPath: params.commandsRoot,
    ...(params.projectPath ? { projectPath: params.projectPath } : {}),
  };
}

export function getCommandName(
  rootDir: string,
  filePath: string,
  descriptor: CommandAgentSourceDescriptor,
): string {
  const relativePath = relative(rootDir, filePath);
  const extensionPattern = new RegExp(`${descriptor.fileExtension.replace(".", "\\.")}$`, "i");
  const withoutExtension = relativePath.replace(extensionPattern, "");
  return `/${withoutExtension
    .split(/[\\/]+/)
    .filter(Boolean)
    .join(descriptor.namespaceSeparator)}`;
}

export function getCommandFileName(config: CommandConfig, agentSource: CommandAgentSource): string {
  const descriptor = getCommandSourceDescriptor(agentSource);
  const rawName = config.name.replace(/^\//, "");
  const relativeName = descriptor.namespaceSeparator === ":" ? rawName.replace(/:/g, "/") : rawName;
  return `${relativeName}${descriptor.fileExtension}`;
}

export function getWritableCommandConfig(
  config: CommandConfig,
  descriptor: CommandAgentSourceDescriptor,
): CommandConfig {
  return descriptor.supportsArgumentHint ? config : { ...config, argumentHint: undefined };
}

export function getCommandAgentSources(
  agentSource?: CommandAgentSource,
): readonly CommandAgentSource[] {
  return agentSource ? [agentSource] : COMMAND_AGENT_SOURCE_ORDER;
}

export function buildCommandId(
  agentSource: CommandAgentSource,
  scope: UserCommand["scope"],
  name: string,
  location: SettingsDirectoryLocation,
): string {
  return `${agentSource}:${location.source}:${scope}:${name}`;
}
