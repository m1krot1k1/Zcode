import { PACMAN_RUNTIME_DEPENDENCIES } from "./context.mjs";

export function buildDesktopArtifactName(ctx, platformName, extension = "${ext}") {
  // 测试环境产物必须和正式安装包文件名区分，避免上传、下载或人工验收时混用。
  return `\${productName}-\${version}-${platformName}-\${arch}${ctx.desktopArtifactEnvSuffix}.${extension}`;
}

export function createProtocols(ctx) {
  return [
    {
      // 协议处理器的展示名之前使用小写 scheme，打包产物里的协议描述无法体现产品名。
      // 展示名跟随安装包身份；scheme 仍保持 zcode，因此两个应用中最后注册者会成为默认 handler。
      name: ctx.desktopProductIdentity.productName,
      schemes: ["zcode"],
    },
  ];
}

export function createMacOptions(ctx) {
  return {
    target: ["dmg", "zip"],
    executableName: ctx.desktopProductIdentity.macExecutableName,
    category: "public.app-category.developer-tools",
    artifactName: buildDesktopArtifactName(ctx, "mac"),
    extendInfo: {
      NSAppleEventsUsageDescription: `${ctx.desktopProductIdentity.productName} needs Apple Events access to coordinate local automation workflows with user-approved desktop apps.`,
      // 缺失该 key 时 macOS 会静默拒绝 CoreBluetooth 枚举，内置浏览器 Web Bluetooth
      // 的设备选择器列表恒为空（实测 Chrome 有蓝牙隐私权限则正常）。
      NSBluetoothAlwaysUsageDescription: `${ctx.desktopProductIdentity.productName} needs Bluetooth access to list nearby devices when a website you open in the embedded browser requests one.`,
      // 本机网络权限：SSH 目标通常是局域网/私有网段地址，macOS 会按应用授权本地网络访问。
      // 缺少该 key 时系统不展示授权请求，用户也没有机会在「本地网络」中允许 ZCode。
      // 该声明只影响授权提示，不保证路由、VPN 或目标防火墙允许连接。
      NSLocalNetworkUsageDescription: `${ctx.desktopProductIdentity.productName} needs local network access to connect to SSH hosts and other devices on your network.`,
    },
    // 预签名脚本走的是原生 codesign，要求完整的 "Developer ID Application: ..." 身份串；
    // 但 electron-builder 的 mac.identity 在 26.x 下会拒绝带此前缀的名字。
    // 这里仅对 electron-builder 侧做前缀归一化，避免本地预签名和最终 .app 签名互相打架。
    // z-code 之前只有本地未签名打包配置，CI 即使注入了证书变量，
    // electron-builder 也不会自动切到 hardened runtime / entitlement 这套发布参数。
    // 这里显式收拢到环境开关，保证本地开发不被签名配置绑死，CI 发布时再按需打开。
    identity: ctx.shouldEnableMacSigning ? ctx.macSigningIdentity : null,
    // 普通 dev/preview build 不使用 Apple auth；release 显式启用 electron-builder v26 notarization。
    // electron-builder 在 notarization 成功后会自动 staples ticket 到 app bundle。
    notarize: ctx.macBuildSecurity.notarize,
    hardenedRuntime: ctx.macBuildSecurity.hardenedRuntime,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.inherit.plist",
    // runtime 可执行文件已在打包前的独立预签名阶段完成签名，
    // electron-builder 在签主 app 时若继续深度扫描这些目录，会显著拉长 macOS codesign 时长。
    // 这里按“任意前缀 + Contents/Resources”匹配绝对路径，避免 ^Contents/... 在 CI 中无法命中。
    // 命中后可跳过已预签名目录的重复签名/遍历，同时保留主 app 与框架签名。
    // CUA Helper 在独立 job 中已完成 Developer ID 签名和 notarization staple；
    // electron-builder 若再次签名嵌套 Helper 会改变 CDHash，使最终用户包中的 staple 失效。
    signIgnore: [
      "[/\\\\]Contents[/\\\\]Resources[/\\\\]cua-helper([/\\\\]|$)",
      "[/\\\\]Contents[/\\\\]Resources[/\\\\]glm([/\\\\]|$)",
      "[/\\\\]Contents[/\\\\]Resources[/\\\\]tools([/\\\\]|$)",
    ],
  };
}

export function createWindowsOptions(ctx) {
  return {
    target: ["nsis"],
    artifactName: buildDesktopArtifactName(ctx, "win"),
    signExts: [".node", ".dll"],
    // Bugfix: Windows CI 之前完全依赖 electron-builder 内置 signtool.exe，
    // 一旦 runner 的证书链路要求改走 vsigntool，打包阶段就会在内置签名环节卡死。
    // 这里通过自定义 sign hook 把所有 Windows 可执行文件统一切到仓库内的 vsigntool 封装，
    // 既保留 electron-builder 的签名时机，又和 CI 机器上的签名基础设施保持一致。
    ...(ctx.shouldEnableWindowsVsign
      ? {
          signtoolOptions: {
            sign: "./scripts/sign-windows-hook.cjs",
          },
        }
      : {}),
  };
}

