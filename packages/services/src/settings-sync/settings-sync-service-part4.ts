import type {
  SettingsSyncAgent,
  SettingsSyncDiscoveryResult,
  SettingsSyncPluginImportResult,
  SettingsSyncImportMode,
  SettingsSyncSkillImportResult,
  SettingsSyncSkillSkipReason,
  SettingsSyncSourceScope,
  SettingsSyncSourceRootSummary,
  SettingsSyncSourceDiagnostic,
  SettingsSyncTaskImportResult,
} from "@zcode/shared";
import {
  mkdir,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { SUPPORTED_PLUGIN_AGENT_SOURCES, exists, normalizeMcpServerNameKey, pathExists, resolveUserHomeDir, stripExternalMcpTimeoutFields } from "./settings-sync-service-part1.js";
import type { ExternalAgentMcpPathSource, McpImportCandidate, McpSourceRoot, PluginImportCandidate, SkillImportCandidate } from "./settings-sync-service-part1.js";
import { addPluginDirToConfig, importPluginDirectory, importSkillDirectory, resolvePluginConfigPathForScope, resolvePluginTargetRootForScope, resolveTargetRootForScope } from "./settings-sync-service-part2.js";
import { collectExistingSkillNameKeys, collectPluginImportCandidates, collectSkillImportCandidates, getClineMcpSettingsPath, getMcpImportCandidateSkipReason, getPluginImportCandidateSkipReason, readMcpServersFromSourceFile } from "./settings-sync-service-part3.js";

// Часть 4/5 модуля settings-sync-service: вынесено по лимиту строк.

export async function isPluginImportCandidateImportable(
  candidate: PluginImportCandidate,
  existingPluginIdsByConfigPath: Map<string, Set<string>>,
  workspacePath: string | undefined,
  targetScope: SettingsSyncSourceScope = candidate.sourceRootScope,
): Promise<boolean> {
  return (
    (await getPluginImportCandidateSkipReason(
      candidate,
      existingPluginIdsByConfigPath,
      workspacePath,
      targetScope,
    )) === undefined
  );
}

export async function isMcpImportCandidateImportable(
  candidate: McpImportCandidate,
  existingNameKeysByTargetScope: Map<SettingsSyncSourceScope, Set<string>>,
  workspacePath: string | undefined,
  targetScope: SettingsSyncSourceScope = candidate.sourceRootScope,
): Promise<boolean> {
  return (
    (await getMcpImportCandidateSkipReason(
      candidate,
      existingNameKeysByTargetScope,
      workspacePath,
      targetScope,
    )) === undefined
  );
}

export async function buildPluginSourceRootSummaries(
  candidates: PluginImportCandidate[],
  workspacePath: string | undefined,
): Promise<SettingsSyncSourceRootSummary[]> {
  const existingPluginIdsByConfigPath = new Map<string, Set<string>>();
  const grouped = new Map<string, PluginImportCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.sourceRootScope}:${candidate.sourceRootPath}`;
    grouped.set(key, [...(grouped.get(key) ?? []), candidate]);
  }

  const summaries: SettingsSyncSourceRootSummary[] = [];
  for (const groupCandidates of grouped.values()) {
    const firstCandidate = groupCandidates[0];
    if (!firstCandidate) {
      continue;
    }
    let importableCount = 0;
    const plugins = [];
    for (const candidate of groupCandidates) {
      const skipReason = await getPluginImportCandidateSkipReason(
        candidate,
        existingPluginIdsByConfigPath,
        workspacePath,
      );
      const importable = skipReason === undefined;
      if (importable) {
        importableCount += 1;
      }
      plugins.push({
        name: candidate.name,
        path: candidate.sourcePath,
        importable,
        ...(skipReason ? { skipReason } : {}),
        ...(candidate.version ? { version: candidate.version } : {}),
      });
    }
    summaries.push({
      scope: firstCandidate.sourceRootScope,
      path: firstCandidate.sourceRootPath,
      discoveredCount: groupCandidates.length,
      importableCount,
      skippedCount: groupCandidates.length - importableCount,
      plugins: plugins.sort((left, right) => left.name.localeCompare(right.name)),
    });
  }

  return summaries.sort((left, right) => {
    const byScope = left.scope.localeCompare(right.scope);
    return byScope !== 0 ? byScope : left.path.localeCompare(right.path);
  });
}

export async function buildMcpSourceRootSummaries(
  candidates: McpImportCandidate[],
  workspacePath: string | undefined,
): Promise<SettingsSyncSourceRootSummary[]> {
  const existingNameKeysByTargetScope = new Map<SettingsSyncSourceScope, Set<string>>();
  const grouped = new Map<string, McpImportCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.sourceRootScope}:${candidate.sourceRootPath}`;
    grouped.set(key, [...(grouped.get(key) ?? []), candidate]);
  }

  const summaries: SettingsSyncSourceRootSummary[] = [];
  for (const groupCandidates of grouped.values()) {
    const firstCandidate = groupCandidates[0];
    if (!firstCandidate) {
      continue;
    }
    let importableCount = 0;
    const mcpServers = [];
    for (const candidate of groupCandidates) {
      const skipReason = await getMcpImportCandidateSkipReason(
        candidate,
        existingNameKeysByTargetScope,
        workspacePath,
      );
      const importable = skipReason === undefined;
      if (importable) {
        importableCount += 1;
      }
      mcpServers.push({
        name: candidate.name,
        path: candidate.sourcePath,
        importable,
        ...(skipReason ? { skipReason } : {}),
      });
    }
    summaries.push({
      scope: firstCandidate.sourceRootScope,
      path: firstCandidate.sourceRootPath,
      discoveredCount: groupCandidates.length,
      importableCount,
      skippedCount: groupCandidates.length - importableCount,
      mcpServers: mcpServers.sort((left, right) => left.name.localeCompare(right.name)),
    });
  }

  return summaries.sort((left, right) => {
    const byScope = left.scope.localeCompare(right.scope);
    return byScope !== 0 ? byScope : left.path.localeCompare(right.path);
  });
}

