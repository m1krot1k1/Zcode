/** Skill/MCP-гейт Computer Use и фильтрация skills, доступных дочернему агенту. */
import { createCoreError, CoreErrorType } from "../../deps.js";
import type {
  ExploreSubagentRuntimeRequest,
  SkillContent,
  SkillLoadOutcome,
  SkillOperationOptions,
  SkillPort,
} from "../../deps.js";
import type {
  SkillMarketplaceInstallRequest,
  SkillMarketplaceInstallResult,
  SkillMarketplaceSearchRequest,
  SkillMarketplaceSearchResult,
} from "@zcode/contracts";
import {
  SUBAGENT_COMPUTER_USE_UNAVAILABLE_CODE,
  SUBAGENT_COMPUTER_USE_UNAVAILABLE_MESSAGE,
  type OfficialCuaPolicy,
} from "../../../subagent/computer-use-policy.js";

type AllowedSkillDiscovery = SkillLoadOutcome & { parentSkillNames: string[] };

/**
 * Catalog projection for a role. Built-ins keep `skills: ["*", ...concrete]` for
 * compatibility; showing only the concrete names makes the role actually specialized
 * while `allowedSkills` still governs what can be loaded (including marketplace skills).
 */
export function resolvePreferredSkillNames(profile: {
  preferredSkills?: readonly string[] | undefined;
  skills?: readonly string[] | undefined;
}): readonly string[] | undefined {
  if (profile.preferredSkills && profile.preferredSkills.length > 0) {
    return profile.preferredSkills;
  }
  const concrete = profile.skills?.filter((name) => name !== "*") ?? [];
  if (concrete.length > 0) return concrete;
  return profile.skills;
}

export function resolveSubagentSkillPort(
  parentSkillPort: SkillPort | undefined,
  skillNames: readonly string[] | undefined,
  cuaPolicy: OfficialCuaPolicy,
  preferredSkillNames?: readonly string[] | undefined,
): SkillPort | undefined {
  if (!parentSkillPort) {
    return parentSkillPort;
  }
  // 根因：把空数组压成 undefined 会被过滤器解释为不限权，导致子代理拿到父级全部技能。
  // 修复依据：缺省和显式空白名单都应没有权限；只有逐项声明的技能可穿过此边界。
  return new FilteredSkillPort(
    parentSkillPort,
    new Set(skillNames ?? []),
    cuaPolicy,
    preferredSkillNames ? new Set(preferredSkillNames) : undefined,
  );
}

class FilteredSkillPort implements SkillPort {
  constructor(
    private readonly parent: SkillPort,
    private readonly allowedSkills: ReadonlySet<string> | undefined,
    private readonly cuaPolicy: OfficialCuaPolicy,
    private readonly preferredSkills: ReadonlySet<string> | undefined,
  ) {}

  async discoverSkills(
    request: Parameters<SkillPort["discoverSkills"]>[0],
    options?: SkillOperationOptions,
  ): Promise<SkillLoadOutcome> {
    const outcome = await this.discoverAllowedSkills(request, options);
    const skills = outcome.skills.filter((skill) => this.isPreferredSkill(skill));
    return {
      diagnostics: outcome.diagnostics,
      skills,
      totalDiscovered: skills.length,
    };
  }

  /** Непредпочтённое представление каталога для вложенного profile. */
  async discoverSkillsForDescendant(
    request: Parameters<SkillPort["discoverSkills"]>[0],
    options?: SkillOperationOptions,
  ): Promise<SkillLoadOutcome> {
    return this.discoverAllowedSkills(request, options);
  }

  private async discoverAllowedSkills(
    request: Parameters<SkillPort["discoverSkills"]>[0],
    options?: SkillOperationOptions,
  ): Promise<AllowedSkillDiscovery> {
    // 祖先 profile 的 preferredSkills 只控制该 agent 自己看到的目录，不应
    // 隐藏后代 profile 明确声明的技能；后代仍逐层经过每个祖先的 allowlist。
    const parentWithDescendantDiscovery = this.parent as SkillPort & {
      discoverSkillsForDescendant?: (
        nestedRequest: Parameters<SkillPort["discoverSkills"]>[0],
        nestedOptions?: SkillOperationOptions,
      ) => Promise<SkillLoadOutcome>;
    };
    const outcome = parentWithDescendantDiscovery.discoverSkillsForDescendant
      ? await parentWithDescendantDiscovery.discoverSkillsForDescendant(request, options)
      : await this.parent.discoverSkills(request, options);
    const parentSkillNames = outcome.skills.map((skill) => skill.qualifiedName ?? skill.name);
    const skills = outcome.skills.filter((skill) => this.isAllowedSkill(skill));
    return {
      diagnostics: outcome.diagnostics,
      skills,
      totalDiscovered: skills.length,
      parentSkillNames,
    };
  }

