import { normalizeRemoteConnectionError } from "@zcode/shared";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
  ZCODE_VERSION,
  sourceServerReleaseDescriptorSchema,
  type RemoteTarget,
  type SourceServerReleaseArchive,
  type SourceServerReleaseDescriptor,
} from "@zcode/shared";
import type { ServerReleaseAsset, SourceServerProbeResult } from "@zcode/server/source-server";
import type { WindowRemoteAssetDirs } from "./windowRemoteConnectionRegistry.js";

async function pathExists(path: string): Promise<boolean> {
  return await access(path).then(
    () => true,
    () => false,
  );
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyArchive(path: string, archive: SourceServerReleaseArchive): Promise<boolean> {
  const fileStat = await stat(path).catch(() => null);
  if (!fileStat?.isFile() || fileStat.size !== archive.sizeBytes) return false;
  return (await sha256File(path)) === archive.sha256;
}

function readDescriptor(text: string): SourceServerReleaseDescriptor {
  const descriptor = sourceServerReleaseDescriptorSchema.parse(JSON.parse(text));
  if (descriptor.version !== ZCODE_VERSION) {
    throw new Error(
      `Source Server descriptor version mismatch: expected ${ZCODE_VERSION}, received ${descriptor.version}`,
    );
  }
  return descriptor;
}

function findArchive(
  descriptor: SourceServerReleaseDescriptor,
  target: string,
): SourceServerReleaseArchive {
  const archive = descriptor.archives.find((candidate) => candidate.target === target);
  if (!archive) throw new Error(`Source Server descriptor is missing target: ${target}`);
  return archive;
}

async function resolveLocalDescriptor(
  releaseDir: string,
  target: string,
): Promise<{ archive: SourceServerReleaseArchive; archivePath: string } | null> {
  const descriptorPath = join(releaseDir, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME);
  if (!(await pathExists(descriptorPath))) return null;
  const descriptor = readDescriptor(await readFile(descriptorPath, "utf8"));
  const archive = findArchive(descriptor, target);
  const archivePath = join(releaseDir, archive.fileName);
  if (!(await verifyArchive(archivePath, archive))) {
    throw new Error(`Source Server local archive failed descriptor verification: ${archivePath}`);
  }
  return { archive, archivePath };
}

export async function resolveSourceServerReleaseAsset(
  ...args: Parameters<typeof resolveReleaseAsset>
): Promise<ServerReleaseAsset> {
  try {
    return await resolveReleaseAsset(...args);
  } catch (error) {
    const failure = normalizeRemoteConnectionError(error, "download");
    throw Object.assign(error instanceof Error ? error : new Error(failure.message), failure);
  }
}

async function resolveReleaseAsset(
  probe: SourceServerProbeResult,
  remoteAssets: WindowRemoteAssetDirs,
  remoteTarget: Exclude<RemoteTarget, { kind: "server" }>,
): Promise<ServerReleaseAsset> {
  if (
    (probe.platform !== "linux" && probe.platform !== "darwin") ||
    (probe.arch !== "x64" && probe.arch !== "arm64")
  ) {
    throw new Error(`Unsupported Source Server release target: ${probe.platform}-${probe.arch}`);
  }
  const target = `${probe.platform}-${probe.arch}`;

  if (
    remoteTarget.kind === "ssh" &&
    remoteAssets.sourceServerArtifactPolicy === "development-content-addressed"
  ) {
    if (!remoteAssets.mockCdnDir) {
      throw new Error(
        "Development Source Server release is unavailable; run pnpm bootstrap:with-remote",
      );
    }
    const releaseDir = join(remoteAssets.mockCdnDir, "releases", ZCODE_VERSION);
    const local = await resolveLocalDescriptor(releaseDir, target);
    if (!local) {
      // Bug 原因：开发态回退 CDN 会把 bootstrap 失败伪装成连接成功，并继续运行同版本旧代码。
      // 内容寻址开发策略只能消费本轮本地 descriptor/archive，缺失时必须明确失败。
      throw new Error(
        "Development Source Server release descriptor is unavailable; run pnpm bootstrap:with-remote",
      );
    }
    return {
      localArchivePath: local.archivePath,
      target,
      version: ZCODE_VERSION,
      sha256: local.archive.sha256,
      sizeBytes: local.archive.sizeBytes,
      urls: local.archive.urls,
    };
  }

  // Fork-local release: приложение везёт собственный Source Server archive и
  // загружает его на remote host. Локальный проверенный archive имеет приоритет
  // для любого install mode: транспорт сам выбирает upload, если путь задан.
  const localReleaseDirs = [
    ...(remoteAssets.bundledReleaseDir
      ? [join(remoteAssets.bundledReleaseDir, "releases", ZCODE_VERSION)]
      : []),
    ...(remoteAssets.mockCdnDir ? [join(remoteAssets.mockCdnDir, "releases", ZCODE_VERSION)] : []),
  ];
  for (const releaseDir of localReleaseDirs) {
    // Ошибка верификации bundled archive остаётся фатальной: молчаливая
    // подмена версии с CDN недопустима.
    const local = await resolveLocalDescriptor(releaseDir, target);
    if (!local) continue;
    return {
      localArchivePath: local.archivePath,
      target,
      version: ZCODE_VERSION,
      sha256: local.archive.sha256,
      sizeBytes: local.archive.sizeBytes,
      urls: local.archive.urls,
    };
  }

  // Bug 原因: desktop больше не имеет права тянуть Source Server с CDN
  // (в том числе z.ai). Если приложение собрано без bundled release — это
  // ошибка сборки, а не повод уходить в сеть за несовпадающей версией.
  throw new Error(
    `Source Server release ${ZCODE_VERSION} for ${target} is not bundled with this app. ` +
      "Rebuild the application with the Source Server archive included; remote CDN fallback is disabled.",
  );
}