export function createLinuxOptions(ctx) {
  return {
    target: ["AppImage", "deb", "rpm", "pacman"],
    artifactName: buildDesktopArtifactName(ctx, "linux"),
    // desktop 包名是 scoped package（@zcode/desktop），electron-builder 默认会把
    // Linux executable/Icon 推成 @zcodedesktop。部分桌面环境无法按这个 icon name 命中
    // hicolor 图标，最终回退成系统齿轮。这里固定成稳定的小写名称，让 Icon=zcode
    // 与 /usr/share/icons/hicolor/*/apps/zcode.png 保持一致。
    executableName: ctx.desktopProductIdentity.linuxExecutableName,
    category: "Development",
    maintainer: "ZCode <dev@zcode.z.ai>",
  };
}

export function createDebOptions(ctx) {
  return {
    // 生产版与 Preview 必须是两个 dpkg package；只改可执行名仍会让安装器把另一版本当成升级替换。
    packageName: ctx.desktopProductIdentity.linuxPackageName,
  };
}

export function createPacmanOptions(ctx) {
  return {
    // 与 deb/rpm 保持相同的 flavor 隔离，避免 Preview/Production 被 pacman 当作同一包覆盖。
    packageName: ctx.desktopProductIdentity.linuxPackageName,
    // 显式列出 Arch 官方仓库可解析的 Electron 运行时依赖，替换 electron-builder
    // 陈旧默认集合，避免安装阶段因已移除包名直接失败。
    depends: PACMAN_RUNTIME_DEPENDENCIES,
    // Electron Builder 默认把 pacman target 命名为 .pacman；Arch 原生包的标准扩展名是 .pkg.tar.zst。
    artifactName: buildDesktopArtifactName(ctx, "linux", "pkg.tar.zst"),
  };
}

export function createRpmOptions(ctx) {
  return {
    // 与 deb 同一约束：生产版与 Preview 必须是两个独立 rpm 包，否则 dnf 会把另一 flavor 当成升级替换。
    // rpm 面向 RHEL 8+（glibc 2.28）分发；整包 glibc 下限由 node-pty prebuild 与 bfs/ugrep 抬到 2.28，
    // Electron 41 主二进制只引用到 2.25，不会更高。fpm 产 rpm 需要构建机提供 rpmbuild 与 xz。
    packageName: ctx.desktopProductIdentity.linuxPackageName,
    // electron-builder 的 rpm 默认 Requires（gtk3/nss/libXtst 等）不包含 Electron ELF 实际
    // DT_NEEDED 的 mesa-libgbm 与 alsa-lib；rockylinux:8 最小化容器实测装完后启动报
    // libgbm.so.1 缺失。这里用 fpm 追加 -d（在默认 Requires 之后累积），不能用 depends——
    // depends 会整组替换默认 Requires 集。
    fpm: ["-d", "mesa-libgbm", "-d", "alsa-lib"],
  };
}

export function createDmgOptions() {
  return {
    // 当前安装包携带的运行时资源（尤其 agent node_modules）体积已超过默认 DMG 估算值。
    // 之前依赖自动容量时，生成的 DMG 挂载卷只有约 1.9Gi，复制 .app 过程中会因为空间耗尽
    // 丢失 Electron Framework 主二进制，安装后启动直接报 DYLD Library missing。
    // 显式放大 DMG 容量，避免拷贝截断导致的“Framework 目录存在但核心文件缺失”。
    size: "3200m",
    // 使用自定义安装背景图。
    background: "build/dmg_background.png",
    // 安装盘图标统一使用安装专用素材，避免复用应用图标导致安装识别度不足。
    icon: "build/icon_installer.icns",
    contents: [
      // 实验性调整：为隐藏资源文件显式指定图标坐标，尽量把它们移到角落区域。
      { x: 640, y: 56, type: "file", path: ".background.tiff" },
      { x: 640, y: 56, type: "file", path: ".VolumeIcon.icns" },
      { x: 130, y: 220 },
      { x: 410, y: 220, type: "link", path: "/Applications" },
    ],
  };
}

export function createNsisOptions() {
  return {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    // Windows 安装流程使用独立安装图标，和应用运行时图标解耦。
    installerIcon: "build/icon_installer.ico",
    uninstallerIcon: "build/icon_installer.ico",
    installerHeaderIcon: "build/icon_installer.ico",
  };
}

export function createPublishOptions() {
  return {
    provider: "generic",
    // 当前 OSS/CDN 对多 Range 请求返回 206，但 Content-Type 仍是 application/x-msdownload，
    // electron-updater 会因缺少 multipart/byteranges 直接回退整包下载。关闭 multiple range 后仍走差分，
    // 只是按单 Range 顺序拉取差异块，避免 Windows 用户更新时从约 15MB 退化成 300MB+ 全量包。
    useMultipleRangeRequest: false,
    // 新客户端运行时使用服务端 manifest provider；这里仅保留 electron-builder 必需的
    // generic publish 占位。使用产品域名而不是 localhost，避免 production 产物携带本机 feed。
    url: "https://zcode.z.ai/updates",
  };
}
