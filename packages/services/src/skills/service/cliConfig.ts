/**
 * CLI config（`~/.zcode/cli/config.json`）读取与技能开关持久化。
 * 技能开关只按 SKILL.md 路径写入 config.skills，不引入额外状态文件。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isObjectRecord } from "./valueGuards.js";
import { resolveUserHomeDir } from "./skillPaths.js";

export const SKILL_CLI_SETTINGS_DIR = join(resolveUserHomeDir(), ".zcode", "cli");
export const SKILL_CLI_CONFIG_FILE = join(SKILL_CLI_SETTINGS_DIR, "config.json");

export function normalizeSkillConfigPath(path: string): string {
  return path.replaceAll("\\", "/");
}

export async function readCliConfigFile(): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(SKILL_CLI_CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return isObjectRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readSkillEnabledMapFromConfig(config: Record<string, unknown>): Record<string, boolean> {
  const skillsConfig = isObjectRecord(config.skills) ? config.skills : {};
  const result: Record<string, boolean> = {};
  for (const [path, value] of Object.entries(skillsConfig)) {
    if (isObjectRecord(value) && typeof value.enable === "boolean") {
      result[normalizeSkillConfigPath(path)] = value.enable;
    }
  }
  return result;
}

export async function readSkillEnabledMap(): Promise<Record<string, boolean>> {
  return readSkillEnabledMapFromConfig(await readCliConfigFile());
}

export async function writeSkillEnabledMap(next: Record<string, boolean>): Promise<void> {
  const config = await readCliConfigFile();
  const skillsConfig = isObjectRecord(config.skills) ? config.skills : {};
  for (const [path, enable] of Object.entries(next).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    // 技能开关之前分散在 workspace/provider/context 状态文件，导致同一技能在不同入口表现不一致。
    // 现在只按 SKILL.md 路径写入 CLI config 的 skills 字段，避免额外迁移或旧文件副作用。
    const normalizedPath = normalizeSkillConfigPath(path);
    if (enable) {
      // 开启态是默认值，不应落盘成 `{ enable: true }`；删除 override 才能跟随插件/默认配置变化。
      delete skillsConfig[normalizedPath];
    } else {
      skillsConfig[normalizedPath] = { enable };
    }
  }
  if (Object.keys(skillsConfig).length > 0) {
    config.skills = skillsConfig;
  } else {
    delete config.skills;
  }
  await mkdir(SKILL_CLI_SETTINGS_DIR, { recursive: true });
  await writeFile(SKILL_CLI_CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}