export async function importPluginsForAgent(
  workspacePath: string | undefined,
  agent: SettingsSyncAgent,
  sourceScope?: SettingsSyncSourceScope,
  targetScope?: SettingsSyncSourceScope,
  importMode: SettingsSyncImportMode = "symlink",
  pluginPaths?: string[],
): Promise<SettingsSyncTaskImportResult> {
  const selectedPluginPaths = pluginPaths ? new Set(pluginPaths) : null;
  const candidates = (await collectPluginImportCandidates(workspacePath)).filter(
    (candidate) =>
      candidate.agent === agent &&
      (!sourceScope || candidate.sourceRootScope === sourceScope) &&
      (!selectedPluginPaths || selectedPluginPaths.has(candidate.sourcePath)),
  );
  let importedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const pluginResults: SettingsSyncPluginImportResult[] = [];
  const existingPluginIdsByConfigPath = new Map<string, Set<string>>();

  for (const candidate of candidates) {
    const selectedTargetScope = targetScope ?? candidate.sourceRootScope;
    const selectedTargetRoot = resolvePluginTargetRootForScope(selectedTargetScope, workspacePath);
    const selectedConfigPath = resolvePluginConfigPathForScope(selectedTargetScope, workspacePath);
    if (!selectedTargetRoot || !selectedConfigPath) {
      skippedCount += 1;
      pluginResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "skipped",
        skipReason: "targetExists",
        ...(candidate.version ? { version: candidate.version } : {}),
      });
      continue;
    }
    const targetCandidate = {
      ...candidate,
      targetRoot: selectedTargetRoot,
      targetPath: join(selectedTargetRoot, basename(candidate.sourcePath)),
    };
    const skipReason = await getPluginImportCandidateSkipReason(
      targetCandidate,
      existingPluginIdsByConfigPath,
      workspacePath,
      selectedTargetScope,
    );
    if (skipReason) {
      skippedCount += 1;
      pluginResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "skipped",
        skipReason,
        ...(candidate.version ? { version: candidate.version } : {}),
      });
      continue;
    }
    try {
      await mkdir(dirname(targetCandidate.targetPath), { recursive: true });
      await importPluginDirectory(candidate.sourcePath, targetCandidate.targetPath, importMode);
      await addPluginDirToConfig(selectedConfigPath, targetCandidate.targetPath);
      importedCount += 1;
      const existingPluginIds = existingPluginIdsByConfigPath.get(selectedConfigPath);
      if (existingPluginIds) {
        existingPluginIds.add(candidate.id.toLowerCase());
      }
      pluginResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "imported",
        ...(candidate.version ? { version: candidate.version } : {}),
      });
    } catch {
      failedCount += 1;
      pluginResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "failed",
        ...(candidate.version ? { version: candidate.version } : {}),
      });
    }
  }

  return {
    agent,
    category: "plugins",
    status: failedCount > 0 ? "failed" : importedCount > 0 ? "success" : "skipped",
    importedCount,
    skippedCount,
    failedCount,
    pluginResults,
  };
}

