import assert from "node:assert/strict";
import test from "node:test";
import {
  bumpSemver,
  macTargetArch,
  replacePackageVersion,
  selectMacReleaseAssets,
} from "../release-macos-local.mjs";

test("major и minor сбрасывают младшие разряды", () => {
  assert.equal(bumpSemver("3.16.2", "patch"), "3.16.3");
  assert.equal(bumpSemver("3.16.2", "minor"), "3.17.0");
  assert.equal(bumpSemver("3.16.2", "major"), "4.0.0");
});

test("неизвестный уровень не молча становится patch", () => {
  assert.throws(() => bumpSemver("3.16.2", "beta"), /major, minor или patch/);
});

test("версия в package.json меняется на месте", () => {
  const source = '{\n  "name": "zcode",\n  "version": "3.16.2",\n  "private": true\n}\n';
  assert.equal(
    replacePackageVersion(source, "3.17.0"),
    '{\n  "name": "zcode",\n  "version": "3.17.0",\n  "private": true\n}\n',
  );
});

test("в релиз попадают только dmg и zip этой версии", () => {
  const selected = selectMacReleaseAssets(
    [
      "ZCode-3.17.0-mac-arm64.dmg",
      "ZCode-3.17.0-mac-arm64.dmg.blockmap",
      "ZCode-3.17.0-mac-arm64.zip",
      "ZCode-3.16.2-mac-arm64.dmg",
      "ZCode-3.17.0-win-arm64.exe",
    ],
    "3.17.0",
  );
  assert.deepEqual(selected, ["ZCode-3.17.0-mac-arm64.dmg", "ZCode-3.17.0-mac-arm64.zip"]);
});

test("архитектура сборки совпадает с машиной", () => {
  assert.equal(macTargetArch("arm64"), "arm64");
  assert.equal(macTargetArch("x64"), "x64");
  assert.throws(() => macTargetArch("ia32"), /не поддерживает/);
});
