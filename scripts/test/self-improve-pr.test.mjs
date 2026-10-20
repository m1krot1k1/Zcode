import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSelfImprovePlan,
  readTokenFromEnvFile,
  resolveGithubToken,
} from "../self-improve-pr.mjs";

test("токен из окружения важнее файла", () => {
  assert.equal(
    resolveGithubToken({
      env: { GITHUB_TOKEN: "from-env" },
      envFileText: "GITHUB_TOKEN=from-file\n",
    }),
    "from-env",
  );
});

test("пустой токен читается из строки файла и не берёт комментарий", () => {
  assert.equal(
    readTokenFromEnvFile("# GITHUB_TOKEN=secret\nGITHUB_TOKEN='repo-token'\n"),
    "repo-token",
  );
  assert.equal(resolveGithubToken({ env: {}, envFileText: "" }), "");
});

test("план не целится в main", () => {
  const plan = buildSelfImprovePlan({
    branch: "self-improve/2026-10-21",
    base: "dev",
    title: "Самоулучшение",
    body: "review",
  });
  assert.equal(plan.commands[2][4], "dev");
  assert.equal(plan.commands[2][6], "self-improve/2026-10-21");
  assert.throws(
    () =>
      buildSelfImprovePlan({
        branch: "main",
        base: "dev",
        title: "Самоулучшение",
        body: "review",
      }),
    /main/,
  );
});
