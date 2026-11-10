#!/usr/bin/env node
// 跟踪文件隐私闸门：仓库里被 git 跟踪的文件不得包含本机 home 路径、
// 真实邮箱地址或常见令牌前缀。
//
// 背景：本地调试时把 /Users/<名字>/... 写进文档或示例、把真实邮箱留在
// fixture 里，提交后就会永久留在历史中；这类泄漏不会让任何测试失败。
//
// 约定：
//   - 扫描对象是 git 的索引与 HEAD，不是工作树：工作树可能被人为改干净而
//     暂存区/提交里仍有泄漏；索引里的内容就是下一次提交会带上的内容；
//   - 每次 pre-push（stdin 带 refs）额外扫描 push 范围内可达的 blob，
//     这样「提交里加过秘密、下一条提交又删掉」也会被拦下；
//   - git 调用统一带 -c core.quotepath=false，中文路径才能直接读取；
//   - 锁文件、压缩产物、assets/ 与第三方语料（third-party/、上游文档镜像）
//     整体豁免：这些内容来自外部，路径与作者邮箱不是本仓库的泄漏；
//   - fixture/文档示例里的合成用户名白名单放行（已人工评审），新出现的
//     用户名照报，闸门仍然对真实 home 路径敏感；
//   - 少量已评审的误报走 ALLOWLISTED_FINDINGS：每条都绑定具体文件、
//     完整命中值和可选的整行标记/整行精确匹配，不关闭任何类别；同一文件里
//     出现其它邮箱、用户名或密钥仍然照报，闸门对真实泄漏的敏感度不变；
//   - 闸门的测试夹具与普通文件一样受检，样本必须在运行时拼装，不能把 home 路径、
//     邮箱或令牌写成字面量；
//   - 只输出 文件:行号:类型，绝不回显命中的值，防止日志二次泄漏；
//   - 二进制文件（前 8KB 含 NUL）跳过。
//
// 用法：node scripts/check-tracked-privacy.mjs
// 退出码：0 未发现；1 发现至少一处或扫描无法完成。

import { execFileSync, spawn } from "node:child_process";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXCLUDED_BASENAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "THIRD-PARTY-NOTICES.md",
]);
// 第三方语料（licenses/upstream/inventory）与上游文档镜像：其中的路径、作者邮箱
// 属于被收录的第三方内容，不是本仓库的泄漏。
const EXCLUDED_PREFIXES = ["assets/", "third-party/", "docs/electron/", "docs/webdriverio/"];

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
    "dev",
    "me",
    "demo",
    "user",
    "username",
    "test",
    "you",
    "foo",
    "bar",
    "example",
    "alice",
    "bob",
    "carol",
    "dave",
    "erin",
    "frank",
    "tester",
    "somebody",
    "fake_user",
    "ubuntu",
    "shared",
    "linuxbrew",
    "u",
    "a",
    "name",
    "temp",
    "local",
    "remote",
    "project",
    "private",
    "secret",
    "fallback",
    "another",
    "default",
    "developer",
    ".zcode",
    "dev.zcode",
    "developer.zcode",
    "e2e",
    "ai",
  ].map((name) => name.toLowerCase()),
);

/**
 * 令牌特征：按公开前缀和真实密钥长度识别，避免截断后的 fixture 误报。
 * 新增前缀时同步 docs/testing/pre-push-hook.md 的覆盖表格。
 */
const TOKEN_RES = [
  /\bgh[pousr]_[A-Za-z0-9]{36,}/,
  // GitHub fine-grained PAT：github_pat_ + 至少 22 位 token 字符。
  /\bgithub_pat_[A-Za-z0-9_]{22,}/,
  // GitLab personal access token。
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  // Slack app/bot/user token。
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  // Google API key：AIza + 35 位。
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bsk-[A-Za-z0-9_-]{40,}/,
  // Stripe live secret key。
  /\bsk_live_[A-Za-z0-9]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/,
];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g;

