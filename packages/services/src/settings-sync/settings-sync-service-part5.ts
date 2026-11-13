import type {
  SettingsSyncAgent,
  SettingsSyncClaudeAgentsFileCopyResult,
  SettingsSyncClaudeAgentsFileMigrationStatus,
  SettingsSyncDiscoveryResult,
  SettingsSyncImportResult,
  SettingsSyncMcpServerImportResult,
  SettingsSyncSelection,
  SettingsSyncSourceScope,
  SettingsSyncTaskImportResult,
} from "@zcode/shared";
import type { ISettingsSyncService } from "./settingsSync.js";
import { SUPPORTED_SKILL_AGENT_SOURCES, log, shouldScanCommands, shouldScanMcpServers, shouldScanPlugins, shouldScanSkills } from "./settings-sync-service-part1.js";
import type { McpImportCandidate, SettingsSyncServiceDependencies } from "./settings-sync-service-part1.js";
import { getClaudeAgentsFileMigrationStatus, resolveMcpConfigPathForScope } from "./settings-sync-service-part2.js";
import { addMcpServerToZcodeConfig, buildCommandsDiscovery, collectSkillImportCandidates, copyClaudeAgentsFileToZcodeAgentsFile, getMcpImportCandidateSkipReason, importCommandsForAgent, prepareClineMcpConfigForTargetScope } from "./settings-sync-service-part3.js";
import { SUPPORTED_MCP_AGENT_SOURCES, buildMcpSourceRootSummaries, buildPluginsDiscovery, buildSourceRootSummaries, importPluginsForAgent, importSkillsForAgent, isMcpImportCandidateImportable, isSkillImportCandidateImportable, scanMcpImportSources } from "./settings-sync-service-part4.js";

// Часть 5/5 модуля settings-sync-service: вынесено по лимиту строк.

export async function buildSkillsDiscovery(workspacePath?: string): Promise<SettingsSyncDiscoveryResult> {
  const candidates = await collectSkillImportCandidates(workspacePath);
  const agents: SettingsSyncDiscoveryResult["agents"] = [];
  for (const { agent } of SUPPORTED_SKILL_AGENT_SOURCES) {
    const agentCandidates = candidates.filter((candidate) => candidate.agent === agent);
    const discoveredCount = agentCandidates.length;
    const sourcePaths = [
      ...new Set(agentCandidates.map((candidate) => candidate.sourceRootPath)),
    ].sort((left, right) => left.localeCompare(right));
    const sourceRoots = await buildSourceRootSummaries(agentCandidates);
    let importableCount = 0;
    const existingNameKeysByTargetRoot = new Map<string, Set<string>>();
    for (const candidate of agentCandidates) {
      if (await isSkillImportCandidateImportable(candidate, existingNameKeysByTargetRoot)) {
        importableCount += 1;
      }
    }
    agents.push({
      agent,
      discovered: discoveredCount > 0,
      categories: [
        {
          category: "skills",
          discoveredCount,
          importableCount,
          skippedCount: discoveredCount - importableCount,
          sourcePaths,
          sourceRoots,
          selectedByDefault: importableCount > 0,
        },
      ],
    });
  }
  return {
    agents: agents.filter((agent) => agent.discovered),
  };
}

export async function collectMcpImportCandidates(workspacePath?: string): Promise<McpImportCandidate[]> {
  return (await scanMcpImportSources(workspacePath)).candidates;
}

