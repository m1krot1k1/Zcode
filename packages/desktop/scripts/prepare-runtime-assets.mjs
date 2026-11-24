#!/usr/bin/env node

import process from "node:process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNativeSearchReleasePlan } from "../../../scripts/native-search-tools-config.mjs";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { getTargetPlatform } from "./target-platform.mjs";
import { isRealComputerUseProducerInstalled } from "./computer-use-producer.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const target = getTargetPlatform();
const nativeSearchReleasePlan = resolveNativeSearchReleasePlan({
  platform: target.os,
  arch: target.arch,
});
// Windows Chrome 导入入口未启用，默认构建继续编译 helper 会增加 CI 时间和发布签名面。
// 保留显式开关，后续恢复入口时仍可复用既有原生实现和供应链校验。
const shouldPrepareWindowsBrowserImportHelper =
  target.os === "win32" && process.env.ZCODE_ENABLE_WINDOWS_BROWSER_IMPORT === "1";
// Windows Computer Use Helper 由真实 producer 提供；开源占位包没有 Helper runtime，跳过准备。
const shouldPrepareWindowsCuaHelper =
  target.os === "win32" && isRealComputerUseProducerInstalled({ desktopPackageRoot: desktopRoot });
// CUA 权限浮窗的吸附数据源。仅 macOS；缺 swiftc 时脚本内部自行降级为跳过（浮窗 fail-open
// 到屏幕底部，仍可用），所以无条件挂在 darwin 上不会让构建变脆。
const shouldPrepareMacosWindowBounds = target.os === "darwin";
// 本地听写由随包发布的 Hex 引擎提供，缺失时应用只能报告“语音输入不可用”。
// ZCODE_ENABLE_VOICE_DICTATION=1 要求构建为当前目标产出引擎，产出不了就让构建失败；
// 未设置时复用已存在的引擎，没有引擎则在日志里显式警告，避免发布包悄悄丢掉该能力。
const voiceDictationRequested = process.env.ZCODE_ENABLE_VOICE_DICTATION === "1";
const voiceDictationDisabled = process.env.ZCODE_ENABLE_VOICE_DICTATION === "0";
const voiceEngineBinary = target.os === "win32" ? "hex-service.exe" : "hex-service";
const voiceEnginePath = resolve(
  desktopRoot,
  `bundled-voice/${target.key}/${voiceEngineBinary}`,
);
const shouldPrepareVoiceDictation =
  voiceDictationRequested || (!voiceDictationDisabled && existsSync(voiceEnginePath));

// 本机桌面包不再内置 glm 原生二进制（prepare:glm），改为内置 agent 的 JS bundle（prepare:agent-bundle），
// 运行时由 app 的 Electron Node runtime 执行。Source Server 资源由独立 stage:remote-assets 入口负责。
const localRuntimeScripts = [
  "prepare:agent-bundle",
  ...(shouldPrepareWindowsCuaHelper ? ["prepare:windows-cua-helper"] : []),
  ...(nativeSearchReleasePlan.enabled ? ["prepare:native-search"] : []),
  ...(shouldPrepareWindowsBrowserImportHelper ? ["prepare:browser-import-helper"] : []),
  ...(shouldPrepareMacosWindowBounds ? ["prepare:macos-window-bounds"] : []),
  ...(shouldPrepareVoiceDictation ? ["prepare:hex-service"] : []),
];

function runTimedPnpmScript(scriptName) {
  const startMs = Date.now();
  console.log(`[ci][timer] prepare-runtime-assets:${scriptName} start`);
  try {
    runCommand(pnpmCommand, [scriptName], {
      cwd: desktopRoot,
      env: process.env,
    });
  } finally {
    console.log(
      `[ci][timer] prepare-runtime-assets:${scriptName} end duration_ms=${Date.now() - startMs}`,
    );
  }
}

for (const scriptName of localRuntimeScripts) {
  runTimedPnpmScript(scriptName);
}

if (voiceDictationRequested && !existsSync(voiceEnginePath)) {
  throw new Error(
    `voice dictation engine missing for ${target.key}: ${voiceEnginePath}. ` +
      "Build it with `pnpm --filter @zcode/desktop prepare:hex-service` " +
      "or point ZCODE_HEX_SERVICE_BINARY at a prebuilt engine.",
  );
}
if (!voiceDictationRequested && !voiceDictationDisabled && !existsSync(voiceEnginePath)) {
  console.warn(
    `[prepare-runtime-assets] no Hex voice engine for ${target.key}; ` +
      "the packaged app reports voice dictation as unavailable",
  );
}
