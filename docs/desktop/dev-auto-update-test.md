# 桌面端开发态自动更新验证

## 目的

开发态默认不初始化自动更新，避免日常联调误触发下载、安装和重启流程。`pnpm dev:desktop:test` 默认离线：它不连接 ZCode 服务端，包括公开配置、marketing touch、场景列表和更新 manifest。`ZCODE_ENV=test` 只决定构建/产品身份，不保证连接独立的测试服务器；未显式配置时，测试 endpoint 历史上与 ZCode 默认 endpoint 相同。

如需连接自有测试服务器，开发者必须通过 `ZCODE_TEST_BASE_URL` 显式提供 origin，并启用 `ZCODE_DEV_ALLOW_ZCODE_API=1`。未提供明确测试 origin 时，dev 脚本拒绝远程模式；本地 test 启动不会回退到 production endpoint。

自有测试服务器如需验证自动更新，需提供以下接口：

```text
GET /api/v1/releases/electron/manifest
```

离线默认启动将服务端请求指向无监听服务的 loopback port 0，不访问外部 ZCode 服务。ZCode 仓库不假定开发者拥有可访问的测试服务器。

## 启动方式

```bash
ZCODE_DEV_ALLOW_ZCODE_API=1 \
ZCODE_TEST_BASE_URL=https://test.example.invalid \
ZCODE_AUTO_UPDATE_DEV=1 \
ZCODE_AUTO_UPDATE_DEV_VERSION=3.3.1 \
pnpm dev:desktop:test
```

- 未设置 `ZCODE_DEV_ALLOW_ZCODE_API=1` 时，`pnpm dev:desktop:test` 会将所有 ZCode endpoint alias 固定到 loopback port 0，外部服务请求 fail closed，不会回退到 production。
- 显式远程模式必须传入 `ZCODE_TEST_BASE_URL`，manifest provider 会请求指定测试 endpoint；不会回退到 production endpoint。
- `ZCODE_AUTO_UPDATE_DEV=1` 只在开发态显式开启自动更新；未设置时保持开发态不检查更新。
- `ZCODE_AUTO_UPDATE_DEV_VERSION` 用于模拟当前客户端版本，例如当前版本按 `3.3.1` 比较，测试环境 stable 返回 `3.3.2`、preview 返回 `3.3.3` 时即可验证通道切换。

## 行为边界

- 生产包不读取这些开发态开关，仍按打包配置和服务端 manifest provider 检查更新。
- 开发态会设置 `electron-updater` 的 `forceDevUpdateConfig`，并读取 `packages/desktop/dev-app-update.yml` 作为本地缓存初始化占位；真实下载 URL 仍来自测试环境 manifest 响应。
- 开发态点击“重启以更新”只重启当前 dev app，用于验证 UI 状态闭环，不尝试让未打包应用接管真实安装器。
