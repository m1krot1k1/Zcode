#!/usr/bin/env node
// 跟踪文件隐私闸门：仓库里被 git 跟踪的文件不得包含本机 home 路径、
// 真实邮箱地址或常见令牌前缀。
//
// 背景：本地调试时把 /Users/<名字>/... 写进文档或示例、把真实邮箱留在
// fixture 里，提交后就会永久留在历史中；这类泄漏不会让任何测试失败。
//
// 约定：
//   - 只扫描 git 跟踪的文件（node_modules 本来就不会被跟踪）；
//   - git 调用统一带 -c core.quotepath=false，中文路径才能直接读取；
//   - 锁文件、压缩产物、assets/ 与第三方语料（third-party/、上游文档镜像）
//     整体豁免：这些内容来自外部，路径与作者邮箱不是本仓库的泄漏；
//   - fixture/文档示例里的合成用户名白名单放行（已人工评审），新出现的
//     用户名照报，闸门仍然对真实 home 路径敏感；
//   - 只输出 文件:行号:类型，绝不回显命中的值，防止日志二次泄漏；
//   - 二进制文件（前 8KB 含 NUL）跳过。
//
// 用法：node scripts/check-tracked-privacy.mjs
// 退出码：0 未发现；1 发现至少一处。

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXCLUDED_BASENAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "THIRD-PARTY-NOTICES.md",
]);
// 第三方语料（licenses/upstream/inventory）与上游文档镜像：其中的路径、作者邮箱
// 属于被收录的第三方内容，不是本仓库的泄漏。
const EXCLUDED_PREFIXES = [
  "assets/",
  "third-party/",
  "docs/electron/",
  "docs/webdriverio/",
  // 内置第三方插件（含上游作者的元数据邮箱）。
  "apps/zcode-cli/packages/superpowers-plugin/",
];

/** home 目录：macOS /Users/<name>、Linux /home/<name>、Windows C:\Users\<name>。 */
const HOME_PATH_RES = [
  /\/Users\/([A-Za-z0-9._-]+)/g,
  /\/home\/([A-Za-z0-9._-]+)/g,
  /[A-Za-z]:\\Users\\([A-Za-z0-9._-]+)/g,
];

/**
 * 已评审的合成身份：测试 fixture 与文档示例里的占位用户名。
 * 新增条目必须确认不是真实用户名，否则闸门会失去意义。
 */
const SYNTHETIC_USERS = new Set(
  [
    "dev", "me", "demo", "user", "username", "test", "you", "foo", "bar",
    "example", "alice", "bob", "carol", "dave", "erin", "frank", "tester",
    "somebody", "fake_user", "ubuntu", "shared", "linuxbrew", "u", "a", "name",
    "temp", "local", "remote", "project", "private", "secret", "fallback",
    "another", "default", "developer", ".zcode", "dev.zcode", "developer.zcode",
    "e2e", "ai",
  ].map((name) => name.toLowerCase()),
);

/** 令牌特征：按公开前缀和真实密钥长度识别，避免截断后的 fixture 误报。 */
const TOKEN_RES = [
  /\bgh[pousr]_[A-Za-z0-9]{36,}/,
  /\bsk-[A-Za-z0-9_-]{40,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/,
];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g;

/** URL 里的 user:pass@host 是凭据语法，不是邮箱；扫描前整段抹掉。 */
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/** 常见顶级域；没有它，`pkg@1.2.3.patch` 这类文件名会被当成邮箱。 */
const EMAIL_TLDS = new Set([
  "com", "org", "net", "edu", "gov", "mil", "int", "io", "dev", "ai", "app",
  "co", "me", "cn", "ru", "de", "fr", "uk", "jp", "kr", "us", "eu", "ca", "au",
  "info", "biz", "name", "pro", "xyz", "tech", "cloud", "site", "online", "page",
  "space", "website", "store", "blog", "design", "digital", "media", "news",
  "email", "social", "team", "tools", "works", "world", "zone", "sh", "so", "gg",
]);

/** 保留域名、代码托管与项目官方域名：出现邮箱不是个人信息泄漏。 */
const ALLOWED_EMAIL_DOMAINS = new Set([
  "example.com",
  "github.com",
  "codeload.github.com",
  "openssh.com",
  "zcode.z.ai",
  // 占位域名（示例、fixture）。
  "domain.com",
  "repo.com",
]);

/**
 * 已评审的逐文件例外：这些测试的用途就是构造令牌/密钥样本来验证脱敏逻辑，
 * 样本必须存在，不属于泄漏。新增条目必须写明理由。
 */
const EXEMPT_FINDINGS = new Map([
  ["packages/shared/test/feedbackPrivacy.test.ts", new Set(["token"])],
  ["packages/shared/test/telemetryPrivacy.test.ts", new Set(["token"])],
  ["packages/shared/test/telemetryRedaction.test.ts", new Set(["token"])],
]);

/** 占位本地部分（user@、name@ 之类），用于文档模板。 */
const PLACEHOLDER_LOCAL_PARTS = new Set([
  "git",
  "user",
  "name",
  "someone",
  "noreply",
  "you",
  "test",
  "dev",
  "foo",
  "bar",
  "example",
]);

/** 允许出现的邮箱：GitHub noreply、example.com 及其子域、官方域名。 */
export function isAllowedEmail(email) {
  const lower = email.toLowerCase();
  const at = lower.lastIndexOf("@");
  const local = lower.slice(0, at);
  const domain = lower.slice(at + 1);
  if (local === "noreply@github.com") return true;
  if (PLACEHOLDER_LOCAL_PARTS.has(local)) return true;
  if (domain === "example.com" || domain.endsWith(".example.com")) return true;
  // GitHub noreply 形如 <id>+<user>@users.noreply.github.com 或
  // <login>@users.noreply.github.com；子域属于保留域名，不是个人邮箱泄漏。
  if (domain === "github.com" || domain.endsWith(".github.com")) return true;
  return ALLOWED_EMAIL_DOMAINS.has(domain);
}

/** 看起来像真实邮箱：顶级域在常见集合内。 */
export function isLikelyEmail(value) {
  const tld = value.slice(value.lastIndexOf(".") + 1).toLowerCase();
  return EMAIL_TLDS.has(tld);
}

/** 文件是否整体豁免扫描。 */
export function isExcluded(file) {
  if (EXCLUDED_BASENAMES.has(basename(file))) return true;
  if (file.endsWith(".min.js")) return true;
  if (file.split("/").includes("node_modules")) return true;
  return EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix));
}