export const SUPPORTED_MCP_AGENT_SOURCES: ExternalAgentMcpPathSource[] = [
  {
    agent: "cline",
    projectFiles: [],
    globalFiles: [],
    resolveGlobalFile: getClineMcpSettingsPath,
    format: "clineMcpJson",
  },
  {
    agent: "claudeCode",
    projectFiles: [[".claude", "settings.json"], [".mcp.json"]],
    globalFiles: [[".claude", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "codexCli",
    projectFiles: [[".codex", "config.toml"]],
    globalFiles: [[".codex", "config.toml"]],
    format: "codexToml",
  },
  {
    agent: "openCode",
    projectFiles: [[".opencode", "opencode.json"]],
    globalFiles: [[".config", "opencode", "opencode.json"]],
    format: "mcpJson",
  },
  {
    agent: "openClaw",
    projectFiles: [["settings.json"]],
    globalFiles: [[".openclaw", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "qwenCode",
    projectFiles: [[".qwen", "settings.json"]],
    globalFiles: [[".qwen", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "qode",
    projectFiles: [[".qoder", "settings.json"]],
    globalFiles: [[".qoder", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "qodeCn",
    projectFiles: [[".qoder", "settings.json"]],
    globalFiles: [[".qoder-cn", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "trae",
    projectFiles: [[".trae", "settings.json"]],
    globalFiles: [[".trae", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "kiroCli",
    projectFiles: [[".kiro", "settings.json"]],
    globalFiles: [[".kiro", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "roo",
    projectFiles: [[".roo", "settings.json"]],
    globalFiles: [[".roo", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "codeBuddy",
    projectFiles: [[".codebuddy", "settings.json"]],
    globalFiles: [[".codebuddy", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "agents",
    projectFiles: [[".agents", "mcp.json"]],
    globalFiles: [[".agents", "mcp.json"]],
    format: "mcpServersJson",
  },
];

export async function getSkillImportCandidateSkipReason(
  candidate: SkillImportCandidate,
  existingNameKeysByTargetRoot: Map<string, Set<string>>,
): Promise<SettingsSyncSkillSkipReason | undefined> {
  if (await exists(candidate.targetPath)) {
    return "targetExists";
  }
  let existingNameKeys = existingNameKeysByTargetRoot.get(candidate.targetRoot);
  if (!existingNameKeys) {
    existingNameKeys = await collectExistingSkillNameKeys(candidate.targetRoot);
    existingNameKeysByTargetRoot.set(candidate.targetRoot, existingNameKeys);
  }
  return existingNameKeys.has(candidate.nameKey) ? "sameNameExists" : undefined;
}

export async function buildPluginsDiscovery(workspacePath?: string): Promise<SettingsSyncDiscoveryResult> {
  const candidates = await collectPluginImportCandidates(workspacePath);
  const agents: SettingsSyncDiscoveryResult["agents"] = [];
  for (const { agent } of SUPPORTED_PLUGIN_AGENT_SOURCES) {
    const agentCandidates = candidates.filter((candidate) => candidate.agent === agent);
    const discoveredCount = agentCandidates.length;
    const sourcePaths = [
      ...new Set(agentCandidates.map((candidate) => candidate.sourceRootPath)),
    ].sort((left, right) => left.localeCompare(right));
    const sourceRoots = await buildPluginSourceRootSummaries(agentCandidates, workspacePath);
    let importableCount = 0;
    const existingPluginIdsByConfigPath = new Map<string, Set<string>>();
    for (const candidate of agentCandidates) {
      if (
        await isPluginImportCandidateImportable(
          candidate,
          existingPluginIdsByConfigPath,
          workspacePath,
        )
      ) {
        importableCount += 1;
      }
    }
    agents.push({
      agent,
      discovered: discoveredCount > 0,
      categories: [
        {
          category: "plugins",
          discoveredCount,
          importableCount,
          skippedCount: discoveredCount - importableCount,
          sourcePaths,
          sourceRoots,
          selectedByDefault: false,
        },
      ],
    });
  }
  return {
    agents: agents.filter((agent) => agent.discovered),
  };
}

export async function getExternalMcpRoots(workspacePath?: string): Promise<McpSourceRoot[]> {
  const home = resolveUserHomeDir();
  const userRoots: McpSourceRoot[] = [];
  for (const source of SUPPORTED_MCP_AGENT_SOURCES) {
    const resolvedGlobalFile = source.resolveGlobalFile
      ? await source.resolveGlobalFile()
      : undefined;
    for (const rootPath of [
      ...source.globalFiles.map((globalFile) => join(home, ...globalFile)),
      ...(resolvedGlobalFile ? [resolvedGlobalFile] : []),
    ]) {
      userRoots.push({
        agent: source.agent,
        rootPath,
        scope: "user",
        format: source.format,
      });
    }
  }
  if (!workspacePath) {
    return userRoots;
  }
  return [
    ...userRoots,
    ...SUPPORTED_MCP_AGENT_SOURCES.flatMap((source) =>
      source.projectFiles.map((projectFile) => ({
        agent: source.agent,
        rootPath: join(workspacePath, ...projectFile),
        scope: "workspace" as const,
        format: source.format,
      })),
    ),
  ];
}

export async function isSkillImportCandidateImportable(
  candidate: SkillImportCandidate,
  existingNameKeysByTargetRoot: Map<string, Set<string>>,
): Promise<boolean> {
  return (
    (await getSkillImportCandidateSkipReason(candidate, existingNameKeysByTargetRoot)) === undefined
  );
}

export async function buildSourceRootSummaries(
  candidates: SkillImportCandidate[],
): Promise<SettingsSyncSourceRootSummary[]> {
  const existingNameKeysByTargetRoot = new Map<string, Set<string>>();
  const grouped = new Map<string, SkillImportCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.sourceRootScope}:${candidate.sourceRootPath}`;
    grouped.set(key, [...(grouped.get(key) ?? []), candidate]);
  }

  const summaries: SettingsSyncSourceRootSummary[] = [];
  for (const groupCandidates of grouped.values()) {
    const firstCandidate = groupCandidates[0];
    if (!firstCandidate) {
      continue;
    }
    let importableCount = 0;
    const skills = [];
    for (const candidate of groupCandidates) {
      const skipReason = await getSkillImportCandidateSkipReason(
        candidate,
        existingNameKeysByTargetRoot,
      );
      const importable = skipReason === undefined;
      if (importable) {
        importableCount += 1;
      }
      skills.push({
        name: candidate.name,
        path: candidate.sourcePath,
        importable,
        ...(skipReason ? { skipReason } : {}),
        ...(candidate.version ? { version: candidate.version } : {}),
      });
    }
    summaries.push({
      scope: firstCandidate.sourceRootScope,
      path: firstCandidate.sourceRootPath,
      discoveredCount: groupCandidates.length,
      importableCount,
      skippedCount: groupCandidates.length - importableCount,
      skills: skills.sort((left, right) => left.name.localeCompare(right.name)),
    });
  }

  return summaries.sort((left, right) => {
    const byScope = left.scope.localeCompare(right.scope);
    return byScope !== 0 ? byScope : left.path.localeCompare(right.path);
  });
}

export async function importSkillsForAgent(
  workspacePath: string | undefined,
  agent: SettingsSyncAgent,
  sourceScope?: SettingsSyncSourceScope,
  targetScope?: SettingsSyncSourceScope,
  importMode: SettingsSyncImportMode = "symlink",
  skillPaths?: string[],
): Promise<SettingsSyncTaskImportResult> {
  const selectedSkillPaths = skillPaths ? new Set(skillPaths) : null;
  const candidates = (await collectSkillImportCandidates(workspacePath)).filter(
    (candidate) =>
      candidate.agent === agent &&
      (!sourceScope || candidate.sourceRootScope === sourceScope) &&
      (!selectedSkillPaths || selectedSkillPaths.has(candidate.sourcePath)),
  );
  let importedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const skillResults: SettingsSyncSkillImportResult[] = [];
  const existingNameKeysByTargetRoot = new Map<string, Set<string>>();

  for (const candidate of candidates) {
    const selectedTargetRoot = targetScope
      ? resolveTargetRootForScope(targetScope, workspacePath)
      : candidate.targetRoot;
    if (!selectedTargetRoot) {
      skippedCount += 1;
      skillResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "skipped",
        skipReason: "targetExists",
        ...(candidate.version ? { version: candidate.version } : {}),
      });
      continue;
    }
    const targetCandidate = {
      ...candidate,
      targetRoot: selectedTargetRoot,
      targetPath: join(selectedTargetRoot, basename(candidate.sourcePath)),
    };
    const skipReason = await getSkillImportCandidateSkipReason(
      targetCandidate,
      existingNameKeysByTargetRoot,
    );
    if (skipReason) {
      skippedCount += 1;
      skillResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "skipped",
        skipReason,
        ...(candidate.version ? { version: candidate.version } : {}),
      });
      continue;
    }
    try {
      await mkdir(dirname(targetCandidate.targetPath), { recursive: true });
      await importSkillDirectory(candidate.sourcePath, targetCandidate.targetPath, importMode);
      importedCount += 1;
      const existingNameKeys = existingNameKeysByTargetRoot.get(targetCandidate.targetRoot);
      if (existingNameKeys) {
        existingNameKeys.add(candidate.nameKey);
      }
      skillResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "imported",
        ...(candidate.version ? { version: candidate.version } : {}),
      });
    } catch {
      failedCount += 1;
      skillResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "failed",
        ...(candidate.version ? { version: candidate.version } : {}),
      });
    }
  }

  return {
    agent,
    category: "skills",
    status: failedCount > 0 ? "failed" : importedCount > 0 ? "success" : "skipped",
    importedCount,
    skippedCount,
    failedCount,
    skillResults,
  };
}

export async function scanMcpImportSources(workspacePath?: string): Promise<{
  candidates: McpImportCandidate[];
  diagnostics: SettingsSyncSourceDiagnostic[];
  roots: McpSourceRoot[];
}> {
  const candidates: McpImportCandidate[] = [];
  const diagnostics: SettingsSyncSourceDiagnostic[] = [];
  const seenSourceNames = new Set<string>();
  const roots = await getExternalMcpRoots(workspacePath);
  for (const root of roots) {
    if (!(await pathExists(root.rootPath))) {
      continue;
    }
    const readResult = await readMcpServersFromSourceFile(root.rootPath, root.format);
    diagnostics.push(...readResult.diagnostics);
    for (const [name, config] of Object.entries(readResult.servers)) {
      const sourcePath = `${root.rootPath}#${name}`;
      const seenKey = `${root.agent}:${sourcePath}`;
      if (seenSourceNames.has(seenKey)) {
        continue;
      }
      seenSourceNames.add(seenKey);
      candidates.push({
        agent: root.agent,
        name,
        nameKey: normalizeMcpServerNameKey(name),
        config: stripExternalMcpTimeoutFields(config),
        sourceRootScope: root.scope === "workspace" ? "project" : "global",
        sourceRootPath: root.rootPath,
        sourcePath,
        ...(readResult.oauthReauthenticationRequiredNames?.includes(name)
          ? { requiresOAuthReauthentication: true }
          : {}),
      });
    }
  }
  return { candidates, diagnostics, roots };
}
