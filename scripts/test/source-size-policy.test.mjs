import ts from "typescript";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");

test("800 行为默认阻断阈值，已接纳的大文件仅降级行数诊断", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zcode-size-policy-"));
  try {
    const { config } = ts.parseConfigFileTextToJson(
      ".oxlintrc.json",
      await readFile(join(root, ".oxlintrc.json"), "utf8"),
    );
    // 只验证规则本身；根 runner 排除 CLI，由独立 CLI runner 检查。
    config.ignorePatterns = [];
    const regular = "packages/example/src/new.ts";
    // «Принятый» файл берём из фактического реестра max-lines в .oxlintrc.json:
    // после дробления конкретные пути меняются, а контракт «зарегистрирован →
    // warning вместо error» должен проверяться на текущей конфигурации.
    const maxLinesOverrides = (config.overrides ?? []).filter(
      (override) => (override.rules ?? {})["max-lines"] !== undefined,
    );
    const registered = maxLinesOverrides
      .flatMap((override) => override.files ?? [])
      .filter((file) => !String(file).startsWith("**/") && /\.(ts|tsx)$/u.test(String(file)));
    // Пути из CLI-пакета здесь не годятся: линт запускается из корня пакета,
    // и относительный target не совпадёт с временным деревом.
    const usable = registered.filter((file) => !String(file).startsWith("apps/zcode-cli/"));
    let accepted = usable[0] ?? "packages/example/src/accepted.ts";
    if (!usable.length) {
      config.overrides = [
        ...(config.overrides ?? []),
        {
          files: [accepted],
          rules: { "max-lines": ["warn", { max: 800, skipBlankLines: true, skipComments: true }] },
        },
      ];
    }
    // Конфиг пишем после возможной инъекции override — иначе принятый файл
    // теряет warn-исключение и тест проверяет не тот контракт.
    await writeFile(join(cwd, ".oxlintrc.json"), JSON.stringify(config));
    async function lint(file, lines) {
      await mkdir(dirname(join(cwd, file)), { recursive: true });
      await writeFile(
        join(cwd, file),
        Array.from({ length: lines }, (_, i) => `export const value${i} = ${i};`).join("\n"),
      );
      const packageRoot = file.startsWith("apps/zcode-cli/")
        ? "apps/zcode-cli/packages/bootstrap"
        : ".";
      const target = packageRoot === "." ? file : file.slice(packageRoot.length + 1);
      const result = await exec(
        process.execPath,
        [join(root, "node_modules/oxlint/bin/oxlint"), "--format", "json", target],
        { cwd: join(cwd, packageRoot) },
      ).catch((error) => error);
      return JSON.parse(result.stdout).diagnostics;
    }
    assert.equal(
      (await lint(regular, 800)).filter((x) => x.code === "eslint(max-lines)").length,
      0,
    );
    assert.equal(
      (await lint(regular, 801)).find((x) => x.code === "eslint(max-lines)")?.severity,
      "error",
    );
    assert.equal(
      (await lint(accepted, 801)).find((x) => x.code === "eslint(max-lines)")?.severity,
      "warning",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
