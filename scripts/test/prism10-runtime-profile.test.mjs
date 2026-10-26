import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildPrismRuntimeProfile } from "../prism10-runtime-profile.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("PRISM runtime profile derives from the checksum-verified all source", async () => {
  const artifact = await buildPrismRuntimeProfile();
  const official = await readFile(
    path.join(repositoryRoot, "docs/vendor/prism10/generated/all.md"),
    "utf8",
  );

  assert.equal(artifact.checkedSourcePaths.length, 26);
  assert.equal(artifact.compiledProfile, official);
  assert.equal(createHash("sha256").update(artifact.prompt).digest("hex"), artifact.profileDigest);
  assert.match(artifact.prompt, /## 5\. Контур проверки поколения/u);
  assert.match(artifact.prompt, /Proof-Carrying Upgrade/u);
  assert.match(artifact.prompt, /EXPERIMENTAL RECURSIVE DISCOVERY MODULE \(v10\)/u);
  assert.match(artifact.prompt, /не запускает LLM/u);
  assert.match(artifact.prompt, /node scripts\/prism10-experiment-gate\.mjs/u);
  assert.match(artifact.prompt, /не проверяет подлинность receipts/u);
  assert.doesNotMatch(artifact.prompt, /PRISM ∞ 10\.0 активирован\./u);
  assert.doesNotMatch(artifact.prompt, /python scripts\/experiment_gate\.py/u);
  assert.doesNotMatch(artifact.prompt, /не проверяй и не применяй патчи ZCode/u);
  assert.doesNotMatch(artifact.prompt, /\/Users\/ndppd\//u);
});

test("identity.ts is the current generated PRISM runtime artifact", async () => {
  const artifact = await buildPrismRuntimeProfile();
  const identity = await readFile(
    path.join(repositoryRoot, "apps/zcode-cli/packages/core/src/context/sections/identity.ts"),
    "utf8",
  );

  assert.equal(identity, artifact.identitySource);
  assert.ok(identity.includes(`// PRISM_SOURCE_SHA256: ${artifact.sourceDigest}`));
  assert.ok(identity.includes(`// PRISM_PROFILE_SHA256: ${artifact.profileDigest}`));
});

test("Git checks out the generated identity source with LF even when autocrlf is enabled", () => {
  const eol = execFileSync(
    "git",
    [
      "-c",
      "core.autocrlf=true",
      "check-attr",
      "eol",
      "--",
      "apps/zcode-cli/packages/core/src/context/sections/identity.ts",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  ).trim();

  assert.match(eol, /: eol: lf$/u);
});
