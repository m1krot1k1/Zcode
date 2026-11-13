/**
 * SKILL.md frontmatter 解析与 `_meta.json` 读取。
 * 这里只做文本/JSON 解析，不涉及目录扫描。
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { SkillMetadata } from "@zcode/shared";
import { isObjectRecord } from "./valueGuards.js";

interface ParsedFrontmatter {
  hasFrontmatter: boolean;
  name: string;
  description: string;
  body: string;
  /** frontmatter 中出现过的顶层 key，保留给后续能力判断，不再作为 warning 暴露。 */
  keys: string[];
  /** 严格 YAML 解析是否成功；失败时仍可能有 looseFields。 */
  parseOk: boolean;
}

const SKILL_META_FILE_NAME = "_meta.json";

/** 对齐 apps/zcode-cli/packages/adapters/src/skills/index.ts:19 */
export const MAX_DESCRIPTION_LENGTH = 1024;

export function readFrontmatter(content: string): ParsedFrontmatter {
  // SKILL.md 可能来自 Windows 或其他工具链，换行符不一定是 \n。
  // 先统一换行，再把 frontmatter 字段交给 YAML 解析，兼容多行 description。
  const normalized = content.replace(/\r\n|\r/g, "\n");
  const frontmatterMatch = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!frontmatterMatch) {
    return {
      hasFrontmatter: false,
      name: "",
      description: "",
      body: normalized.trim(),
      keys: [],
      parseOk: false,
    };
  }

  const frontmatterText = frontmatterMatch[1] ?? "";
  const frontmatterParts = splitFrontmatterAndLeakedBody(frontmatterText);
  const bodyAfterFrontmatter = normalized.slice(frontmatterMatch[0].length).trim();
  const body = [frontmatterParts.leakedBody, bodyAfterFrontmatter]
    .filter((part) => part.trim().length > 0)
    .join("\n\n")
    .trim();
  const looseFields = readLooseFrontmatterFields(frontmatterParts.metadataText);
  const looseKeys = extractLooseFrontmatterKeys(frontmatterParts.metadataText);
  if (hasYamlUnsafeLooseInlineField(frontmatterParts.metadataText)) {
    // 历史中文 description 常写成未加引号的 `触发场景: ...`。
    // `: ` 在 YAML plain scalar 中会被当成映射分隔符，严格解析只会报错；这里直接采用宽松读取结果，避免全量并发测试里反复进入失败解析路径。
    return {
      hasFrontmatter: true,
      ...looseFields,
      body,
      keys: looseKeys,
      parseOk: false,
    };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatterParts.metadataText);
  } catch {
    // 历史 skill 里存在 closing --- 前混入正文的非严格 YAML。
    // YAML 解析失败时回退到宽松字段读取，避免中文 description 等已存在 metadata 丢失。
    return {
      hasFrontmatter: true,
      ...looseFields,
      body,
      keys: looseKeys,
      parseOk: false,
    };
  }
  if (!isObjectRecord(parsed)) {
    return {
      hasFrontmatter: true,
      ...looseFields,
      body,
      keys: looseKeys,
      parseOk: false,
    };
  }

  return {
    hasFrontmatter: true,
    name: readFrontmatterString(parsed.name) || looseFields.name,
    description: readFrontmatterString(parsed.description) || looseFields.description,
    body,
    keys: Object.keys(parsed),
    parseOk: true,
  };
}

function splitFrontmatterAndLeakedBody(frontmatterText: string): {
  metadataText: string;
  leakedBody: string;
} {
  const lines = frontmatterText.split("\n");
  const leakedBodyStartIndex = lines.findIndex(
    (line, index) =>
      index > 0 &&
      // 部分历史 skill 把正文标题写在 closing --- 之前。
      // 遇到 Markdown 标题时，将这一段从 frontmatter 挪回 body，避免说明内容被解析阶段吞掉。
      /^#{1,6}\s+\S/.test(line),
  );
  if (leakedBodyStartIndex < 0) {
    return { metadataText: frontmatterText, leakedBody: "" };
  }
  return {
    metadataText: lines.slice(0, leakedBodyStartIndex).join("\n").trimEnd(),
    leakedBody: lines.slice(leakedBodyStartIndex).join("\n").trim(),
  };
}

