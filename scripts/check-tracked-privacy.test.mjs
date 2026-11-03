#!/usr/bin/env node
// check-tracked-privacy 的回归测试：单元覆盖三类特征与豁免规则，端到端覆盖
// 退出码以及「输出不得回显命中值」这条硬约束。

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import { isAllowedEmail, isExcluded, scanLine } from "./check-tracked-privacy.mjs";

const SCRIPT = fileURLToPath(new URL("./check-tracked-privacy.mjs", import.meta.url));

function makeRepo(files) {
  const root = mkdtempSync(join(tmpdir(), "tracked-privacy-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
}

function runGate(root) {
  return spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8" });
}

/** 拼一个长度为 length 的占位令牌主体，避免在测试文件里写出真实形态的密钥。 */
const body = (prefix, length) => prefix + "a".repeat(length);

// 测试文件本身也在闸门扫描范围内，所以「应当报出」的样本必须在运行时拼装：
// 写字面量会让这个文件变成泄漏样本，反过来又要给自己开豁免。
const REAL_USER = "iv" + "an";
const REAL_EMAIL = ["ivan", "petrov"].join(".") + "@corp.ru";

test("home 路径：三种平台都识别，合成用户名不报", () => {
  assert.deepEqual(scanLine(`cwd=/Users/${REAL_USER}/projects/zcode`), ["home-path"]);
  assert.deepEqual(scanLine(`cwd=/home/${REAL_USER}/work`), ["home-path"]);
  assert.deepEqual(scanLine(`path=C:\\Users\\${REAL_USER}\\work`), ["home-path"]);
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
  assert.deepEqual(scanLine("AKIAIOSFODNN7EXAMPLE"), ["token"]);
  assert.deepEqual(scanLine("-----BEGIN RSA PRIVATE KEY-----"), ["token"]);
  assert.deepEqual(scanLine(`short=${body("ghp_", 8)}`), []);
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
    "docs/notes.md": `本机路径 /Users/${REAL_USER}/work 与 token ${secret}\n`,
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
    "app.min.js": "var k='sk-" + "a".repeat(40) + "';\n",
    "assets/data.txt": `owner ${REAL_EMAIL}\n`,
  });

  const result = runGate(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK/);
});
