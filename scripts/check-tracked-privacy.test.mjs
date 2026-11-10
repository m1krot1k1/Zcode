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

import { isExcluded, scanLine } from "./check-tracked-privacy.mjs";

const SCRIPT = fileURLToPath(new URL("./check-tracked-privacy.mjs", import.meta.url));

function makeRepo(files) {
  const root = mkdtempSync(join(tmpdir(), "tracked-privacy-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
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
const yandexFixturePath = ".agents/skills/yandex-wordstat/scripts/tests/test_iam_tmpdir_cleanup.sh";
// 与 allowlist 条目完全一致的 PEM 头/尾（非 RSA），用于验证整行精确匹配。
const pemBegin = "-----BEGIN " + "PRIVATE KEY-----";
const pemEnd = "-----END " + "PRIVATE KEY-----";
const syntheticPemLine =
  '  "private_key": "' + pemBegin + "\\nTEST-NOT-A-REAL-KEY\\n" + pemEnd + '\\n"';
// 任意 base64 正文：只用于证明「有标记不等于可放行」。
const arbitraryPemBody = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC";
// vendored Superpowers 插件清单的上游作者邮箱；目录不再整体豁免，只放行这一值。
const superpowersPluginJson =
  "apps/zcode-cli/packages/superpowers-plugin/.zcode-plugin/plugin.json";
const superpowersPluginDir = "apps/zcode-cli/packages/superpowers-plugin/";
const superpowersPluginEmail = ["jesse", "fsck.com"].join("@");

test("home 路径：三种平台都识别，合成用户名不报", () => {
  assert.deepEqual(scanLine(`cwd=${posixHome(REAL_USER)}/projects/zcode`), ["home-path"]);
  assert.deepEqual(scanLine(`cwd=${linuxHome(REAL_USER)}/work`), ["home-path"]);
  assert.deepEqual(scanLine(`path=${windowsHome(REAL_USER)}\\work`), ["home-path"]);
  assert.deepEqual(scanLine("示例 /Users/alice/project 与 /home/dev/app"), []);
});

test("邮箱：allowlist 放行，真实个人邮箱报出", () => {
  assert.deepEqual(scanLine("联系人 12345+dev@users.noreply.github.com"), []);
  assert.deepEqual(scanLine("示例 mailto:someone@example.com"), []);
  assert.deepEqual(scanLine(`作者 ${REAL_EMAIL} 提交`), ["email"]);
  // URL 里的 user:pass@host 是凭据语法，不是邮箱。
  assert.deepEqual(scanLine("clone https://user:secret@github.com/o/r.git"), []);
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
  assert.match(result.stderr, /superpowers-plugin\/skills\/example\/SKILL\.md:1:email/);
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