/** URL 里的 user:pass@host 是凭据语法，不是邮箱；扫描前整段抹掉。 */
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/** 常见顶级域；没有它，`pkg@1.2.3.patch` 这类文件名会被当成邮箱。 */
const EMAIL_TLDS = new Set([
  "com",
  "org",
  "net",
  "edu",
  "gov",
  "mil",
  "int",
  "io",
  "dev",
  "ai",
  "app",
  "co",
  "me",
  "cn",
  "ru",
  "de",
  "fr",
  "uk",
  "jp",
  "kr",
  "us",
  "eu",
  "ca",
  "au",
  "info",
  "biz",
  "name",
  "pro",
  "xyz",
  "tech",
  "cloud",
  "site",
  "online",
  "page",
  "space",
  "website",
  "store",
  "blog",
  "design",
  "digital",
  "media",
  "news",
  "email",
  "social",
  "team",
  "tools",
  "works",
  "world",
  "zone",
  "sh",
  "so",
  "gg",
]);

/**
 * 已人工评审的误报，按「文件路径 + 类型 + 完整命中值」精确放行。
 *
 * - 只放行列出的值，不关闭类别；同一文件里出现其它邮箱、用户名或密钥仍然报出。
 * - 路径必须是精确文件，不接受目录前缀：目录里新增的真实泄漏不能被一起吞掉。
 * - 命中值在运行时拼装，避免闸门源文件本身变成泄漏样本（闸门扫描自己）。
 * - 新增条目前必须确认是第三方文档示例或测试夹具，不能用它放行真实身份。
 */
const PRISMA_DOC_EXAMPLE_EMAILS = [
  // Prisma 官方文档示例身份 alice/bob 与文档域名 prisma.io。
  ["alice", "prisma.io"].join("@"),
  ["bob", "prisma.io"].join("@"),
  // raw SQL 示例里的 LIKE 模式，本地部分只有一个 %。
  ["%", "prisma.io"].join("@"),
];

// Prisma 官方技能文档里出现示例邮箱的文件（HEAD 扫描命中的精确集合）。
// 不用目录前缀，避免该目录新增的真实邮箱被整体吞掉。
const PRISMA_DOC_FILES = [
  ".agents/skills/prisma-client-api/SKILL.md",
  ".agents/skills/prisma-client-api/references/client-methods.md",
  ".agents/skills/prisma-client-api/references/filters.md",
  ".agents/skills/prisma-client-api/references/model-queries.md",
  ".agents/skills/prisma-client-api/references/query-options.md",
  ".agents/skills/prisma-client-api/references/raw-queries.md",
  ".agents/skills/prisma-client-api/references/relations.md",
  ".agents/skills/prisma-client-api/references/transactions.md",
];

// Yandex WordStat 测试夹具里唯一的合成密钥行：openssl 被 stub，PEM 正文是
// TEST-NOT-A-REAL-KEY。只允许这一整行精确匹配，不能只凭标记放行任意 PEM 正文。
const PEM_BEGIN = "-----BEGIN " + "PRIVATE KEY-----";
const PEM_END = "-----END " + "PRIVATE KEY-----";
const YANDEX_SYNTHETIC_PEM_LINE =
  '  "private_key": "' + PEM_BEGIN + "\\nTEST-NOT-A-REAL-KEY\\n" + PEM_END + '\\n"';

const ALLOWLISTED_FINDINGS = [
  {
    // Prisma 官方技能文档自带的示例地址（alice/bob + 官方文档域名），不是本仓库
    // 作者的个人邮箱。只放行这些精确文件和这三个完整值。
    paths: PRISMA_DOC_FILES,
    type: "email",
    values: PRISMA_DOC_EXAMPLE_EMAILS,
  },
  {
    // 只放行与夹具完全一致的整行；同文件里出现真实 PEM（哪怕带合成标记）仍照报。
    path: ".agents/skills/yandex-wordstat/scripts/tests/test_iam_tmpdir_cleanup.sh",
    type: "token",
    values: [PEM_BEGIN],
    lineEquals: YANDEX_SYNTHETIC_PEM_LINE,
  },
  {
    // 单测里用于验证「API key 不落盘」的合成 OpenAI 风格字符串。
    // 只放行这一完整值；同文件里出现真实密钥仍然报出。
    path: "packages/services/test/code-intelligence/codeIntelligenceService.test.ts",
    type: "token",
    values: [["sk-example-embedding-token", "should-not-be-stored-in-sqlite"].join("-")],
  },
  {
    // work-ledger 路径解析的单字母占位用户名 x（文档注释与测试夹具）。
    // 只在这两个文件里放行 x；换成其它用户名（真实 home 路径）仍会报出。
    paths: [
      "apps/zcode-cli/packages/core/src/runtime-task/work-ledger-wire.ts",
      "apps/zcode-cli/packages/core/tests/work-ledger-wire.test.ts",
    ],
    type: "home-path",
    values: ["x"],
  },
  {
    // vendored 第三方插件（见 THIRD-PARTY-NOTICES.md）的上游作者元数据：
    // plugin.json 的 author.email 是插件清单格式要求的字段，属于被收录的上游
    // 内容，不是本仓库作者的泄漏。只放行这一完整值且只限带 "email" 字段的行；
    // 该文件或插件目录里出现其它邮箱仍然照报。
    path: "apps/zcode-cli/packages/superpowers-plugin/.zcode-plugin/plugin.json",
    type: "email",
    values: [["jesse", "fsck.com"].join("@")],
    lineIncludes: ['"email"'],
  },
];

