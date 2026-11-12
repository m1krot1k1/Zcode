# Desktop CI/CD

`z-code` 的 CI/CD 入口是 GitHub Actions：

- `.github/workflows/checks.yml`：PR 与 `dev`/`main` push 的质量门禁。
- `.github/workflows/cross-platform-preview-release.yml`：手动触发的跨平台 Preview 构建与 prerelease 发布。

旧文档描述的 GitLab pipeline（`.gitlab-ci.yml`、`.gitlab/ci/*.yml`）在当前 checkout 中不存在，
相关 job 名称、变量和 `glab` 操作已移除，不再作为本仓库的运行说明。macOS 正式发布走本地脚本，
跨平台 Preview 走 GitHub Actions；两者都不是 production 发版通道。

## 质量门禁（`checks.yml`）

触发：`pull_request`，以及推送到 `dev` 或 `main`。同一 PR/分支的新提交通过 `concurrency`
取消上一轮运行。Node 固定 `24.14.0`，pnpm 固定 `10.33.2`，依赖安装统一使用
`pnpm install --frozen-lockfile`，pnpm store 由 `actions/setup-node` 的 `cache: pnpm` 复用。

| job             | 触发    | 命令                                                                                         |
| --------------- | ------- | -------------------------------------------------------------------------------------------- |
| `static`        | 全部    | `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check`、`node scripts/check-doc-links.mjs` |
| `unit-affected` | 仅 PR   | `pnpm test:unit:affected --base origin/<base>`（checkout `fetch-depth: 0`）                  |
| `unit-full`     | 仅 push | `pnpm test:unit -- --shard=<n>/4`，4 个 shard 并行                                           |

单测入口与 include/exclude 规则见 [单测质量与删减规格](testing/unit-test-quality.md)。
`pnpm test:unit` 已排除 `packages/desktop/test/e2e/**`；`checks.yml` 不运行桌面 E2E、打包、
签名、上传或发布。CI 变绿只代表类型、Lint、架构边界、文档链接与单测通过，不代表 E2E 或
产品验收通过。

`unit-affected` 使用 Vitest 官方选择，只运行与改动相关的根单测；选中整个套件时会按
[pre-push 说明](testing/pre-push-hook.md) 跳过 UT 并成功退出。Push 到集成分支使用
`unit-full` 的全量分片结果，不依赖 affected 的增量选择。

## 跨平台 Preview（`cross-platform-preview-release.yml`）

只支持 `workflow_dispatch`，必须提供已存在的版本 tag（`release_tag`）。tag push、分支 push
和 PR 都不会启动该工作流。构建 job 使用只读 `contents: read`，最终 `publish` job 才获得
`contents: write`。

| job       | 职责                                                                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop` | 在 macOS arm64、Windows x64、Linux AMD64 上执行 `pnpm bundle:desktop -- --os <os> --arch <arch>`，产出 DMG/ZIP、NSIS、AppImage/DEB/RPM 等安装包 |
| `cli`     | 构建并冒烟测试三个平台的独立 CLI（`build-sea.mjs`），产出 `zcode-<platform>-<arch>` 可执行文件                                                  |
| `publish` | 下载全部 artifact，校验平台集合与数量，创建或更新指向同一 commit 的 prerelease；拒绝修改 stable release                                         |

Preview 构建使用离线 Preview 契约：ZCode 后端地址指向不可用的 loopback，遥测与自动更新关闭，
不需要 ZCode 账号；macOS 为 ad-hoc 签名、未公证，发布说明会提示首次启动可能需要人工放行。
工作流不 bump 版本、不推送 commit。完整验收条件见
[跨平台 Preview 规格](specs/cross-platform-preview-release.md)。

GitHub Actions 计费不可用时，跨平台 workflow 无法提供有效 evidence；此时 Windows/Linux
安装包保持未发布状态，macOS 由本地脚本产出。排障见
[GitHub Actions billing](testing/github-actions-billing.md)。

## 本地 macOS 发布

macOS Preview 的规范发布路径是本地脚本，需要 Node 版本与 `mise.toml` 中的
`[tools] node`（`24.14.0`）完全一致，并通过 `mise exec` 运行：

```bash
mise exec -- pnpm release:macos:preview <major|minor|patch>
mise exec -- pnpm release:macos:preview:resume <version>
mise exec -- pnpm release:macos <major|minor|patch>
```

脚本负责：要求干净的 `dev` checkout 且与 `origin/dev` 同步 → bump 版本并同步
`package.json`/`package-lock.json` → 以 `ZCode Preview` 身份和离线 endpoint 构建 → 校验版本、
架构、bundle identity、ad-hoc 签名、`_TEST` 产物名、归档内容与 SHA-256 → 推送 `dev` →
创建指向该 commit 的 GitHub prerelease → 下载产物复核哈希。失败后的恢复必须使用脚本打印的
版本号调用 `resume`，不会再次 bump 或提交。完整合同见
[macOS Preview 规格](specs/macos-preview-release.md)。

发布脚本的定向测试：

```bash
pnpm test:release:macos
```

## 常用命令

以下命令从仓库根目录执行：

| 用途                 | 命令                                             |
| -------------------- | ------------------------------------------------ |
| 类型检查             | `pnpm typecheck`                                 |
| Lint                 | `pnpm lint`                                      |
| 全量单测             | `pnpm test:unit`                                 |
| 变更相关单测         | `pnpm test:unit:affected --base origin/dev`      |
| 架构边界             | `pnpm architecture:check`                        |
| 文档链接             | `node scripts/check-doc-links.mjs`               |
| 桌面 E2E（独立入口） | `pnpm test:e2e`                                  |
| 桌面打包             | `pnpm bundle:desktop -- --os <os> --arch <arch>` |

提交前检查使用 `pnpm verify:pre-push`（Lint、架构检查、受影响单测等）。它不替代 CI，也不
覆盖桌面 E2E。

## 环境与边界

- 所有 workflow 与本地发布脚本都以 Node `24.14.0`、pnpm `10.33.2` 为准；版本以
  `mise.toml` 和根 `package.json` 的 `packageManager` 为准。
- Preview 产物带 `_TEST` 后缀并标记为 prerelease，不得冒充 Developer ID 签名或公证过的
  production 版本。
- 桌面 E2E、容器化验收和人工设备验收不在 `checks.yml` 内，需要单独的运行证据；不要把
  CI 结果写成 E2E 已通过。
