import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ZCODE_COMMAND_AGENT_SOURCE,
  type CommandAgentSource,
  type CommandCreateParams,
  type CommandDeleteParams,
  type CommandSetEnabledParams,
  type CommandsListResult,
  type CommandUpdateParams,
  type UserCommand,
  type ZCodeCommand,
} from "@zcode/shared";
import type { ICommandsService } from "../commands.js";
import { CommandFileParser } from "../commandFileParser.js";
import {
  dedupeCommandsByName,
  discoverCommandsFromDirectorySources,
  discoverPluginCommands,
} from "./discovery.js";
import {
  COMMAND_DIRECTORY_SOURCE_DESCRIPTORS,
  DEFAULT_COMMAND_AGENT_SOURCE,
  buildCommandId,
  buildCommandLocation,
  getCommandAgentSources,
  getCommandFileName,
  getCommandName,
  getCommandSourceDescriptor,
  getCommandsRootForStorage,
  getUserCommandsRoot,
  getUserCommandsRootForDescriptor,
  getWritableCommandConfig,
} from "./sources.js";
import {
  getCommandEnabled,
  readCommandEnabledOverridesFromUserConfig,
  readUserCliConfig,
  setCommandEnabledOverride,
  writeUserCliConfig,
} from "./userConfig.js";

interface CommandsServiceOptions {
  isDesktopRuntime?: boolean;
}