/** 路径匹配：只接受精确文件路径，目录前缀不参与放行。 */
function matchesAllowlistedPath(file, entry) {
  const paths = entry.paths ?? (entry.path ? [entry.path] : []);
  return paths.some((path) => !path.endsWith("/") && file === path);
}

/**
 * 命中是否已被点对点白名单放行。
 *
 * values 是同一行同一类型的全部命中值；只有全部值都在放行集合里才抑制，
 * 这样「白名单值 + 同行的真实泄漏」不会被一起吞掉。lineEquals 要求整行
 * 与评审过的合成行完全一致，带任意正文的真实 PEM 无法借标记通过。
 */
export function isAllowlistedFinding(file, line, type, values) {
  if (values.length === 0) return false;
  const entries = ALLOWLISTED_FINDINGS.filter(
    (entry) =>
      entry.type === type &&
      matchesAllowlistedPath(file, entry) &&
      (entry.lineEquals === undefined || line === entry.lineEquals) &&
      (entry.lineIncludes ?? []).every((marker) => line.includes(marker)),
  );
  if (entries.length === 0) return false;
  // 邮箱大小写不敏感；home 用户名在 analyzeLine 已转小写；令牌按原样精确比较，
  // 避免大小写不敏感放大放行范围。
  const normalize = (value) => (type === "email" ? value.toLowerCase() : value);
  const allowed = new Set(entries.flatMap((entry) => entry.values).map(normalize));
  return values.every((value) => allowed.has(normalize(value)));
}

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
 * 扫描一行文本，返回命中明细（类型 + 完整命中值）。值只在进程内用于与
 * 点对点白名单比对，绝不回显。
 */
function analyzeLine(line) {
  const findings = [];

  if (line.includes("Users") || line.includes("home")) {
    const homeValues = [];
    for (const pattern of HOME_PATH_RES) {
      for (const match of line.matchAll(pattern)) {
        const name = match[1].toLowerCase();
        // `/Users/...`、`C:\Users\…` 是描述路径形状的写法，不是真实用户名。
        if (/^\.+$/.test(name) || name === "…") continue;
        // `/Users/foo.test.ts` 这类命中是文件名，不是 home 目录。
        if (/\.(?:[cm]?[jt]sx?|json|mdx?|txt|png|jpe?g|svg)$/.test(name)) continue;
        if (SYNTHETIC_USERS.has(name)) continue;
        homeValues.push(name);
      }
    }
    if (homeValues.length > 0) {
      findings.push({ type: "home-path", values: homeValues });
    }
  }

  if (line.includes("@")) {
    // URL 里的 user:pass@host 会命中邮箱正则，先按长度抹平，保留行内偏移。
    const withoutUrls = line.replace(URL_RE, (url) => " ".repeat(url.length));
    const emailValues = [];
    for (const match of withoutUrls.matchAll(EMAIL_RE)) {
      if (isLikelyEmail(match[0]) && !isAllowedEmail(match[0])) {
        emailValues.push(match[0]);
      }
    }
    if (emailValues.length > 0) {
      findings.push({ type: "email", values: emailValues });
    }
  }

  const tokenValues = [];
  for (const pattern of TOKEN_RES) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    for (const match of line.matchAll(new RegExp(pattern.source, flags))) {
      tokenValues.push(match[0]);
    }
  }
  if (tokenValues.length > 0) {
    findings.push({ type: "token", values: tokenValues });
  }

  return findings;
}

/**
 * 扫描一行文本，返回命中的类型集合（去重，保持固定顺序）。
 * 只返回类型，不返回命中的值。
 */