  async loadSkill(
    request: Parameters<SkillPort["loadSkill"]>[0],
    options?: SkillOperationOptions,
  ): Promise<SkillContent> {
    if (
      this.cuaPolicy.isOfficialSkillRequest(request.name) ||
      (await this.hasUniqueOfficialSkillMatch(request, options))
    ) {
      throw createSubagentComputerUseUnavailableError(request.name);
    }
    const resolution = await this.resolveAllowedSkillRequestName(request, options);
    const resolvedName = resolution.name;
    if (!resolvedName) {
      // 祖先白名单拒绝与当前目录未发现技能是两种故障；合并成“not allowed”会误导 Agent 以为环境禁用了 Skill。
      const message = resolution.allowedByProfile
        ? `Skill '${request.name}' is allowed by this subagent profile but is missing from the inherited skill catalog. Check the active workspace skill roots and ancestor allowlists.`
        : "Skill is not allowed for subagent";
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        message,
        {
          context: {
            allowedSkills: this.allowedSkills ? [...this.allowedSkills] : [],
            allowedByProfile: resolution.allowedByProfile,
            discoveredSkillNames: resolution.discoveredSkillNames,
            parentSkillNames: resolution.parentSkillNames,
            skill: request.name,
            toolName: "Skill",
          },
          recoverable: true,
        },
      );
    }
    return this.parent.loadSkill({ ...request, name: resolvedName }, options);
  }

  async searchMarketplace(
    request: SkillMarketplaceSearchRequest,
    options?: SkillOperationOptions,
  ): Promise<SkillMarketplaceSearchResult> {
    const search = this.parent.searchMarketplace;
    if (!search) {
      throw createCoreError(
        CoreErrorType.ConfigurationError,
        "Skill marketplace search is not available in this runtime",
        {
          context: { skillQuery: request.query, toolName: "SkillSearch" },
          recoverable: false,
        },
      );
    }
    return search.call(this.parent, request, options);
  }

  async installMarketplaceSkill(
    request: SkillMarketplaceInstallRequest,
    options?: SkillOperationOptions,
  ): Promise<SkillMarketplaceInstallResult> {
    const install = this.parent.installMarketplaceSkill;
    if (!install) {
      throw createCoreError(
        CoreErrorType.ConfigurationError,
        "Skill marketplace install is not available in this runtime",
        {
          context: {
            skillId: request.skillId,
            source: request.source,
            toolName: "SkillInstall",
          },
          recoverable: false,
        },
      );
    }
    return install.call(this.parent, request, options);
  }

  private async hasUniqueOfficialSkillMatch(
    request: Parameters<SkillPort["loadSkill"]>[0],
    options?: SkillOperationOptions,
  ): Promise<boolean> {
    if (request.name.includes(":")) return false;
    const outcome = await this.parent.discoverSkills(
      {
        workingDirectory: request.workingDirectory,
        roots: request.roots,
        trace: request.trace,
      },
      options,
    );
    return isUniqueOfficialSkillRequest(outcome.skills, request.name, this.cuaPolicy);
  }

  private isAllowedSkill(skill: SkillContent["metadata"]): boolean {
    if (this.cuaPolicy.isOfficialSkill(skill)) return false;
    return (
      this.allowedSkills?.has("*") === true ||
      this.allowedSkills === undefined ||
      this.allowedSkills.has(skill.name) ||
      (skill.qualifiedName !== undefined && this.allowedSkills.has(skill.qualifiedName))
    );
  }

  private isPreferredSkill(skill: SkillContent["metadata"]): boolean {
    if (!this.preferredSkills || this.preferredSkills.has("*")) return true;
    return (
      this.preferredSkills.has(skill.name) ||
      (skill.qualifiedName !== undefined && this.preferredSkills.has(skill.qualifiedName))
    );
  }

  private async resolveAllowedSkillRequestName(
    request: Parameters<SkillPort["loadSkill"]>[0],
    options?: SkillOperationOptions,
  ): Promise<{
    name?: string;
    allowedByProfile: boolean;
    discoveredSkillNames: string[];
    parentSkillNames: string[];
  }> {
    const outcome = await this.discoverAllowedSkills(
      {
        workingDirectory: request.workingDirectory,
        roots: request.roots,
        trace: request.trace,
      },
      options,
    );
    const matches = outcome.skills.filter((skill) => matchesSkillRequestName(skill, request.name));
    const allowedByProfile =
      this.allowedSkills?.has("*") === true || this.allowedSkills?.has(request.name) === true;
    if (matches.length === 0) {
      return {
        allowedByProfile,
        discoveredSkillNames: outcome.skills.map((skill) => skill.qualifiedName ?? skill.name),
        parentSkillNames: outcome.parentSkillNames,
      };
    }
    if (matches.length > 1) {
      throw createCoreError(
        CoreErrorType.ToolExecutionFailed,
        "Skill name is ambiguous for subagent; use the fully qualified skill name",
        {
          context: {
            allowedSkills: this.allowedSkills ? [...this.allowedSkills] : [],
            matchingSkills: matches.map((skill) => skill.qualifiedName ?? skill.name),
            skill: request.name,
            toolName: "Skill",
          },
          recoverable: true,
        },
      );
    }
    // 可见 skills 列表会把 plugin skill 展示为 qualified name，并声明 bare alias 也可加载。
    // 子 agent 按 bare alias 调用时，先绑定回过滤后的 metadata，避免父端按全局同名 skill 误加载。
    return {
      allowedByProfile: true,
      discoveredSkillNames: outcome.skills.map((skill) => skill.qualifiedName ?? skill.name),
      name: matches[0]?.qualifiedName ?? matches[0]?.name,
      parentSkillNames: outcome.parentSkillNames,
    };
  }
}