export async function buildMcpDiscovery(workspacePath?: string): Promise<SettingsSyncDiscoveryResult> {
  const scan = await scanMcpImportSources(workspacePath);
  const candidates = scan.candidates;
  const sourceRootsByPath = new Map(scan.roots.map((root) => [root.rootPath, root]));
  const agents: SettingsSyncDiscoveryResult["agents"] = [];
  for (const { agent } of SUPPORTED_MCP_AGENT_SOURCES) {
    const agentCandidates = candidates.filter((candidate) => candidate.agent === agent);
    const discoveredCount = agentCandidates.length;
    const sourcePaths = [
      ...new Set(
        [
          ...agentCandidates.map((candidate) => candidate.sourceRootPath),
          ...scan.diagnostics.map((diagnostic) => diagnostic.path),
        ].filter((path) => {
          const source = sourceRootsByPath.get(path);
          return source?.agent === agent;
        }),
      ),
    ].sort((left, right) => left.localeCompare(right));
    const sourceRoots = await buildMcpSourceRootSummaries(agentCandidates, workspacePath);
    let importableCount = 0;
    const existingNameKeysByTargetScope = new Map<SettingsSyncSourceScope, Set<string>>();
    for (const candidate of agentCandidates) {
      if (
        await isMcpImportCandidateImportable(
          candidate,
          existingNameKeysByTargetScope,
          workspacePath,
        )
      ) {
        importableCount += 1;
      }
    }
    const sourceDiagnostics = scan.diagnostics.filter(
      (diagnostic) => sourceRootsByPath.get(diagnostic.path)?.agent === agent,
    );
    agents.push({
      agent,
      discovered: discoveredCount > 0 || sourcePaths.length > 0,
      categories: [
        {
          category: "mcpServers",
          discoveredCount,
          importableCount,
          skippedCount: discoveredCount - importableCount,
          sourcePaths,
          sourceRoots,
          ...(sourceDiagnostics.length > 0 ? { diagnostics: sourceDiagnostics } : {}),
          selectedByDefault: false,
        },
      ],
    });
  }
  return {
    agents: agents.filter((agent) => agent.discovered),
  };
}

export async function importMcpServersForAgent(
  workspacePath: string | undefined,
  agent: SettingsSyncAgent,
  sourceScope?: SettingsSyncSourceScope,
  targetScope?: SettingsSyncSourceScope,
  mcpServerPaths?: string[],
): Promise<SettingsSyncTaskImportResult> {
  const selectedMcpServerPaths = mcpServerPaths ? new Set(mcpServerPaths) : null;
  const candidates = (await collectMcpImportCandidates(workspacePath)).filter(
    (candidate) =>
      candidate.agent === agent &&
      (!sourceScope || candidate.sourceRootScope === sourceScope) &&
      (!selectedMcpServerPaths || selectedMcpServerPaths.has(candidate.sourcePath)),
  );
  let importedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const mcpServerResults: SettingsSyncMcpServerImportResult[] = [];
  const existingNameKeysByTargetScope = new Map<SettingsSyncSourceScope, Set<string>>();

  for (const candidate of candidates) {
    const selectedTargetScope = targetScope ?? candidate.sourceRootScope;
    const selectedConfigPath = resolveMcpConfigPathForScope(selectedTargetScope, workspacePath);
    if (!selectedConfigPath) {
      skippedCount += 1;
      mcpServerResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "skipped",
        skipReason: "sameNameExists",
      });
      continue;
    }
    const skipReason = await getMcpImportCandidateSkipReason(
      candidate,
      existingNameKeysByTargetScope,
      workspacePath,
      selectedTargetScope,
    );
    if (skipReason) {
      skippedCount += 1;
      mcpServerResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "skipped",
        skipReason,
      });
      continue;
    }
    try {
      const prepared = await prepareClineMcpConfigForTargetScope(candidate, selectedTargetScope);
      await addMcpServerToZcodeConfig(selectedConfigPath, candidate.name, prepared.config);
      importedCount += 1;
      const existingNameKeys = existingNameKeysByTargetScope.get(selectedTargetScope);
      if (existingNameKeys) {
        existingNameKeys.add(candidate.nameKey);
      }
      mcpServerResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "imported",
        ...(prepared.warnings ? { warnings: prepared.warnings } : {}),
      });
    } catch {
      failedCount += 1;
      mcpServerResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "failed",
      });
    }
  }

  return {
    agent,
    category: "mcpServers",
    status: failedCount > 0 ? "failed" : importedCount > 0 ? "success" : "skipped",
    importedCount,
    skippedCount,
    failedCount,
    mcpServerResults,
  };
}

