// afterPack 签名后的 manifest 刷新：签名会改变原生文件字节，这里只重算最终产物哈希，
// 随后复用同一严格 verifier 闭环验证。
import { writeFile } from "node:fs/promises";
import { sha256 } from "./common.mjs";
import {
  inspectPackagedWindowsCuaHelper,
  verifyPackagedWindowsCuaHelper,
} from "./verification.mjs";

/**
 * Windows extraResources 的原生文件在复制阶段完成签名；签名会改变字节，必须在 afterPack
 * 仅刷新最终产物哈希，然后用同一严格 verifier 再次闭环验证。
 */
export async function finalizePackagedWindowsCuaHelper({
  writeFileOperation = writeFile,
  ...options
}) {
  const inspection = await inspectPackagedWindowsCuaHelper({
    ...options,
    verifyHashes: false,
  });
  if (inspection.status === "skipped") return inspection;

  const finalizedManifest = {
    ...inspection.manifest,
    sha256: {
      entry: sha256(inspection.entryBytes),
      addon: sha256(inspection.addonBytes),
    },
  };
  await writeFileOperation(
    inspection.manifestPath,
    `${JSON.stringify(finalizedManifest, null, 2)}\n`,
    "utf8",
  );
  return verifyPackagedWindowsCuaHelper(options);
}