function readLooseFrontmatterFields(frontmatterText: string): {
  name: string;
  description: string;
} {
  let name = "";
  let description = "";
  const lines = frontmatterText.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const colonIndex = line.indexOf(":");
    if (colonIndex < 0) {
      continue;
    }
    const key = line.slice(0, colonIndex).trim();
    const rawValue = line.slice(colonIndex + 1).trim();
    if (key === "name") {
      name = readLooseFrontmatterInlineString(rawValue);
    } else if (key === "description") {
      const blockStyle = rawValue[0];
      if (blockStyle === "|" || blockStyle === ">") {
        const blockLines: string[] = [];
        for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
          const nextLine = lines[nextIndex] ?? "";
          if (!nextLine.startsWith(" ") && !nextLine.startsWith("\t")) {
            break;
          }
          blockLines.push(nextLine.replace(/^\s{1,2}/, ""));
          index = nextIndex;
        }
        description = blockStyle === ">" ? blockLines.join(" ") : blockLines.join("\n");
      } else {
        description = readLooseFrontmatterInlineString(rawValue);
      }
    }
  }
  return { name, description };
}

/**
 * 只收集 frontmatter 顶层 key（缩进行视为子字段，跳过）。
 * 用来给 unknown-key 诊断与 YAML 解析失败时的回退提供 keys 列表。
 */
function extractLooseFrontmatterKeys(frontmatterText: string): string[] {
  const keys: string[] = [];
  for (const line of frontmatterText.split("\n")) {
    if (line.length === 0) continue;
    if (/^\s/.test(line)) continue;
    if (line.trim().startsWith("#")) continue;
    const colonIndex = line.indexOf(":");
    if (colonIndex <= 0) continue;
    const key = line.slice(0, colonIndex).trim();
    if (key.length === 0) continue;
    if (!keys.includes(key)) {
      keys.push(key);
    }
  }
  return keys;
}

function hasYamlUnsafeLooseInlineField(frontmatterText: string): boolean {
  const lines = frontmatterText.split("\n");
  for (const line of lines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex < 0) {
      continue;
    }
    const key = line.slice(0, colonIndex).trim();
    if (key !== "name" && key !== "description") {
      continue;
    }
    const rawValue = line.slice(colonIndex + 1).trim();
    if (
      rawValue.length === 0 ||
      rawValue.startsWith('"') ||
      rawValue.startsWith("'") ||
      rawValue.startsWith("|") ||
      rawValue.startsWith(">")
    ) {
      continue;
    }
    if (rawValue.includes(": ")) {
      return true;
    }
  }
  return false;
}

function readLooseFrontmatterInlineString(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

function readFrontmatterString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

export async function readSkillMetadata(skillPath: string): Promise<SkillMetadata | undefined> {
  const metaPath = join(dirname(skillPath), SKILL_META_FILE_NAME);
  const raw = await readFile(metaPath, "utf-8").catch(() => null);
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObjectRecord(parsed)) {
      return undefined;
    }
    const metadata: SkillMetadata = {};
    if (typeof parsed.slug === "string" && parsed.slug.trim().length > 0) {
      metadata.slug = parsed.slug.trim();
    }
    if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
      metadata.version = parsed.version.trim();
    }
    if (typeof parsed.ownerId === "string" && parsed.ownerId.trim().length > 0) {
      metadata.ownerId = parsed.ownerId.trim();
    }
    if (typeof parsed.publishedAt === "number" && Number.isFinite(parsed.publishedAt)) {
      metadata.publishedAt = parsed.publishedAt;
    }
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  } catch {
    // _meta.json 是 skill 安装器的附加信息，损坏时不应影响 SKILL.md 本体展示。
    return undefined;
  }
}