export function createSettingsSyncService(
  dependencies: SettingsSyncServiceDependencies,
): ISettingsSyncService {
  function buildEmptyDiscoveryResult(): SettingsSyncDiscoveryResult {
    return {
      agents: [],
    };
  }

  return {
    async getClaudeAgentsFileMigrationStatus(
      request,
    ): Promise<SettingsSyncClaudeAgentsFileMigrationStatus> {
      void request.workspaceIdentity;
      void request.workspacePath;
      return getClaudeAgentsFileMigrationStatus();
    },

    async copyClaudeAgentsFileToZcodeAgentsFile(
      request = {},
    ): Promise<SettingsSyncClaudeAgentsFileCopyResult> {
      const result = await copyClaudeAgentsFileToZcodeAgentsFile({
        overwrite: request.overwrite,
      });
      log.info("[settings-sync] Claude AGENTS.md migration completed", {
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        sourcePath: result.sourcePath,
        targetPath: result.targetPath,
        status: result.status,
        overwritten: result.overwritten,
        skippedReason: result.skippedReason,
      });
      return result;
    },

    async detect(request): Promise<SettingsSyncDiscoveryResult> {
      if (shouldScanSkills(request)) {
        return buildSkillsDiscovery(request.workspacePath);
      }
      if (shouldScanCommands(request)) {
        return buildCommandsDiscovery(request.workspacePath);
      }
      if (shouldScanPlugins(request)) {
        return buildPluginsDiscovery(request.workspacePath);
      }
      if (shouldScanMcpServers(request)) {
        return buildMcpDiscovery(request.workspacePath);
      }
      return buildEmptyDiscoveryResult();
    },

    async importSelected(request: {
      workspacePath?: string;
      workspaceIdentity?: string;
      selections: SettingsSyncSelection[];
    }): Promise<SettingsSyncImportResult> {
      const taskResults: SettingsSyncTaskImportResult[] = [];
      for (const selection of request.selections) {
        if (selection.category === "skills") {
          taskResults.push(
            await importSkillsForAgent(
              request.workspacePath,
              selection.agent,
              selection.sourceScope,
              selection.targetScope,
              selection.importMode,
              selection.skillPaths,
            ),
          );
          continue;
        }
        if (selection.category === "commands") {
          taskResults.push(
            await importCommandsForAgent(
              request.workspacePath,
              selection.agent,
              selection.sourceScope,
              selection.targetScope,
              selection.importMode,
              selection.commandPaths,
            ),
          );
          continue;
        }
        if (selection.category === "plugins") {
          taskResults.push(
            await importPluginsForAgent(
              request.workspacePath,
              selection.agent,
              selection.sourceScope,
              selection.targetScope,
              selection.importMode,
              selection.pluginPaths,
            ),
          );
          continue;
        }
        if (selection.category === "mcpServers") {
          taskResults.push(
            await importMcpServersForAgent(
              request.workspacePath,
              selection.agent,
              selection.sourceScope,
              selection.targetScope,
              selection.mcpServerPaths,
            ),
          );
          continue;
        }
        taskResults.push({
          agent: selection.agent,
          category: selection.category,
          status: "skipped",
          importedCount: 0,
          skippedCount: 1,
          failedCount: 0,
        });
      }
      return {
        successCount: taskResults.reduce((sum, result) => sum + result.importedCount, 0),
        skippedCount: taskResults.reduce((sum, result) => sum + result.skippedCount, 0),
        failedCount: taskResults.reduce((sum, result) => sum + result.failedCount, 0),
        taskResults,
      };
    },

    async getFirstRunPromptState() {
      const settings = await dependencies.settingService.get();
      return {
        handled: settings.settingsSyncFirstRunPromptHandled === true,
      };
    },

    async markFirstRunPromptHandled(): Promise<void> {
      await dependencies.settingService.update({
        // 这里记录的是“首启导入提示是否已经被消费”，不是“导入是否成功”。
        // 如果把“用户点击跳过”遗漏掉，下次启动还会重复弹窗，造成首启流程打扰感。
        settingsSyncFirstRunPromptHandled: true,
      });
    },
  };
}
