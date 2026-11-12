# 本机网络与 SSH 可达性诊断（macOS Local Network）

- 状态：已实施（打包声明 + 错误展示）；真实连通性未验证
- 日期：2026-11-11
- 来源：`docs/architecture/remote-device-connection-ux-spec.md`（连接错误分类）；运行时日志 `~/.zcode/v2/logs/2026-11-11.log`
- 适用范围：`packages/desktop/electron-builder.config.js`、`packages/shared/src/source-server/connectionErrors.ts`、`packages/ui` 的连接错误展示与三种 locale
- 主要对象：macOS `NSLocalNetworkUsageDescription`、`remote-host-unreachable` 的标题/原因文案、`remote.error.hostUnreachable.refused.reason`

## 1. 本规格回答什么

用户报告“添加 SSH 项目后无法连接”。本规格只做两件事：

1. 让 macOS 能就“本机网络”权限向 ZCode 发起授权（打包声明），并让错误展示不再把未确认的原因说成事实。
2. 明确哪些结论已有证据、哪些仍只是假设，避免把“加了一个 Info.plist key”当成“已修复连接”。

本规格不承诺修复连通性。若真实原因是路由、VPN、目标防火墙或 macOS 隐私授权，最终仍需用户在系统侧确认。

## 2. 已确认事实

- F1：失败发生在 ssh2 的 TCP 建连阶段，不是认证、安装或 UI 状态机。
  证据：`packages/server/src/remote/ssh-backend.ts:105-117`（错误归一化与上报）、`:194-200`（connect 的 error 路径）。
- F2：实际失败为 `EHOSTUNREACH`，本机地址 `172.16.99.4`，目标 `172.16.99.50:22` 与 `:2222` 都在十几毫秒内失败（由日志里 connecting 与 error 时间戳推算约 12–17 ms）。
  证据：`~/.zcode/v2/logs/2026-11-11.log:5634-5644`、`:5681-5688`；另一目标 `172.16.99.60` 见 `:135-144`。
- F3：Host 已把该失败稳定归类为公开码 `remote-host-unreachable`，UI 也按该码展示。
  证据：日志 `:5640`、`:5688` 的 `"code":"remote-host-unreachable"`；`packages/shared/src/source-server/connectionErrors.ts:10-25`。
- F4：同一个公开码同时覆盖 `ECONNREFUSED`、`EHOSTUNREACH`、`ENETUNREACH`、`ECONNRESET`，四者原因不同。
  证据：`packages/shared/src/source-server/connectionErrors.ts:10-25`、`:87-93`。
- F5：ZCode 没有为 Bash 或 ssh2 启用 OS 沙箱；macOS entitlements 中没有 `com.apple.security.app-sandbox`。
  证据：`packages/desktop/build/entitlements.mac.plist`、`packages/desktop/build/entitlements.mac.inherit.plist`（均无该 key）。
- F6：ZCode 的 Chromium 网络策略只作用于 Electron session，不接管 ssh2/Node 的 TCP 出口。
  证据：`packages/desktop/src/main/desktopNetworkPolicy.ts:51-90`。
- F7：Agent 的 WebFetch 出网限制只作用于 WebFetch 的 URL/IP 字面量，不影响 Bash 与远端连接。
  证据：`apps/zcode-cli/packages/core/src/tool/handlers/webfetch-egress-guard.ts:14-38`。
- F8：改动前仓库与已打包的 `Info.plist` 都没有 `NSLocalNetworkUsageDescription`。
  证据：全仓 grep 无匹配；`packages/desktop/dist/mac-arm64/ZCodePreview.app/Contents/Info.plist` 无该 key（构建产物可能早于本改动）。
- F9：产品只有 SSH 客户端：`SSHBackend` 实现远端执行/上传，没有 `ssh2.Server`、host key 或 sshd 托管代码。
  证据：`packages/server/src/remote/ssh-backend.ts:93-140`；`packages/server/src` 内无 SSH server 实现。
- F10：`RemoteProjectMenu` 未被任何入口挂载，只登记在模块清单与架构策略。
  证据：`packages/ui/src/project-sidebar/RemoteProjectMenu.tsx`；`packages/ui/src` 内引用仅 `packages/ui/src/project-sidebar/module.ts:21`，另有 `architecture-policy.yaml:142` 的模块清单登记。