export function scanLine(line) {
  return analyzeLine(line).map((finding) => finding.type);
}

function gitRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

function gitStdout(root, args, options = {}) {
  return execFileSync("git", ["-c", "core.quotepath=false", ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
}

/**
 * 索引条目：git ls-files -s 的 `<mode> <sha> <stage>\t<path>`。
 * 冲突时同一路径可能有多个 stage；全部保留，按内容扫描。
 */
function listIndexEntries(root) {
  const stdout = gitStdout(root, ["ls-files", "-s", "-z"]);
  const entries = [];
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab <= 0) continue;
    const [mode, sha] = record.slice(0, tab).split(" ");
    const file = record.slice(tab + 1);
    if (!mode || !sha || !file) continue;
    entries.push({ file, sha });
  }
  return entries;
}

/** HEAD 树条目；空仓库（unborn HEAD）返回空列表。 */
function listHeadEntries(root) {
  let stdout;
  try {
    // unborn HEAD 的 stderr 是预期的「尚无提交」，不是闸门失败，静默处理。
    stdout = gitStdout(root, ["ls-tree", "-r", "-z", "HEAD"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  const entries = [];
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab <= 0) continue;
    const [, type, sha] = record.slice(0, tab).split(" ");
    const file = record.slice(tab + 1);
    if (type !== "blob" || !sha || !file) continue;
    entries.push({ file, sha });
  }
  return entries;
}

/** pre-push stdin：`<local-ref> <local-sha> <remote-ref> <remote-sha>` 每行一条。 */
function parsePrePushRefs(text) {
  return String(text ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/u);
      return { localRef, localSha, remoteRef, remoteSha };
    })
    .filter((entry) => entry.localRef && entry.localSha && entry.remoteRef && entry.remoteSha);
}

/**
 * push 范围内可达的 blob。pre-push 时扫描它，能拦住「提交里加过秘密、
 * 下一条提交又删掉」这种索引/HEAD 都干净的情况。
 *
 * 首次推送（remote sha 全 0）没有基线，不扫描完整历史；范围过大时也跳过并
 * 明确警告，避免一次 push 退化成扫描整个仓库历史。索引和 HEAD 始终扫描。
 */
function listPushRangeEntries(root) {
  const refs = parsePrePushRefs(process.env.ZCODE_PRE_PUSH_STDIN);
  const entries = [];
  const warnings = [];
  const maxBlobs = 200_000;
  for (const { localRef, localSha, remoteRef, remoteSha } of refs) {
    if (/^0+$/u.test(localSha)) continue;
    if (/^0+$/u.test(remoteSha)) {
      warnings.push(`首次推送 ${localRef}：未扫描完整历史`);
      continue;
    }
    let stdout;
    try {
      // -z: 每条记录以 NUL 分隔，blob 的路径是 `path=<path>` 字段；
      // 这样含空格或换行的路径不会被截断。
      stdout = gitStdout(root, ["rev-list", "--objects", "-z", `${remoteSha}..${localSha}`]);
    } catch {
      warnings.push(`无法读取 ${localRef} 的 push 范围（${remoteRef}），已跳过`);
      continue;
    }
    let added = 0;
    let pendingSha = null;
    for (const field of stdout.split("\0")) {
      if (!field) continue;
      if (field.startsWith("path=")) {
        const file = field.slice("path=".length);
        if (!pendingSha || !file) continue;
        entries.push({ file, sha: pendingSha });
        added += 1;
        pendingSha = null;
        continue;
      }
      pendingSha = field;
    }
    if (added === 0) warnings.push(`push 范围 ${localRef} 没有文件变化`);
    if (entries.length > maxBlobs) {
      warnings.push(`push 范围超过 ${maxBlobs} 个 blob，已跳过范围扫描`);
      return { entries: [], warnings };
    }
  }
  return { entries, warnings };
}

/** 二进制文件按字节判断，命中 NUL 即跳过，避免把图片当文本扫描。 */
function isBinary(buffer) {
  return buffer.subarray(0, 8192).includes(0);
}

/** 扫描一段 blob 内容；callback 对每个未放行命中调用一次。 */
function scanContent(file, content, onFinding) {
  const lines = content.toString("utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const finding of analyzeLine(line)) {
      if (isAllowlistedFinding(file, line, finding.type, finding.values)) continue;
      onFinding({ file, line: index + 1, type: finding.type });
    }
  }
}

