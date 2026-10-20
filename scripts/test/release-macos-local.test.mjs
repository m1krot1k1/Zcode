import assert from "node:assert/strict";
import test from "node:test";
import { bumpSemver } from "../release-macos-local.mjs";

test("major и minor сбрасывают младшие разряды", () => {
  assert.equal(bumpSemver("3.16.2", "patch"), "3.16.3");
  assert.equal(bumpSemver("3.16.2", "minor"), "3.17.0");
  assert.equal(bumpSemver("3.16.2", "major"), "4.0.0");
});

test("неизвестный уровень не молча становится patch", () => {
  assert.throws(() => bumpSemver("3.16.2", "beta"), /major, minor или patch/);
});