## 3. 尚未确认的假设（不得写成结论）

- H1：macOS 的 Local Network 隐私拒绝把局域网连接表现为 `EHOSTUNREACH`。可能。
  所需证据：同一台 Mac 上用终端 `ssh`/`nc` 对比；只有“终端成功而 ZCode 失败、且系统设置中 ZCode 的本地网络为关闭”时才成立。
- H2：路由表或 VPN 分流不包含 `172.16.99.0/24`。可能。所需证据：`route get 172.16.99.50`、VPN 客户端分流配置。
- H3：目标机防火墙/路由器隔离了该 Mac，或目标机未开机。可能。需在目标侧或同网段另一台机器验证；本机日志无法区分。
- H4：目标地址或端口写错。22 与 2222 同时失败且耗时极短，单一端口笔误可能性较低，但地址错误仍可能。
- H5：本机网络扩展、安全软件或企业策略拦截了应用层 TCP。可能。需对比终端与 GUI 应用、查看系统网络扩展列表。

明确排除的猜测（没有证据，不得在 UI 或工单中作为原因）：

- “应用沙箱/CSP 拦截了 SSH”：F5、F6、F7 与现有证据都不支持。
- “ZCode 网络代理设置导致”：代理只作用于 Chromium session 与模型请求（F6）。
- “设备未启动”：`EHOSTUNREACH` 只说明本机没有可达路径（F4），不能推出目标机状态。

## 4. UI 可以说与不可以说

- 传输层无路由（`EHOSTUNREACH`/`ENETUNREACH` 等）：
  - 可以说：“ZCode 无法访问该地址”；检查地址/端口、网络路由、VPN 分流、防火墙；macOS 上检查 ZCode 的本地网络权限。
  - 不可以说：“设备已关机/离线”“macOS 阻止了 ZCode”“网络已断开”。
- 端口拒绝（`ECONNREFUSED`）：
  - 可以说：“主机有响应，但该端口没有服务接受连接”；检查端口与目标服务。
  - 不可以说：“没有到主机的路由”“设备不可达”。
- 详细信息：展示已脱敏的原始 OS 错误与错误码，便于支持判断；不把原始错误文本直接当原因结论。
- 修复动作：重试、修改地址/端口、查看详情；不自动改网络设置、不关闭安全机制、不引导用户重置 TCC。

结构化错误码保持不变：`remote-host-unreachable` 仍是两类传输失败的唯一公开码；只有 `reasonId` 按传输证据细分。

## 5. macOS 打包声明

在 `packages/desktop/electron-builder.config.js` 的 `mac.extendInfo` 中新增 `NSLocalNetworkUsageDescription`，说明 ZCode 需要访问本机网络以连接 SSH/局域网设备。

不新增 `NSBonjourServices`：当前产品代码没有 Bonjour/mDNS 浏览或广播；该 key 只在声明 Bonjour 服务类型时才需要。若未来加入设备发现，需先有发现功能并单独更新本规格。

声明的作用边界：

- 它让 macOS 的本地网络授权**可以发生**，不保证用户会允许，也不保证网络路径可达。
- 未签名/ad-hoc 开发构建与签名安装包的 TCC 行为可能不同；只有真实安装包运行才能确认提示出现。
- 声明本身不会修改路由、VPN、防火墙或目标机状态。

## 6. 诊断步骤（用户/支持执行）

1. 在同一台 Mac 的终端执行 `nc -vz -w 5 <host> 22` 与 `ssh -v -p 22 <user>@<host>`。
   - 终端也报 `EHOSTUNREACH`/超时：与 ZCode 无关，按第 2–4 步查网络路径。
   - 终端成功、ZCode 失败：重点检查 macOS 本地网络授权（第 5 步）。
