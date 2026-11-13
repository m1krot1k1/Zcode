// 公开入口：electron-builder 配置、prepare-windows-cua-helper 与测试都从这里引用。
// 发布契约（常量/PE/schema 判定）放在 ./cua-helper-assets/common.mjs 唯一定义；
// staging、afterPack 验签与签名后的 manifest 刷新分别位于同目录模块，避免同一规则多处漂移。
export {
  readRegularFileSnapshot,
  renameDirectoryWithRetries,
  resolveElectronBuilderWindowsTarget,
} from "./cua-helper-assets/common.mjs";
export { finalizePackagedWindowsCuaHelper } from "./cua-helper-assets/finalize.mjs";
export { verifyPackagedWindowsCuaHelper } from "./cua-helper-assets/verification.mjs";
export {
  prepareWindowsCuaHelperAssets,
  resolveWindowsCuaHelperSourceRoot,
} from "./cua-helper-assets/staging.mjs";
