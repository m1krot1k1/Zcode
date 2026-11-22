#!/usr/bin/env node
// 文档链接闸门：docs/ 与根目录 *.md 中的相对链接必须指向真实存在的文件。
//
// 背景：文档拆分、目录改名后残留的相对链接不会让任何构建失败，却会把读者和
// 后续 agent 引向不存在的位置；等有人照着链接找文件时才发现，成本已经很高。
//
// 约定：
//   - 只检查 git 跟踪的 Markdown，避免扫描 node_modules 与构建产物；
//   - git 调用统一带 -c core.quotepath=false，否则中文/空格路径会被转义成
//     \346\226\207 形式，匹配文件系统时必然失败；
//   - 只认 [text](target) 形式；外部链接、纯锚点、站内绝对路径、模板占位符
//     以及代码块里的示例不检查；
//   - target#anchor 只校验文件本身，锚点是否存在不在本闸门范围内；
//   - 相对路径从「文件所在目录」解析，不是仓库根目录；
//   - 上游文档镜像（docs/electron、docs/webdriverio）整体跳过：它们是从
//     第三方站点裁剪进来的，链接按上游站点路由书写，不指向本仓库文件。
//
// 用法：node scripts/check-doc-links.mjs
// 退出码：0 全部有效；1 存在失效链接。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 第三方文档镜像：链接语义属于上游站点，不按本仓库文件校验。 */
const MIRRORED_DOC_PREFIXES = ["docs/electron/", "docs/webdriverio/"];

/** Markdown 里最常见的内联链接；标签内的方括号与括号嵌套不在本闸门范围内。 */
const LINK_RE = /\[[^\]]*\]\(([^)]*)\)/g;
/** 代码围栏起始行：最多 3 个空格缩进，``` 或 ~~~ 至少 3 个。 */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** 代码围栏结束行：同种字符、长度不小于起始行、后面不能再有信息串。 */
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/;

/**
 * 提取文件中所有内联链接，跳过围栏代码块与行内代码。
 * 返回的 line 从 1 开始，target 保留原始写法（便于报错时直接定位）。
 */
export function extractLinks(source) {
  const links = [];
  const lines = source.split(/\r?\n/);
  let fence = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (fence) {
      const close = line.match(FENCE_CLOSE_RE);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }

    const open = line.match(FENCE_OPEN_RE);
    if (open) {
      fence = { char: open[1][0], length: open[1].length };
      continue;
    }

    // 行内代码里的 [x](y) 只是示例，按 CommonMark 不应算链接。
    const withoutInlineCode = line.replace(/`[^`]*`/g, "");
    for (const match of withoutInlineCode.matchAll(LINK_RE)) {
      links.push({ line: index + 1, target: match[1].trim() });
    }
  }

  return links;
}

/**
 * 把链接目标收敛成「相对文件路径」；不需要检查的链接返回 null。
 * 外部协议、纯锚点、站内绝对路径、模板占位符都在这里被过滤掉。
 */
export function toRelativePath(rawTarget) {
  let target = rawTarget.trim();
  if (!target) return null;

  if (target.startsWith("<")) {
    // CommonMark 允许用尖括号包裹带空格的路径。
    const end = target.indexOf(">");
    if (end > 0) target = target.slice(1, end);
  } else {
    // 去掉 "title" / 'title' 形式的后缀标题。
    const withTitle = target.match(/^(\S+)\s+["'(].*$/);
    if (withTitle) target = withTitle[1];
  }

  if (!target || target.startsWith("#")) return null;
  // http: / https: / mailto: / tel: / file: 等一律按外部链接处理。
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) return null;
  // 以 / 开头的是站点绝对路径，不对应仓库内文件。
  if (target.startsWith("/")) return null;
  // {{var}}、${var} 之类是模板占位符，无法静态校验。
  if (target.includes("{{") || target.includes("${")) return null;

  const withoutFragment = target.split("#")[0];
  const withoutQuery = withoutFragment.split("?")[0];
  if (!withoutQuery) return null;

  try {
    return decodeURIComponent(withoutQuery);
  } catch {
    // 非法百分号编码保持原样，让存在性检查给出结论。
    return withoutQuery;
  }
}

/** 仓库根目录；从子目录调用也能正确解析。 */
function gitRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

/** 用 NUL 分隔读取跟踪文件，避免空格与换行文件名被拆开。 */
function listTrackedMarkdown(root) {
  const stdout = execFileSync("git", ["-c", "core.quotepath=false", "ls-files", "-z", "*.md"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.split("\0").filter(Boolean);
}

/** 只检查 docs/ 与仓库根目录下的 Markdown。 */
export function inScope(file) {
  if (!file.includes("/") || file.startsWith("docs/")) {
    return !MIRRORED_DOC_PREFIXES.some((prefix) => file.startsWith(prefix));
  }
  return false;
}

function main() {
  const root = gitRoot();
  const files = listTrackedMarkdown(root).filter(inScope);
  const broken = [];
  let checked = 0;

  for (const file of files) {
    const absolute = resolve(root, file);
    const source = readFileSync(absolute, "utf8");
    for (const link of extractLinks(source)) {
      const relative = toRelativePath(link.target);
      if (!relative) continue;
      checked += 1;
      if (!existsSync(resolve(dirname(absolute), relative))) {
        broken.push({ file, line: link.line, target: link.target });
      }
    }
  }

  for (const item of broken) {
    console.error(`${item.file}:${item.line} -> ${item.target}`);
  }

  if (broken.length > 0) {
    console.error(
      `[doc-links] ${broken.length} 处失效链接（已检查 ${checked} 条相对链接，${files.length} 个文件）`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`[doc-links] OK：${files.length} 个文件、${checked} 条相对链接全部有效`);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