export async function validateSubagentComputerUseConfiguration(
  request: ExploreSubagentRuntimeRequest,
  cuaPolicy: OfficialCuaPolicy,
  parentSkillPort: SkillPort | undefined,
): Promise<void> {
  const explicitServer = request.profile.mcpServers?.find((serverName) =>
    cuaPolicy.serverNames.has(serverName.trim()),
  );
  const explicitTool = request.allowedTools.find(
    (toolName) =>
      cuaPolicy.isOfficialToolRequest(toolName) || cuaPolicy.isOfficialServerSelector(toolName),
  );
  let explicitSkill = request.profile.skills?.find((skillName) =>
    cuaPolicy.isOfficialSkillRequest(skillName),
  );
  if (!explicitSkill && parentSkillPort && request.profile.skills?.length) {
    try {
      const outcome = await parentSkillPort.discoverSkills({
        workingDirectory: request.workingDirectory,
        trace: request.traceContext,
      });
      explicitSkill = request.profile.skills.find((skillName) =>
        isUniqueOfficialSkillRequest(outcome.skills, skillName, cuaPolicy),
      );
    } catch {
      // Skill discovery remains lazy; a later Skill load will surface its own error.
    }
  }
  if (!explicitServer && !explicitTool && !explicitSkill) return;

  throw createCoreError(
    CoreErrorType.ConfigurationError,
    SUBAGENT_COMPUTER_USE_UNAVAILABLE_MESSAGE,
    {
      context: {
        agentType: request.agentType,
        code: SUBAGENT_COMPUTER_USE_UNAVAILABLE_CODE,
        ...(explicitServer ? { mcpServer: explicitServer } : {}),
        ...(explicitTool ? { mcpTool: explicitTool } : {}),
        ...(explicitSkill ? { skill: explicitSkill } : {}),
      },
      recoverable: true,
    },
  );
}

function isUniqueOfficialSkillRequest(
  skills: readonly SkillContent["metadata"][],
  requestName: string,
  cuaPolicy: Pick<OfficialCuaPolicy, "isOfficialSkill">,
): boolean {
  if (requestName.includes(":")) return false;
  const matches = skills.filter((skill) => matchesSkillRequestName(skill, requestName));
  return matches.length === 1 && matches[0] !== undefined && cuaPolicy.isOfficialSkill(matches[0]);
}

function createSubagentComputerUseUnavailableError(skillName: string) {
  return createCoreError(
    CoreErrorType.ToolExecutionFailed,
    SUBAGENT_COMPUTER_USE_UNAVAILABLE_MESSAGE,
    {
      context: {
        code: SUBAGENT_COMPUTER_USE_UNAVAILABLE_CODE,
        skill: skillName,
        toolName: "Skill",
      },
      recoverable: true,
    },
  );
}

function matchesSkillRequestName(skill: SkillContent["metadata"], requestName: string): boolean {
  return skill.name === requestName || skill.qualifiedName === requestName;
}
