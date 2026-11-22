#!/usr/bin/env node
// check-tracked-privacy 的回归测试：单元覆盖三类特征与豁免规则，端到端覆盖
// 退出码以及「输出不得回显命中值」这条硬约束。
//
// 这个文件本身也在闸门扫描范围内（索引 + HEAD），所以「应当被报出」的样本
// 一律在运行时拼装：写成字面量会让本文件变成泄漏样本，只能靠自我豁免放行，
// 闸门也就失去了意义。

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import {
  isExcluded,
  parseRevListObjects,
  scanLine,
} from "./check-tracked-privacy.mjs";

const SCRIPT = fileURLToPath(
  new URL("./check-tracked-privacy.mjs", import.meta.url),
);

function makeRepo(files) {
  const root = mkdtempSync(join(tmpdir(), "tracked-privacy-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function commit(root, message) {
  git(root, ["commit", "-qm", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

function runGate(root, env = {}) {
  // 父进程若在 pre-push 环境里，不能把 refs 泄漏进单测的临时仓库。
  const { ZCODE_PRE_PUSH_STDIN: _ignored, ...baseEnv } = process.env;
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    encoding: "utf8",
    env: { ...baseEnv, ...env },
  });
}

/** 写入临时仓库的净化历史基线（scripts/privacy-sanitized-history.json）。 */
function writeSanitizedHistory(root, entries) {
  const file = join(root, "scripts", "privacy-sanitized-history.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, entries }, null, 2));
}

/** 把某路径在某提交里的 blob SHA 取出来，供基线断言使用。 */
function blobAt(root, commit, path) {
  return git(root, ["rev-parse", `${commit}:${path}`]);
}

/** 拼一个长度为 length 的占位令牌主体，避免在测试文件里写出真实形态的密钥。 */
const body = (prefix, length) => prefix + "a".repeat(length);

// 非合成用户名：不在 SYNTHETIC_USERS 白名单里，必须被报出。
const REAL_USER = "iv" + "an";
// 个人邮箱：本地部分与域名分别拼装，源码里没有完整的地址字面量。
const REAL_EMAIL = [REAL_USER, "petrov"].join(".") + "@" + "corp" + ".ru";
// home 路径前缀同样拆开，源码里不出现 `/Users/<名字>` 这种形态。
const posixHome = (name) => "/" + "Users" + "/" + name;
const linuxHome = (name) => "/" + "home" + "/" + name;
const windowsHome = (name) => "C:" + "\\" + "Users" + "\\" + name;
// 令牌样本同样只在运行时成形：AWS 文档里的示例 key。
const awsKey = "AKIA" + "B".repeat(16);

// 新增平台的令牌形态；前缀与主体分别拼装，避免本文件自己变成样本。
const tokenSamples = {
  githubPat: "github" + "_pat_" + "A".repeat(30),
  gitlabPat: "glpat" + "-" + "b".repeat(24),
  slackToken: "xoxb" + "-" + "1".repeat(20),
  googleApiKey: "AIza" + "C".repeat(35),
  stripeLiveKey: "sk" + "_live_" + "d".repeat(24),
};

// allowlist 夹具：路径与值都取自 scanner 的已评审条目，值仍在运行时拼装。
const prismaDocDir = ".agents/skills/prisma-client-api/";
const prismaDocFile = `${prismaDocDir}SKILL.md`;
const prismaUnlistedFile = `${prismaDocDir}references/constructor.md`;
const prismaExampleEmail = ["alice", "prisma.io"].join("@");
const yandexFixturePath =
  ".agents/skills/yandex-wordstat/scripts/tests/test_iam_tmpdir_cleanup.sh";
// 与 allowlist 条目完全一致的 PEM 头/尾（非 RSA），用于验证整行精确匹配。
const pemBegin = "-----BEGIN " + "PRIVATE KEY-----";
const pemEnd = "-----END " + "PRIVATE KEY-----";
const syntheticPemLine =
  '  "private_key": "' +
  pemBegin +
  "\\nTEST-NOT-A-REAL-KEY\\n" +
  pemEnd +
  '\\n"';
// 任意 base64 正文：只用于证明「有标记不等于可放行」。
const arbitraryPemBody = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC";
// vendored Superpowers 插件清单的上游作者邮箱；目录不再整体豁免，只放行这一值。
const superpowersPluginJson =
  "apps/zcode-cli/packages/superpowers-plugin/.zcode-plugin/plugin.json";
const superpowersPluginDir = "apps/zcode-cli/packages/superpowers-plugin/";
const superpowersPluginEmail = ["jesse", "fsck.com"].join("@");

test("home 路径：三种平台都识别，合成用户名不报", () => {
  assert.deepEqual(scanLine(`cwd=${posixHome(REAL_USER)}/projects/zcode`), [
    "home-path",
  ]);
  assert.deepEqual(scanLine(`cwd=${linuxHome(REAL_USER)}/work`), ["home-path"]);
  assert.deepEqual(scanLine(`path=${windowsHome(REAL_USER)}\\work`), [
    "home-path",
  ]);
  assert.deepEqual(scanLine("示例 /Users/alice/project 与 /home/dev/app"), []);
});

test("邮箱：allowlist 放行，真实个人邮箱报出", () => {
  assert.deepEqual(scanLine("联系人 12345+dev@users.noreply.github.com"), []);
  assert.deepEqual(scanLine("示例 mailto:someone@example.com"), []);
  assert.deepEqual(scanLine(`作者 ${REAL_EMAIL} 提交`), ["email"]);
  // URL 里的 user:pass@host 是凭据语法，不是邮箱。
  assert.deepEqual(
    scanLine("clone https://user:secret@github.com/o/r.git"),
    [],
  );
});

test("令牌前缀：达到真实长度才报，截断的 fixture 不报", () => {
  assert.deepEqual(scanLine(`token=${body("ghp_", 36)}`), ["token"]);
  assert.deepEqual(scanLine(`key=${body("sk-", 40)}`), ["token"]);
  assert.deepEqual(scanLine(awsKey), ["token"]);
  assert.deepEqual(scanLine(pemBegin), ["token"]);
  assert.deepEqual(scanLine(`short=${body("ghp_", 8)}`), []);
});

test("令牌前缀：GitHub/GitLab/Slack/Google/Stripe 新格式都识别", () => {
  for (const value of Object.values(tokenSamples)) {
    assert.deepEqual(scanLine(`token=${value}`), ["token"], value.slice(0, 8));
  }
  // 截断到阈值以下不应误报。
  assert.deepEqual(scanLine(`token=${"github" + "_pat_" + "A".repeat(5)}`), []);
  assert.deepEqual(scanLine(`token=${"glpat" + "-" + "b".repeat(5)}`), []);
  assert.deepEqual(scanLine(`token=${"xoxb" + "-" + "1".repeat(5)}`), []);
  assert.deepEqual(scanLine(`token=${"AIza" + "C".repeat(20)}`), []);
  assert.deepEqual(scanLine(`token=${"sk" + "_live_" + "d".repeat(5)}`), []);
});

test("整文件豁免：锁文件、压缩产物、assets 与第三方语料", () => {
  assert.equal(isExcluded("package-lock.json"), true);
  assert.equal(isExcluded("pnpm-lock.yaml"), true);
  assert.equal(isExcluded("packages/ui/dist/app.min.js"), true);
  assert.equal(isExcluded("assets/logo.svg"), true);
  assert.equal(isExcluded("third-party/LICENSE"), true);
  assert.equal(isExcluded("src/index.ts"), false);
});

test("端到端：发现泄漏时退出码 1，且输出不含命中值", () => {
  const secret = body("ghp_", 36);
  const root = makeRepo({
    "docs/notes.md": `本机路径 ${posixHome(REAL_USER)}/work 与 token ${secret}\n`,
  });

  const result = runGate(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/notes\.md:1:home-path/);
  assert.match(result.stderr, /docs\/notes\.md:1:token/);
  // 不能把用户名或令牌回显到日志里。
  assert.doesNotMatch(result.stderr, new RegExp(REAL_USER));
  assert.doesNotMatch(result.stderr, new RegExp(secret));
  assert.match(result.stderr, /具体值已省略/);
});

test("端到端：只有豁免文件时退出码 0", () => {
  const root = makeRepo({
    "package-lock.json": JSON.stringify({ token: body("ghp_", 36) }),
    "app.min.js": "var k='" + body("sk-", 40) + "';\n",
    "assets/data.txt": `owner ${REAL_EMAIL}\n`,
  });

  const result = runGate(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK/);
});

// 修复覆盖：闸门曾读工作树内容，导致 HEAD/索引里的泄漏被干净的 worktree 掩盖。

test("端到端：HEAD 有秘密、工作树改干净仍然退出 1", () => {
  const secret = body("ghp_", 36);
  const root = makeRepo({ "notes.md": `token ${secret}\n` });
  commit(root, "add secret");
  // 工作树覆盖为干净内容，且不暂存：索引和 HEAD 仍有秘密。
  writeFileSync(join(root, "notes.md"), "clean\n");

  const result = runGate(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /notes\.md:1:token/);
  assert.doesNotMatch(result.stderr, new RegExp(secret));
});

test("端到端：秘密只在索引里（HEAD 与工作树干净）仍然退出 1", () => {
  const secret = body("ghp_", 36);
  const root = makeRepo({ "notes.md": "clean\n" });
  commit(root, "init");
  writeFileSync(join(root, "notes.md"), `token ${secret}\n`);
  execFileSync("git", ["add", "notes.md"], { cwd: root });
  // 暂存后再把工作树改干净：下一次提交仍会带上索引里的秘密。
  writeFileSync(join(root, "notes.md"), "clean\n");

  const result = runGate(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /notes\.md:1:token/);
});

test("端到端：push 范围内加过又删掉的秘密会被拦下", () => {
  const secret = body("ghp_", 36);
  const root = makeRepo({ "a.md": "init\n" });
  const base = commit(root, "init");
  writeFileSync(join(root, "leak.md"), `token ${secret}\n`);
  git(root, ["add", "leak.md"]);
  commit(root, "add leak");
  git(root, ["rm", "-q", "leak.md"]);
  const head = commit(root, "remove leak");

  // 没有 refs 信息时只扫索引 + HEAD，看不到中间提交。
  assert.equal(runGate(root).status, 0);

  const withRange = runGate(root, {
    ZCODE_PRE_PUSH_STDIN: `refs/heads/dev ${head} refs/heads/dev ${base}`,
  });
  assert.equal(withRange.status, 1);
  assert.match(withRange.stderr, /leak\.md:1:token/);
  assert.doesNotMatch(withRange.stderr, new RegExp(secret));
});

test("端到端：HEAD 里有、现已删除的跟踪文件不导致崩溃", () => {
  const root = makeRepo({ "keep.md": "clean\n", "gone.md": "clean\n" });
  commit(root, "init");
  git(root, ["rm", "-q", "gone.md"]);

  const result = runGate(root);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /ENOENT|fatal/);
  assert.match(result.stdout, /OK/);
});

// 以下覆盖 ALLOWLISTED_FINDINGS：每条只放行绑定的路径/值/行标记，
// 不能顺带吞掉同一文件或同一行里的真实泄漏。

test("allowlist：Prisma 示例邮箱只在列出的精确文件里被抑制", () => {
  const listed = makeRepo({
    [prismaDocFile]: `示例 email: '${prismaExampleEmail}'\n`,
    [`${prismaDocDir}references/transactions.md`]: `示例 email: '${prismaExampleEmail}'\n`,
  });
  assert.equal(runGate(listed).status, 0);

  // 同目录但不在精确文件列表里：目录前缀不再整体豁免。
  const unlisted = makeRepo({
    [prismaUnlistedFile]: `示例 email: '${prismaExampleEmail}'\n`,
  });
  const unlistedResult = runGate(unlisted);
  assert.equal(unlistedResult.status, 1);
  assert.match(unlistedResult.stderr, /constructor\.md:1:email/);
});

test("allowlist：Prisma 文件里的其它邮箱仍然报出", () => {
  const root = makeRepo({
    [prismaDocFile]: `作者 ${REAL_EMAIL}\n`,
  });

  const result = runGate(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /prisma-client-api\/SKILL\.md:1:email/);
  assert.doesNotMatch(result.stderr, new RegExp(REAL_EMAIL));
});

test("allowlist：同一行「已放行 + 真实」邮箱整体报出", () => {
  const root = makeRepo({
    [prismaDocFile]: `示例 ${prismaExampleEmail} 与作者 ${REAL_EMAIL}\n`,
  });

  const result = runGate(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /prisma-client-api\/SKILL\.md:1:email/);
  assert.doesNotMatch(result.stderr, new RegExp(REAL_EMAIL));
});

test("allowlist：PEM 仅在与夹具完全一致的整行放行", () => {
  const exact = makeRepo({ [yandexFixturePath]: `${syntheticPemLine}\n` });
  const exactResult = runGate(exact);
  assert.equal(exactResult.status, 0, exactResult.stderr);
  assert.match(exactResult.stdout, /OK/);

  // 同样带 TEST-NOT-A-REAL-KEY 标记，但正文是任意 base64：必须报出。
  const tampered = makeRepo({
    [yandexFixturePath]: `  "private_key": "${pemBegin}\\n${arbitraryPemBody}\\nTEST-NOT-A-REAL-KEY\\n${pemEnd}\\n"\n`,
  });
  const tamperedResult = runGate(tampered);
  assert.equal(tamperedResult.status, 1);
  assert.match(tamperedResult.stderr, /test_iam_tmpdir_cleanup\.sh:1:token/);
});

test("allowlist：去掉合成标记后同一 PEM 头重新命中", () => {
  const root = makeRepo({
    [yandexFixturePath]: `  "private_key": "${pemBegin}\\n${pemEnd}\\n"\n`,
  });

  const result = runGate(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /test_iam_tmpdir_cleanup\.sh:1:token/);
});

// superpowers-plugin 曾被整个目录前缀豁免（55 个文件）。现在只放行清单里那一个
// 上游作者邮箱；目录里任何其它邮箱仍必须报出。
test("allowlist：vendored 插件清单的上游作者邮箱被抑制", () => {
  const root = makeRepo({
    [superpowersPluginJson]: `{\n  "author": {\n    "email": "${superpowersPluginEmail}"\n  }\n}\n`,
  });

  const result = runGate(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK/);
});

test("allowlist：插件目录里的其它邮箱仍然报出", () => {
  const root = makeRepo({
    [`${superpowersPluginDir}skills/example/SKILL.md`]: `作者 ${REAL_EMAIL}\n`,
  });

  const result = runGate(root);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /superpowers-plugin\/skills\/example\/SKILL\.md:1:email/,
  );
  assert.doesNotMatch(result.stderr, new RegExp(REAL_EMAIL));
});

test("allowlist：插件清单里不带 email 字段的行不放行", () => {
  const root = makeRepo({
    [superpowersPluginJson]: `{\n  "homepage": "${superpowersPluginEmail}"\n}\n`,
  });

  const result = runGate(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /plugin\.json:2:email/);
  assert.doesNotMatch(result.stderr, new RegExp(superpowersPluginEmail));
});

// 回归：`rev-list --objects` 不支持 -z，旧解析器期待 `path=` 字段，导致
// push 范围实际没有被扫描（added 恒为 0）却报 0。以下覆盖解析器与真实范围行为。

test("rev-list 解析：按首个空格切分，保留含空格的路径", () => {
  const sha = "a".repeat(40);
  const other = "b".repeat(40);
  const parsed = parseRevListObjects(
    [
      `${sha}`,
      `${sha} docs/some file with spaces.md`,
      `${other} src/index.ts`,
      "",
    ].join("\n"),
  );
  assert.deepEqual(parsed, [
    { sha, file: "docs/some file with spaces.md" },
    { sha: other, file: "src/index.ts" },
  ]);
});

test("rev-list 解析：空输出与纯提交对象不产生条目", () => {
  assert.deepEqual(parseRevListObjects(""), []);
  assert.deepEqual(
    parseRevListObjects(`${"c".repeat(40)}\n${"d".repeat(40)}\n`),
    [],
  );
});

test("端到端：push 范围内路径含空格的泄漏也被拦下", () => {
  const secret = body("ghp_", 36);
  const leaked = "docs/with space/notes.md";
  const root = makeRepo({ "a.md": "init\n" });
  const base = commit(root, "init");
  mkdirSync(dirname(join(root, leaked)), { recursive: true });
  writeFileSync(join(root, leaked), `token ${secret}\n`);
  git(root, ["add", leaked]);
  commit(root, "add leak in spaced path");
  git(root, ["rm", "-q", leaked]);
  const head = commit(root, "remove leak");

  const withRange = runGate(root, {
    ZCODE_PRE_PUSH_STDIN: `refs/heads/dev ${head} refs/heads/dev ${base}`,
  });
  assert.equal(withRange.status, 1);
  assert.match(withRange.stderr, /with space\/notes\.md:1:token/);
  assert.doesNotMatch(withRange.stderr, new RegExp(secret));
});

test("端到端：范围含多个提交时任一历史 blob 的泄漏都被拦下", () => {
  const first = body("ghp_", 36);
  const second = body("sk-", 40);
  const root = makeRepo({ "a.md": "init\n" });
  const base = commit(root, "init");
  writeFileSync(join(root, "one.md"), `token ${first}\n`);
  git(root, ["add", "one.md"]);
  commit(root, "leak one");
  git(root, ["rm", "-q", "one.md"]);
  writeFileSync(join(root, "two.md"), `key ${second}\n`);
  git(root, ["add", "two.md"]);
  commit(root, "leak two");
  git(root, ["rm", "-q", "two.md"]);
  const head = commit(root, "remove both");

  const withRange = runGate(root, {
    ZCODE_PRE_PUSH_STDIN: `refs/heads/dev ${head} refs/heads/dev ${base}`,
  });
  assert.equal(withRange.status, 1);
  assert.match(withRange.stderr, /one\.md:1:token/);
  assert.match(withRange.stderr, /two\.md:1:token/);
});

test("端到端：范围内没有变化时不误报，也不打印「没有文件变化」", () => {
  const root = makeRepo({ "a.md": "init\n" });
  const head = commit(root, "init");

  const same = runGate(root, {
    ZCODE_PRE_PUSH_STDIN: `refs/heads/dev ${head} refs/heads/dev ${head}`,
  });
  assert.equal(same.status, 0, same.stderr);
  assert.match(same.stdout, /OK/);
  assert.doesNotMatch(same.stderr, /没有文件变化/);
});

// 净化历史基线：只抑制「已修好在 HEAD 的历史 blob」，且必须三键同时匹配。

/** 造一个仓库：旧提交里泄漏、HEAD 里已修好，返回 base/oldHead/head 与 blob。 */
function makeSanitizedRepo() {
  const secret = body("ghp_", 36);
  const root = makeRepo({ "docs/report.md": "clean\n" });
  const base = commit(root, "init");
  writeFileSync(join(root, "docs/report.md"), `token ${secret}\n`);
  git(root, ["add", "docs/report.md"]);
  const leakedCommit = commit(root, "add leak");
  const leakedBlob = blobAt(root, leakedCommit, "docs/report.md");
  writeFileSync(join(root, "docs/report.md"), "clean\n");
  git(root, ["add", "docs/report.md"]);
  const fixedCommit = commit(root, "sanitize");
  return { root, base, leakedCommit, leakedBlob, fixedCommit, secret };
}

test("baseline：精确命中历史 blob 时抑制并打印说明", () => {
  const { root, base, leakedBlob, fixedCommit } = makeSanitizedRepo();
  writeSanitizedHistory(root, [
    {
      path: "docs/report.md",
      blobSha: leakedBlob,
      findingTypes: ["token"],
      count: 1,
      sanitizedInCommit: fixedCommit,
      reason: "тест",
    },
  ]);

  const head = git(root, ["rev-parse", "HEAD"]);
  const result = runGate(root, {
    ZCODE_PRE_PUSH_STDIN: `refs/heads/dev ${head} refs/heads/dev ${base}`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /已净化历史：docs\/report\.md @ [0-9a-f]{12}/);
  assert.match(result.stdout, /修复于/);
});

test("baseline：blobSha 不匹配（同路径不同 blob）时仍然阻止", () => {
  const { root, base, fixedCommit } = makeSanitizedRepo();
  writeSanitizedHistory(root, [
    {
      path: "docs/report.md",
      blobSha: "f".repeat(40),
      findingTypes: ["token"],
      count: 1,
      sanitizedInCommit: fixedCommit,
      reason: "тест",
    },
  ]);

  const head = git(root, ["rev-parse", "HEAD"]);
  const result = runGate(root, {
    ZCODE_PRE_PUSH_STDIN: `refs/heads/dev ${head} refs/heads/dev ${base}`,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/report\.md:1:token/);
});

test("baseline：findingTypes 不含该类型时不抑制", () => {
  const { root, base, leakedBlob, fixedCommit } = makeSanitizedRepo();
  writeSanitizedHistory(root, [
    {
      path: "docs/report.md",
      blobSha: leakedBlob,
      findingTypes: ["home-path"],
      count: 1,
      sanitizedInCommit: fixedCommit,
      reason: "тест",
    },
  ]);

  const head = git(root, ["rev-parse", "HEAD"]);
  const result = runGate(root, {
    ZCODE_PRE_PUSH_STDIN: `refs/heads/dev ${head} refs/heads/dev ${base}`,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/report\.md:1:token/);
});

test("baseline：索引与 HEAD 的同类命中永不被抑制", () => {
  // 关键场景：HEAD 里再次出现同类泄漏，且内容 blob 与历史登记的一致。
  // 抑制只对「仅历史」的 blob 生效，HEAD/索引里的同一 blob 必须照报。
  const secret = body("ghp_", 36);
  const root = makeRepo({ "docs/report.md": "clean\n" });
  const base = commit(root, "init");
  writeFileSync(join(root, "docs/report.md"), `token ${secret}\n`);
  git(root, ["add", "docs/report.md"]);
  const leakedCommit = commit(root, "leak");
  const leakedBlob = blobAt(root, leakedCommit, "docs/report.md");
  writeFileSync(join(root, "docs/report.md"), "clean\n");
  git(root, ["add", "docs/report.md"]);
  const fixedCommit = commit(root, "sanitize");
  // 再次引入同一内容：blob 与历史登记值完全相同，位于 HEAD 与索引里。
  writeFileSync(join(root, "docs/report.md"), `token ${secret}\n`);
  git(root, ["add", "docs/report.md"]);
  const headCommit = commit(root, "re-leak");

  writeSanitizedHistory(root, [
    {
      path: "docs/report.md",
      blobSha: leakedBlob,
      findingTypes: ["token"],
      count: 1,
      sanitizedInCommit: fixedCommit,
      reason: "тест",
    },
  ]);

  const withRange = runGate(root, {
    ZCODE_PRE_PUSH_STDIN: `refs/heads/dev ${headCommit} refs/heads/dev ${base}`,
  });
  assert.equal(withRange.status, 1);
  assert.match(withRange.stderr, /docs\/report\.md:1:token/);
  // 同一个 blob 也出现在 HEAD/索引里，因此不应出现任何抑制行。
  assert.doesNotMatch(withRange.stdout, /已净化历史/);
  assert.doesNotMatch(withRange.stderr, new RegExp(secret));
});

test("baseline：sanitizedInCommit 为空时配置无效并阻止 push", () => {
  const { root, base, leakedBlob } = makeSanitizedRepo();
  writeSanitizedHistory(root, [
    {
      path: "docs/report.md",
      blobSha: leakedBlob,
      findingTypes: ["token"],
      count: 1,
      reason: "нет commit",
    },
  ]);

  const head = git(root, ["rev-parse", "HEAD"]);
  const result = runGate(root, {
    ZCODE_PRE_PUSH_STDIN: `refs/heads/dev ${head} refs/heads/dev ${base}`,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /配合无效|配置无效/);
  assert.match(result.stderr, /sanitizedInCommit/);
});

test("baseline：修复提交里仍有同类命中时配置无效（防漏网）", () => {
  const { root, base, leakedCommit, leakedBlob } = makeSanitizedRepo();
  // 声称已在泄漏提交里修好 —— 该提交的树里当然还有命中。
  writeSanitizedHistory(root, [
    {
      path: "docs/report.md",
      blobSha: leakedBlob,
      findingTypes: ["token"],
      count: 1,
      sanitizedInCommit: leakedCommit,
      reason: "ложное утверждение",
    },
  ]);

  const head = git(root, ["rev-parse", "HEAD"]);
  const result = runGate(root, {
    ZCODE_PRE_PUSH_STDIN: `refs/heads/dev ${head} refs/heads/dev ${base}`,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /配置无效/);
  assert.match(result.stderr, /仍有 token 命中/);
});

test("baseline：sanitizedInCommit 不是 HEAD 祖先时配置无效", () => {
  const { root, base, leakedBlob } = makeSanitizedRepo();
  // 造一个不在当前分支上的提交。
  git(root, ["checkout", "-q", "-b", "side"]);
  writeFileSync(join(root, "docs/other.md"), "clean\n");
  git(root, ["add", "docs/other.md"]);
  const sideCommit = commit(root, "side commit");
  git(root, ["checkout", "-q", "master"]);

  writeSanitizedHistory(root, [
    {
      path: "docs/report.md",
      blobSha: leakedBlob,
      findingTypes: ["token"],
      count: 1,
      sanitizedInCommit: sideCommit,
      reason: "чужой коммит",
    },
  ]);

  const head = git(root, ["rev-parse", "HEAD"]);
  const result = runGate(root, {
    ZCODE_PRE_PUSH_STDIN: `refs/heads/dev ${head} refs/heads/dev ${base}`,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /配置无效/);
  assert.match(result.stderr, /不是 HEAD 的祖先/);
});

test("baseline：归还历史后（未推送）不误判失效，只是不抑制", () => {
  const { root, leakedBlob, fixedCommit } = makeSanitizedRepo();
  writeSanitizedHistory(root, [
    {
      path: "docs/report.md",
      blobSha: leakedBlob,
      findingTypes: ["token"],
      count: 1,
      sanitizedInCommit: fixedCommit,
      reason: "тест",
    },
  ]);

  // 没有 pre-push refs：不扫历史，登记条目不应被当成失效。
  const result = runGate(root);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /基线失效/);
});
