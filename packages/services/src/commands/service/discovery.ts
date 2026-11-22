import { access, lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { PluginCommand, UserCommand } from "@zcode/shared";
import { CommandFileParser } from "../commandFileParser.js";
import {
  resolvePluginCommandRootDescriptors,
  type PluginCommandRootDescriptor,
} from "./plugins.js";
import {
  ZCODE_COMMAND_DESCRIPTOR,
  buildCommandId,
  buildCommandLocation,
  getCommandName,
  type CommandAgentSourceDescriptor,
} from "./sources.js";
import { getCommandEnabled } from "./userConfig.js";

export function dedupeCommandsByName(commands: UserCommand[]): UserCommand[] {
  const selected = new Map<string, UserCommand>();
  for (const command of commands) {
    if (!selected.has(command.name)) {
      selected.set(command.name, command);
    }
  }
  return Array.from(selected.values());
}

function buildPluginCommandId(params: {
  filePath: string;
  name: string;
  pluginMarketplace: string;
  pluginName: string;
}): string {
  return `plugin:${params.pluginMarketplace}:${params.pluginName}:${params.name}:${params.filePath}`;
}

export async function discoverPluginCommands(
  enabledOverrides: ReadonlyMap<string, boolean>,
): Promise<PluginCommand[]> {
  const rootDescriptors = await resolvePluginCommandRootDescriptors();
  const commands: PluginCommand[] = [];
  const seenFilePaths = new Set<string>();
  for (const descriptor of rootDescriptors) {
    await discoverPluginCommandsRecursive(descriptor.rootPath, descriptor.rootPath, commands, {
      descriptor,
      enabledOverrides,
      seenFilePaths,
    });
  }
  return commands.sort((left, right) => left.name.localeCompare(right.name));
}

async function discoverPluginCommandsRecursive(
  rootDir: string,
  currentDir: string,
  commands: PluginCommand[],
  options: {
    descriptor: PluginCommandRootDescriptor;
    enabledOverrides: ReadonlyMap<string, boolean>;
    seenFilePaths: Set<string>;
  },
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(currentDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.startsWith(".")) {
      continue;
    }

    const fullPath = join(currentDir, entry);
    let isDir = false;
    try {
      const stat = await lstat(fullPath);
      isDir = stat.isDirectory();
    } catch {
      continue;
    }

    if (isDir) {
      await discoverPluginCommandsRecursive(rootDir, fullPath, commands, options);
      continue;
    }

    if (!entry.toLowerCase().endsWith(ZCODE_COMMAND_DESCRIPTOR.fileExtension)) {
      continue;
    }

    try {
      const content = await readFile(fullPath, "utf-8");
      const parsed = CommandFileParser.parseCommandFile(
        content,
        fullPath,
        ZCODE_COMMAND_DESCRIPTOR.format,
      );
      if (!parsed) {
        continue;
      }
      const name = getCommandName(rootDir, fullPath, ZCODE_COMMAND_DESCRIPTOR);
      const commandKey = fullPath.replaceAll("\\", "/").toLowerCase();
      if (options.seenFilePaths.has(commandKey)) {
        continue;
      }
      options.seenFilePaths.add(commandKey);
      commands.push({
        ...parsed,
        enabled:
          options.descriptor.pluginEnabled && getCommandEnabled(fullPath, options.enabledOverrides),
        filePath: fullPath,
        id: buildPluginCommandId({
          filePath: fullPath,
          name,
          pluginMarketplace: options.descriptor.pluginMarketplace,
          pluginName: options.descriptor.pluginName,
        }),
        name,
        pluginEnabled: options.descriptor.pluginEnabled,
        pluginMarketplace: options.descriptor.pluginMarketplace,
        pluginName: options.descriptor.pluginName,
        scope: "global",
        source: "plugin",
      });
    } catch {
      // 插件命令本身由插件管理；单个文件解析失败不阻断其它命令展示。
    }
  }
}

async function discoverUserCommandsRecursive(
  rootDir: string,
  currentDir: string,
  commands: UserCommand[],
  options: {
    descriptor: CommandAgentSourceDescriptor;
    scope: UserCommand["scope"];
    enabledOverrides: ReadonlyMap<string, boolean>;
    projectPath?: string;
  },
): Promise<void> {
  const descriptor = options.descriptor;
  let entries: string[];
  try {
    entries = await readdir(currentDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(currentDir, entry);

    // 跳过隐藏文件和目录
    if (entry.startsWith(".")) {
      continue;
    }

    let isDir = false;
    try {
      const stat = await lstat(fullPath);
      isDir = stat.isDirectory();
    } catch {
      // 无法访问，跳过
      continue;
    }

    if (isDir) {
      // 递归扫描子目录
      await discoverUserCommandsRecursive(rootDir, fullPath, commands, options);
      continue;
    }

    if (entry.toLowerCase().endsWith(descriptor.fileExtension)) {
      try {
        const content = await readFile(fullPath, "utf-8");
        const parsed = CommandFileParser.parseCommandFile(content, fullPath, descriptor.format);
        if (parsed) {
          const name = getCommandName(rootDir, fullPath, descriptor);
          const location = buildCommandLocation({
            descriptor,
            commandsRoot: rootDir,
            scope: options.scope,
            ...(options.projectPath ? { projectPath: options.projectPath } : {}),
          });
          commands.push({
            ...parsed,
            name,
            agentSource: descriptor.agentSource,
            location,
            id: buildCommandId(descriptor.agentSource, options.scope, name, location),
            source: "user",
            enabled: getCommandEnabled(fullPath, options.enabledOverrides),
            scope: options.scope,
            ...(options.projectPath ? { projectPath: options.projectPath } : {}),
          });
        }
      } catch {
        // 解析失败就跳过
      }
    }
  }
}

async function discoverCommandsRoot(params: {
  descriptor: CommandAgentSourceDescriptor;
  commandsRoot: string;
  scope: UserCommand["scope"];
  commands: UserCommand[];
  enabledOverrides: ReadonlyMap<string, boolean>;
  projectPath?: string;
}): Promise<number> {
  const beforeCount = params.commands.length;
  try {
    await access(params.commandsRoot);
  } catch {
    return 0;
  }

  try {
    await discoverUserCommandsRecursive(params.commandsRoot, params.commandsRoot, params.commands, {
      descriptor: params.descriptor,
      scope: params.scope,
      enabledOverrides: params.enabledOverrides,
      ...(params.projectPath ? { projectPath: params.projectPath } : {}),
    });
  } catch {
    // 扫描出错时返回已发现的命令
  }
  return params.commands.length - beforeCount;
}

export async function discoverCommandsFromDirectorySources(params: {
  descriptors: readonly CommandAgentSourceDescriptor[];
  commandsRootForDescriptor: (descriptor: CommandAgentSourceDescriptor) => string;
  scope: UserCommand["scope"];
  commands: UserCommand[];
  enabledOverrides: ReadonlyMap<string, boolean>;
  projectPath?: string;
}): Promise<void> {
  for (const descriptor of params.descriptors) {
    const discoveredCount = await discoverCommandsRoot({
      descriptor,
      commandsRoot: params.commandsRootForDescriptor(descriptor),
      commands: params.commands,
      enabledOverrides: params.enabledOverrides,
      scope: params.scope,
      ...(params.projectPath ? { projectPath: params.projectPath } : {}),
    });
    // `.zcode` 是强优先级来源；只要读到有效命令，同 scope 的 `.agents` 就不再参与。
    if (descriptor.directorySource === "zcode" && discoveredCount > 0) {
      break;
    }
  }
}
