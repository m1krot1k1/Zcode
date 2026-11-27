import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { BUNDLED_SOURCE_SERVER_TARGETS } from "./bundled-remote-assets-targets.mjs";

/**
 * 校验随包 Source Server release（resources/remote-assets/releases）。
 *
 * Bug 原因：3.17.205 的安装包是直接调 electron-builder 得到的，跳过了
 * prepare-bundled-remote-assets.mjs，于是 resources/remote-assets 里还留着上一版
 * 的 release 目录。产物一切正常 —— 体积对、能启动，只有远端连接会死：
 * sourceServerReleaseResolver 按 ZCODE_VERSION 找 releases/<version>，命中 null 后抛
 * "Source Server release <version> is not bundled with this app"（CDN 回退是故意关掉的）。
 * 也就是说装上新版反而连不上任何 SSH/WSL workspace。
 *
 * 这个门禁放在 electron-builder 之后、产物交付之前，按字节而不是按时间戳判断：
 * 版本目录必须唯一且等于应用版本，descriptor 的版本/目标/大小都要与实际归档对上，
 * 源码版本标记还必须等于本次构建的 HEAD，否则说明 release 是从别的提交生成的。
 */
export function verifyPackagedRemoteAssets({
  resourcesDir,
  expectedVersion,
  expectedRevision = null,
  targets = BUNDLED_SOURCE_SERVER_TARGETS,
}) {
  const releasesDir = resolve(resourcesDir, "remote-assets", "releases");
  if (!existsSync(releasesDir)) {
    throw new Error(`打包产物缺少随包 Source Server release 目录: ${releasesDir}`);
  }

  const bundledVersions = readdirSync(releasesDir).filter((entry) =>
    statSync(resolve(releasesDir, entry)).isDirectory(),
  );
  const releaseDir = resolve(releasesDir, expectedVersion);
  if (!existsSync(releaseDir)) {
    throw new Error(
      `打包产物缺少随包 Source Server release ${expectedVersion}，实际为: [${bundledVersions.join(", ")}]`,
    );
  }
  if (bundledVersions.length !== 1) {
    // 旧版本目录必须被 prepare 脚本整棵树替换掉；残留会让人以为回滚路径还在。
    throw new Error(
      `打包产物随包 Source Server release 目录杂糅: [${bundledVersions.join(", ")}]；只应存在 ${expectedVersion}`,
    );
  }

  if (expectedRevision) {
    const revisionPath = resolve(releaseDir, "source-revision.txt");
    const recorded = existsSync(revisionPath) ? readFileSync(revisionPath, "utf8").trim() : "";
    if (recorded !== expectedRevision) {
      throw new Error(
        `随包 Source Server release 的源码版本不符: recorded=${recorded || "<missing>"} expected=${expectedRevision}`,
      );
    }
  }

  const descriptorPath = resolve(releaseDir, "source-server-release.json");
  if (!existsSync(descriptorPath)) {
    throw new Error(`随包 Source Server release 缺少 descriptor: ${descriptorPath}`);
  }
  const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
  if (descriptor.version !== expectedVersion) {
    throw new Error(
      `随包 Source Server descriptor 版本不符: expected=${expectedVersion} received=${descriptor.version}`,
    );
  }

  for (const target of targets) {
    const archive = (descriptor.archives ?? []).find((entry) => entry.target === target);
    if (!archive) {
      throw new Error(`随包 Source Server descriptor 缺少目标: ${target}`);
    }
    const archivePath = resolve(releaseDir, archive.fileName);
    if (!existsSync(archivePath)) {
      throw new Error(`随包 Source Server 归档缺失: ${archivePath}`);
    }
    const sizeBytes = statSync(archivePath).size;
    if (sizeBytes !== archive.sizeBytes) {
      throw new Error(
        `随包 Source Server 归档大小不符: ${archive.fileName} actual=${sizeBytes} expected=${archive.sizeBytes}`,
      );
    }
  }

  return { version: expectedVersion, targets: [...targets], releaseDir };
}
