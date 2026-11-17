/**
 * 未打包运行时 Electron 的 app.getVersion() 固定返回 "0.0"（没有 app.asar 元数据），
 * 而 electron-updater 的 AppUpdater 构造器会立刻 semver.parse(app.version)，
 * 解析失败就抛 ERR_UPDATER_INVALID_VERSION，表现为 "App version is not a valid semver version: 0.0"。
 * 该抛错发生在 main bundle 的静态依赖求值阶段，早于窗口创建，所以整个应用起不来。
 *
 * 打包态版本由 electron-builder 的 extraMetadata 写入 app.asar 的 package.json，
 * 不需要（也不应该）在这里覆盖；这里只负责非打包态拿到一个与产品一致的合法 semver。
 * 候选来源按顺序：显式环境变量 ZCODE_APP_VERSION → 构建期注入的 __ZCODE_VERSION__
 * （来自根 package.json 的 version）。两者都不合法时才退回 0.0.0-dev，保证永远能启动。
 */

// 只做形状校验：接受 1.2.3 与 1.2.3-pre.1 / 1.2.3+build 这类合法 semver，
// 拒绝 "0.0"、空串等 electron-updater 会抛错的输入。
const SEMVER_SHAPE_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export const DESKTOP_APP_VERSION_FALLBACK = "0.0.0-dev";

export interface DesktopAppVersionTarget {
  readonly isPackaged: boolean;
  getVersion(): string;
  setVersion(version: string): void;
}

export interface DesktopAppVersionSources {
  /** 开发/测试显式覆盖，对应环境变量 ZCODE_APP_VERSION。 */
  envVersion?: string | undefined;
  /** 构建期注入的产品版本（tsup define __ZCODE_VERSION__）。 */
  buildVersion?: string | undefined;
}

export function isSemverShapedVersion(value: string | undefined | null): boolean {
  return typeof value === "string" && SEMVER_SHAPE_PATTERN.test(value.trim());
}

/**
 * 计算应在非打包态生效的版本；打包态返回 null，表示不要干预安装包自带版本。
 */
export function resolveDesktopAppVersion(sources: DesktopAppVersionSources): string | null {
  for (const candidate of [sources.envVersion, sources.buildVersion]) {
    if (isSemverShapedVersion(candidate)) {
      return (candidate as string).trim();
    }
  }
  return DESKTOP_APP_VERSION_FALLBACK;
}

/**
 * 把合法版本写进 Electron app。返回实际生效的版本；打包态返回 null。
 * 幂等：多次调用只会重复设置同一个值。
 */
export function applyAppVersionBootstrap(
  target: DesktopAppVersionTarget,
  sources: DesktopAppVersionSources,
): string | null {
  if (target.isPackaged) {
    return null;
  }
  const resolved = resolveDesktopAppVersion(sources);
  if (resolved === null) {
    return null;
  }
  if (target.getVersion() !== resolved) {
    target.setVersion(resolved);
  }
  return resolved;
}