/**
 * 用一次 git cat-file --batch 读取所有目标 blob。
 * targets 按 sha 分组，每个 sha 对应一个或多个路径（索引与 HEAD 可能路径不同）。
 */
async function scanBlobTargets(root, groups, onFinding) {
  const shas = [...groups.keys()];
  if (shas.length === 0) return;
  const child = spawn("git", ["cat-file", "--batch"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const closed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
  child.stdin.end(shas.join("\n") + "\n");

  let buffered = Buffer.alloc(0);
  let remaining = 0;
  let currentPaths = null;
  let headerPending = true;

  const processContent = (content) => {
    if (!isBinary(content)) {
      for (const file of currentPaths) scanContent(file, content, onFinding);
    }
  };

  for await (const chunk of child.stdout) {
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      if (headerPending) {
        const newline = buffered.indexOf(10);
        if (newline < 0) break;
        const line = buffered.subarray(0, newline).toString("utf8");
        buffered = buffered.subarray(newline + 1);
        const [sha, type, sizeText] = line.split(" ");
        if (type === "missing") {
          throw new Error(`git cat-file 无法读取对象 ${sha}（仓库可能不完整）`);
        }
        const size = Number(sizeText);
        // 非 blob 对象也会带正文；统一按 size 消费，避免后续 header 错位。
        currentPaths = type === "blob" ? (groups.get(sha) ?? []) : [];
        remaining = Number.isFinite(size) ? size : 0;
        headerPending = false;
        continue;
      }
      if (buffered.length < remaining + 1) break;
      const content = buffered.subarray(0, remaining);
      buffered = buffered.subarray(remaining + 1);
      processContent(content);
      currentPaths = null;
      remaining = 0;
      headerPending = true;
    }
  }

  const exitCode = await closed;
  if (exitCode !== 0) {
    throw new Error(`git cat-file --batch 失败（exit ${exitCode}）：${stderr.trim()}`);
  }
  if (!headerPending || currentPaths !== null) {
    throw new Error("git cat-file --batch 输出不完整");
  }
}

/** 目标去重：同一路径+内容只扫一次；索引和 HEAD 不同内容都会保留。 */
function buildBlobGroups(entries) {
  const groups = new Map();
  const seen = new Set();
  const files = new Set();
  for (const { file, sha } of entries) {
    if (isExcluded(file)) continue;
    files.add(file);
    const key = `${sha}\0${file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!groups.has(sha)) groups.set(sha, []);
    groups.get(sha).push(file);
  }
  return { groups, count: files.size };
}

async function main() {
  const root = gitRoot();
  const indexEntries = listIndexEntries(root);
  const headEntries = listHeadEntries(root);
  const pushRange = listPushRangeEntries(root);

  for (const warning of pushRange.warnings) {
    console.error(`[tracked-privacy] 注意：${warning}`);
  }

  // 同一 blob+路径只扫一次；索引与 HEAD 内容不同时两边都扫，避免索引被
  // 改成干净内容后掩盖 HEAD 里的历史泄漏。
  const { groups, count: scannedFiles } = buildBlobGroups([
    ...indexEntries,
    ...headEntries,
    ...pushRange.entries,
  ]);

  const findings = [];
  const reported = new Set();
  await scanBlobTargets(root, groups, (finding) => {
    const key = `${finding.file}:${finding.line}:${finding.type}`;
    if (reported.has(key)) return;
    reported.add(key);
    findings.push(finding);
  });

  for (const item of findings) {
    console.error(`${item.file}:${item.line}:${item.type}`);
  }

  if (findings.length > 0) {
    const counts = new Map();
    for (const item of findings) {
      counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
    }
    const summary = [...counts].map(([type, count]) => `${type}=${count}`).join(", ");
    console.error(
      `[tracked-privacy] 发现 ${findings.length} 处（${summary}），具体值已省略；扫描 ${scannedFiles} 个文件（索引 + HEAD + push 范围）`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `[tracked-privacy] OK：${scannedFiles} 个文件（索引 + HEAD + push 范围）未发现 home 路径、邮箱或令牌特征`,
  );
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    await main();
  } catch (error) {
    // 扫描没完成不等于没有泄漏；明确失败并阻止 push，不回显对象内容。
    console.error(`[tracked-privacy] 扫描失败：${error.message}`);
    process.exitCode = 1;
  }
}
