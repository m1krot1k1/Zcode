import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { McpScope, SettingsDirectoryLocation } from "@zcode/shared";
import { DIRECTORY_MCP_DESCRIPTORS, ZCODE_MCP_DESCRIPTOR } from "./descriptors.js";
import type { DirectoryMcpDescriptor } from "./types.js";

export function resolveUserHomeDir(): string {
  return process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
}

export function buildDirectoryConfigPath(
  descriptor: DirectoryMcpDescriptor,
  scope: Exclude<McpScope, "common">,
  workspacePath?: string,
): string {
  const baseDir = scope === "user" ? resolveUserHomeDir() : workspacePath;
  if (!baseDir) {
    throw new Error(
      `Missing workspace path for ${descriptor.directorySource} workspace MCP config`,
    );
  }
  const segments =
    scope === "user" ? descriptor.userConfigDirSegments : descriptor.workspaceConfigDirSegments;
  return join(baseDir, ...segments, descriptor.fileName);
}

export function buildUserConfigPath(descriptor: DirectoryMcpDescriptor): string {
  return buildDirectoryConfigPath(descriptor, "user");
}

export function getUserZcodeMcpConfigPath(): string {
  return buildUserConfigPath(ZCODE_MCP_DESCRIPTOR);
}

export function buildDirectoryMcpLocation(
  descriptor: DirectoryMcpDescriptor,
  scope: Exclude<McpScope, "common">,
  workspacePath?: string,
): SettingsDirectoryLocation {
  const filePath = buildDirectoryConfigPath(descriptor, scope, workspacePath);
  return {
    source: descriptor.directorySource,
    scope: scope === "workspace" ? "project" : "user",
    directoryPath: dirname(filePath),
    ...(workspacePath ? { projectPath: workspacePath } : {}),
  };
}

export function findDescriptorByLocation(
  location: SettingsDirectoryLocation,
): DirectoryMcpDescriptor {
  const descriptor = DIRECTORY_MCP_DESCRIPTORS.find(
    (item) => item.directorySource === location.source,
  );
  if (!descriptor) {
    throw new Error(`Unsupported MCP settings directory source: ${location.source}`);
  }
  return descriptor;
}