export function createCommandsService(_options?: CommandsServiceOptions): ICommandsService {
  async function list(params: {
    agentSource?: CommandAgentSource;
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<CommandsListResult> {
    const userCommands: UserCommand[] = [];
    const agentSources = getCommandAgentSources(params.agentSource);
    const enabledOverrides = await readCommandEnabledOverridesFromUserConfig();

    // ZCode Agent 需要先合并所有 workspace 目录，再合并所有 user 目录；
    // 按每个目录交错读取 project/user 会让 user .zcode 抢在 workspace .agents 前面。
    for (const agentSource of agentSources) {
      const descriptors =
        agentSource === ZCODE_COMMAND_AGENT_SOURCE
          ? COMMAND_DIRECTORY_SOURCE_DESCRIPTORS
          : [getCommandSourceDescriptor(agentSource)];

      if (params.workspacePath) {
        const workspacePath = params.workspacePath;
        await discoverCommandsFromDirectorySources({
          descriptors,
          commandsRootForDescriptor: (descriptor) =>
            join(workspacePath, ...descriptor.workspaceDirectorySegments),
          commands: userCommands,
          enabledOverrides,
          projectPath: workspacePath,
          scope: "project",
        });
      }

      await discoverCommandsFromDirectorySources({
        descriptors,
        commandsRootForDescriptor: getUserCommandsRootForDescriptor,
        commands: userCommands,
        enabledOverrides,
        scope: "global",
      });
    }

    const dedupedUserCommands = dedupeCommandsByName(userCommands);
    const pluginCommands =
      !params.agentSource || params.agentSource === ZCODE_COMMAND_AGENT_SOURCE
        ? await discoverPluginCommands(enabledOverrides)
        : [];

    return {
      commands: [...dedupedUserCommands, ...pluginCommands] as ZCodeCommand[],
      userCommands: dedupedUserCommands,
      pluginCommands,
      capability: { userScopeAvailable: true },
    };
  }

  async function writeCommandFile(params: CommandCreateParams): Promise<{ command: UserCommand }> {
    const agentSource = params.agentSource ?? DEFAULT_COMMAND_AGENT_SOURCE;
    const descriptor = getCommandSourceDescriptor(agentSource);
    const target = getCommandsRootForStorage({
      descriptor,
      storageLevel: params.storageLevel,
      workspacePath: params.workspacePath,
    });
    const { commandsRoot } = target;
    await mkdir(commandsRoot, { recursive: true });

    const fileName = getCommandFileName(params.config, agentSource);
    const filePath = join(commandsRoot, fileName);

    // 检查文件是否已存在
    try {
      await access(filePath);
      throw new Error(`Command file already exists: ${fileName}`);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        throw error;
      }
    }

    const content = CommandFileParser.generateCommandFileContent(
      getWritableCommandConfig(params.config, descriptor),
      descriptor.format,
    );
    await writeFile(filePath, content, "utf-8");
    await writeUserCliConfig(setCommandEnabledOverride(await readUserCliConfig(), filePath, true));

    const parsed = CommandFileParser.parseCommandFile(content, filePath, descriptor.format);
    if (!parsed) {
      throw new Error("Failed to parse written command file");
    }
    const name = getCommandName(commandsRoot, filePath, descriptor);

    const location = buildCommandLocation({
      descriptor,
      commandsRoot,
      scope: target.scope,
      ...(target.projectPath ? { projectPath: target.projectPath } : {}),
    });
    const command: UserCommand = {
      ...parsed,
      name,
      agentSource,
      location,
      id: buildCommandId(agentSource, target.scope, name, location),
      source: "user",
      enabled: true,
      scope: target.scope,
      ...(target.projectPath ? { projectPath: target.projectPath } : {}),
    };

    return { command };
  }

  async function updateCommandFile(params: CommandUpdateParams): Promise<{ command: UserCommand }> {
    const agentSource = params.agentSource ?? DEFAULT_COMMAND_AGENT_SOURCE;
    const descriptor = getCommandSourceDescriptor(agentSource);
    const target = getCommandsRootForStorage({
      descriptor,
      storageLevel: params.storageLevel,
      workspacePath: params.workspacePath,
    });
    const { commandsRoot } = target;
    const newFileName = getCommandFileName(params.config, agentSource);
    const newFilePath = join(commandsRoot, newFileName);
    const enabledOverrides = await readCommandEnabledOverridesFromUserConfig();
    const existingContent = params.oldFilePath
      ? await readFile(params.oldFilePath, "utf-8").catch(() => undefined)
      : undefined;

    // 如果文件名变了，需要删除旧文件
    if (params.oldFilePath && params.oldFilePath !== newFilePath) {
      try {
        await rm(params.oldFilePath);
      } catch {
        // 旧文件可能已被移除，忽略删除失败（ENOENT 属正常情况）。
      }
    }

    // 检查新文件是否已存在（排除自己的旧路径）
    if (newFilePath !== params.oldFilePath) {
      try {
        await access(newFilePath);
        throw new Error(`Command file already exists: ${newFileName}`);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") {
          throw error;
        }
      }
    }

    const content = CommandFileParser.generateCommandFileContent(
      getWritableCommandConfig(params.config, descriptor),
      descriptor.format,
      existingContent,
    );
    await mkdir(dirname(newFilePath), { recursive: true });
    await writeFile(newFilePath, content, "utf-8");

    if (
      params.oldFilePath &&
      params.oldFilePath !== newFilePath &&
      enabledOverrides.has(params.oldFilePath)
    ) {
      // 禁用状态按命令文件路径存放；编辑命令改名会换文件路径，必须迁移 override，
      // 否则用户刚禁用的命令会因为改名重新启用。
      const migratedConfig = setCommandEnabledOverride(
        setCommandEnabledOverride(await readUserCliConfig(), params.oldFilePath, true),
        newFilePath,
        enabledOverrides.get(params.oldFilePath) ?? true,
      );
      await writeUserCliConfig(migratedConfig);
    }

    const parsed = CommandFileParser.parseCommandFile(content, newFilePath, descriptor.format);
    if (!parsed) {
      throw new Error("Failed to parse written command file");
    }
    const name = getCommandName(commandsRoot, newFilePath, descriptor);

    const location = buildCommandLocation({
      descriptor,
      commandsRoot,
      scope: target.scope,
      ...(target.projectPath ? { projectPath: target.projectPath } : {}),
    });
    const command: UserCommand = {
      ...parsed,
      name,
      agentSource,
      location,
      id: buildCommandId(agentSource, target.scope, name, location),
      source: "user",
      enabled: getCommandEnabled(newFilePath, await readCommandEnabledOverridesFromUserConfig()),
      scope: target.scope,
      ...(target.projectPath ? { projectPath: target.projectPath } : {}),
    };

    return { command };
  }

  async function deleteCommandFile(params: CommandDeleteParams): Promise<void> {
    try {
      await rm(params.filePath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        // 文件不存在，当作成功
      } else {
        throw error;
      }
    }
    await writeUserCliConfig(
      setCommandEnabledOverride(await readUserCliConfig(), params.filePath, true),
    );
  }

  async function setCommandEnabled(params: CommandSetEnabledParams): Promise<void> {
    const nextConfig = setCommandEnabledOverride(
      await readUserCliConfig(),
      params.filePath,
      params.enabled,
    );
    await writeUserCliConfig(nextConfig);
  }

  async function getPrimaryUserCommandsDirectory(params?: {
    agentSource?: CommandAgentSource;
  }): Promise<{ path: string }> {
    const path = getUserCommandsRoot(params?.agentSource);
    // open-in-file-manager 在 Windows 上不能可靠打开不存在的路径，
    // 这里先确保命令目录落盘，再把路径交给系统文件管理器。
    await mkdir(path, { recursive: true });
    return { path };
  }

  return {
    list,
    writeCommandFile,
    updateCommandFile,
    deleteCommandFile,
    setCommandEnabled,
    getPrimaryUserCommandsDirectory,
  };
}
