#!/usr/bin/env node
// check-doc-links 的回归测试：单元覆盖链接提取与目标过滤，端到端覆盖退出码/
// 输出格式，以及「相对路径按文件所在目录解析」这条最容易写错的规则。

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import { extractLinks, inScope, toRelativePath } from "./check-doc-links.mjs";

const SCRIPT = fileURLToPath(new URL("./check-doc-links.mjs", import.meta.url));

/** 建一个只含所需文件的临时 git 仓库，让脚本以仓库根目录为 cwd 运行。 */
function makeRepo(files) {
  const root = mkdtempSync(join(tmpdir(), "doc-links-"));
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

test("extractLinks 跳过围栏代码块与行内代码，保留行号", () => {
  const source = [
    "# 标题",
    "[真实](real.md)",
    "```",
    "[示例](fenced-missing.md)",
    "```",
    "行内 `[示例](inline-missing.md)` 不算链接",
  ].join("\n");

  assert.deepEqual(extractLinks(source), [{ line: 2, target: "real.md" }]);
});

test("toRelativePath 过滤外部链接、纯锚点与占位符，并去掉锚点/查询串", () => {
  assert.equal(toRelativePath("https://example.com/a.md"), null);
  assert.equal(toRelativePath("http://example.com/a.md"), null);
  assert.equal(toRelativePath("mailto:dev@example.com"), null);
  assert.equal(toRelativePath("#section"), null);
  assert.equal(toRelativePath("/absolute/path.md"), null);
  assert.equal(toRelativePath("{{template}}.md"), null);
  assert.equal(toRelativePath("guide/page.md#L10"), "guide/page.md");
  assert.equal(toRelativePath("guide/page.md?plain=1"), "guide/page.md");
});

test("inScope 只收根目录与 docs/ 下的 Markdown，跳过上游镜像", () => {
  assert.equal(inScope("README.md"), true);
  assert.equal(inScope("docs/a/b.md"), true);
  assert.equal(inScope("docs/electron/api.md"), false);
  assert.equal(inScope("packages/desktop/README.md"), false);
});

test("存在失效链接时退出码为 1，并按 文件:行 -> 目标 输出", () => {
  const root = makeRepo({
    "docs/guide/ok.md": "[有效](intro.md)\n",
    "docs/guide/intro.md": "# intro\n",
    "docs/guide/broken.md": "第一行\n[失效](../missing/page.md)\n",
  });

  const result = runGate(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/guide\/broken\.md:2 -> \.\.\/missing\/page\.md/);
  assert.doesNotMatch(result.stderr, /intro\.md/);
});

test("全部有效时退出码为 0：锚点、外部链接与代码块都不算失效", () => {
  const root = makeRepo({
    "docs/page.md": [
      "[内部](./sub/child.md#part)",
      "[外部](https://example.com/x.md)",
      // docs/page.md 到仓库根 README 只差一级；写成 ../../ 会跳出仓库，
      // 那属于测试夹具错误而非闸门误报。
      "[仓库内](../README.md)",
      "```md",
      "[示例](./nope.md)",
      "```",
      "",
    ].join("\n"),
    "docs/sub/child.md": "# child\n",
    "README.md": "# root\n",
  });

  const result = runGate(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK/);
});

test("相对路径从文件所在目录解析，而不是仓库根目录", () => {
  const root = makeRepo({
    // 只有 docs/shared.md 存在；若从仓库根解析成 shared.md 就会误报。
    "docs/a/deep.md": "[上两级](../../docs/shared.md)\n[同级](../shared.md)\n",
    "docs/shared.md": "# shared\n",
  });

  const result = runGate(root);
  assert.equal(result.status, 0, result.stderr);
});