/**
 * 扫描一行文本，返回命中的类型集合（去重，保持固定顺序）。
 * 只返回类型，不返回命中的值。
 */
export function scanLine(line) {
  const types = [];
  const homeHit = HOME_PATH_RES.some((pattern) =>
    [...line.matchAll(pattern)].some((match) => {
      const name = match[1].toLowerCase();
      // `/Users/...`、`C:\Users\…` 是描述路径形状的写法，不是真实用户名。
      if (/^\.+$/.test(name) || name === "…") return false;
      // `/Users/foo.test.ts` 这类命中是文件名，不是 home 目录。
      if (/\.(?:[cm]?[jt]sx?|json|mdx?|txt|png|jpe?g|svg)$/.test(name)) return false;
      return !SYNTHETIC_USERS.has(name);
    }),
  );
  if (homeHit) {
    types.push("home-path");
  }

  // URL 里的 user:pass@host 会命中邮箱正则，先按长度抹平，保留行内偏移。
  const withoutUrls = line.replace(URL_RE, (url) => " ".repeat(url.length));
  for (const match of withoutUrls.matchAll(EMAIL_RE)) {
    if (isLikelyEmail(match[0]) && !isAllowedEmail(match[0])) {
      types.push("email");
      break;
    }
  }
  if (TOKEN_RES.some((pattern) => pattern.test(line))) {
    types.push("token");
  }
  return types;
}

function gitRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

function listTrackedFiles(root) {
  const stdout = execFileSync(
    "git",
    ["-c", "core.quotepath=false", "ls-files", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout.split("\0").filter(Boolean);
}

/** 二进制文件按字节读，命中 NUL 即跳过，避免把图片当文本扫描。 */
function isBinary(buffer) {
  return buffer.subarray(0, 8192).includes(0);
}

function main() {
  const root = gitRoot();
  const files = listTrackedFiles(root);
  const findings = [];

  for (const file of files) {
    if (isExcluded(file)) continue;
    const absolute = resolve(root, file);
    const stats = statSync(absolute);
    if (!stats.isFile() || stats.size === 0) continue;

    const buffer = readFileSync(absolute);
    if (isBinary(buffer)) continue;

    const lines = buffer.toString("utf8").split(/\r?\n/);
    const exempt = EXEMPT_FINDINGS.get(file);
    for (let index = 0; index < lines.length; index += 1) {
      for (const type of scanLine(lines[index])) {
        if (exempt?.has(type)) continue;
        findings.push({ file, line: index + 1, type });
      }
    }
  }

  for (const item of findings) {
    console.error(`${item.file}:${item.line}:${item.type}`);
  }

  if (findings.length > 0) {
    const counts = new Map();
    for (const item of findings) {
      counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
    }
    const summary = [...counts]
      .map(([type, count]) => `${type}=${count}`)
      .join(", ");
    console.error(
      `[tracked-privacy] 发现 ${findings.length} 处（${summary}），具体值已省略；扫描 ${files.length} 个跟踪文件`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `[tracked-privacy] OK：${files.length} 个跟踪文件未发现 home 路径、邮箱或令牌特征`,
  );
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