2. `route get <host>` 确认存在到目标的默认路由或直连路由。
3. 检查 VPN/分流：`scutil --nc list` 与 VPN 客户端的分流网段是否包含目标网段。
4. 检查目标机与中间防火墙是否允许该 Mac 访问 22 端口；在目标机或同网段另一台机器上复测。
5. macOS“系统设置 → 隐私与安全性 → 本地网络”中确认 ZCode（或 ZCode Preview）已允许；切换后重启应用再试。
6. 若终端与 ZCode 都失败且目标为私网地址，收集 `route get`、VPN 状态、目标端口连通性结果；不要先归因于应用。

支持判断用的观测（非证明）：

- 失败耗时只有十几毫秒且两个端口一致，更像本机路由/邻居/权限层的即时拒绝，而不是远端静默丢包；但该观察不能单独定因。
- 只有在第 1 步出现“终端成功、应用失败”时，才可以把本地网络权限列为首要嫌疑。

## 7. 产品决定：不做 SSH 服务端

“从项目里添加 SSH 服务器”若指让 ZCode 在目标机上托管 sshd，则不属于本产品当前能力：

- 现有链路是“连接已存在的 SSH 服务”（F9），服务端必须由用户/目标系统提供。
- 未挂载的 `RemoteProjectMenu` 不被重新挂载，也不新增假入口（F10）。
- 若未来要做 SSH 服务托管，必须单独立项，覆盖主机密钥生成与持久化、认证、端口/防火墙、审计与权限边界；不能作为本次诊断修复的顺带功能。

## 8. 实现清单

- `packages/desktop/electron-builder.config.js`：`mac.extendInfo.NSLocalNetworkUsageDescription`。职责：打包声明；不改变运行时网络行为。
- `packages/shared/src/source-server/connectionErrors.ts`：新增 `detectRemoteHostUnreachableTransportCause` 区分拒绝/无路由，公开码不变。职责：传输证据的唯一判据。
- `packages/ui/src/lib/remoteConnectionPresentationErrors.ts`：`remote-host-unreachable` 按传输证据选择原因 key。职责：展示分类；不持有状态。
- `packages/ui/src/i18n/locales/en-US.ts`、`zh-CN.ts`、`ru-RU.json`：更新无路由原因；新增端口拒绝原因（三语同键）。职责：文案。

事件顺序（单一写入路径）：

```text
ssh2 connect error
  → normalizeRemoteConnectionError（唯一定码：remote-host-unreachable）
  → Host snapshot { errorCode, error }
  → UI classifyRemoteConnectionError（唯一 reasonId 决策）
  → 各面板/Toast 读取同一 reasonId
```

## 9. 验收标准

- LN-01：macOS `extendInfo` 含非空 `NSLocalNetworkUsageDescription`，既有 usage key 不被删除。
  验证：`packages/desktop/test/electronBuilderLocalNetworkUsage.test.ts`。
- LN-02：未声明 `NSBonjourServices`（当前无 Bonjour 功能）。验证同上。
- LN-03：无路由文案提到路由/VPN/防火墙与 macOS 本地网络权限，且不含“确认设备已启动”式断言。
  验证：`packages/ui/test/remoteConnectionHostUnreachableGuidance.test.ts`。
- LN-04：`ECONNREFUSED` 展示端口/服务原因，`category` 与公开码保持 `remote-host-unreachable`。验证同上。
- LN-05：WSL/Docker 变体文案与 `reasonId` 不变。验证同上。
- LN-06：三个 locale 同时存在无路由与端口拒绝原因键，且非空。验证同上。
- LN-07：不新增 sshd 功能，不挂载 `RemoteProjectMenu`。验证：代码审查。
- LN-08：真实连通性（路由/VPN/防火墙/TCC）由用户验证；本改动不宣称已修复。验证：手动执行第 6 节。
- LN-09：打包后的 `Info.plist` 实际包含该 key。验证：执行 macOS 打包后检查 `Contents/Info.plist`（本次未执行）。

## 10. 明确未验证

- 真实打包产物的 `Info.plist` 是否包含新 key（需重新打包）。
- 签名/公证安装包上是否出现本地网络授权提示，以及允许后连接是否恢复。
- `EHOSTUNREACH` 的真实根因（H1–H5 均未确认）。
- 目标类型检查、lint、格式与测试命令的本次执行结果（执行环境受限时以实际报告为准）。
