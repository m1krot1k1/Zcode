# Lite-token cookie 的 Secure / Max-Age（QW13）

- 状态：已实施（spec + code + unit 用例已添加；本次环境未能执行 vitest/typecheck）
- 日期：2026-11-11
- 来源：[`docs/research/2026-11-11-zcode-wide-competitive-research.md`](../research/2026-11-11-zcode-wide-competitive-research.md)
  `| QW13 |`、R14、§9.3 H16
- 适用范围：`packages/server/src/http.ts`、`packages/server/src/entry-http.ts`、
  `packages/server/test/liteTokenCookie.test.ts`

> 实现位置说明：`packages/server` 在 `architecture-policy.yaml` 中是
> `managed: false`，新增 `packages/server/src/*.ts` 会触发 `unmanaged-new-file`。
> 因此 cookie 纯函数放在既有 `http.ts` 内（单文件仍受既有 `max-lines` 抑制约束），
> 不新建模块文件。

## 1. 问题

HTTP server 在 query token 认证成功时只写入：

```text
zcode_lite_token=<token>; Path=/; HttpOnly; SameSite=Lax
```

证据：`packages/server/src/http.ts:243-260`（修改前）；研究条目 H16 记录同一事实。

缺陷：

1. 没有 `Secure`：当部署在 TLS 终止代理之后时，浏览器会把令牌 cookie 也发到
   plain-HTTP 请求/降级连接。
2. 没有 `Max-Age`：cookie 是 session cookie，浏览器会话结束后丢失；令牌本身却是
   长期有效的，行为不一致。
3. 没有可信代理配置：直接信任任意 `X-Forwarded-Proto` 会被客户端伪造，
   不能作为唯一判据。

服务器本身目前只监听 plain HTTP（`serve({ fetch, hostname, port })`，
`packages/server/src/http.ts` 中 `createHttpServer` 末尾，修改前 `:488-492`）；
TLS 通常由反向代理终止。仓库中不存在既有的 trusted-proxy 处理
（全仓 grep `X-Forwarded-Proto` / `trustProxy` 无匹配），因此本项新增显式 opt-in，
而不是猜测。

## 2. 决策

### 2.1 Cookie 属性

所有 lite-token cookie 都包含：

```text
zcode_lite_token=<url-encoded token>; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax[; Secure]
```

- `Max-Age=2592000`（30 天）：显式浏览器端过期；与长期有效的服务端令牌一致。
- `HttpOnly`、`SameSite=Lax`、`Path=/` 保持不变。
- cookie 名称保持 `zcode_lite_token`，不改 `__Host-` 前缀：改名会让已持有 cookie 的
  客户端需要重新用 `?token=` 认证，且 `__Host-` 要求始终 `Secure`，会破坏 plain-HTTP
  本地开发。是否迁移到 `__Host-` 留给单独产品决策。
- 接受 token 的三个入口（`Authorization: Bearer`、`?token=`、cookie）语义不变；
  `Set-Cookie` 仍只在 query token 认证成功时下发。

### 2.2 Secure 判定（单一函数）

`isLiteTokenCookieSecure`：

1. 请求的真实 socket 是 TLS（`incoming.socket.encrypted === true`）→ `Secure`。
   该判据来自 Node 连接本身，不受请求头影响。
2. 否则，只有显式 `trustProxy` 开启时，才读取 `X-Forwarded-Proto` 的最后一个 hop
   （多值链条中最右侧、由最近的可信代理写入；最左侧可被客户端伪造）；
   其值（trim + 小写）为 `https` → `Secure`。
3. 其余情况（包括 plain HTTP、未开启 trustProxy 的任何头、`http`、空值）→ 不加
   `Secure`。

不把 `c.req.url` 的 scheme 当判据：Node/Hono adapter 会接受 absolute-form request
target（`GET https://host/path HTTP/1.1`）并用它构造 URL，攻击者可以在 plain socket
上伪造 `https:` scheme。判定只看 socket 与显式信任的代理头。

### 2.3 可信代理配置

- `createHttpServer(..., { trustProxy: true })` 显式开启；默认 `false`。
- `packages/server/src/entry-http.ts` 从 `ZCODE_SERVER_TRUST_PROXY=1|true|yes`
  读取并传入。
- 语义边界：只应在“能连到本 server 的对端都是受信 TLS 终止代理”时开启。
  判定读取 `X-Forwarded-Proto` 的最后一个 hop；若代理采用“覆盖”语义而非“追加”，
  单值场景同样正确。若链路中还有不可信中间层，则应关闭该开关。
- plain-HTTP 本地开发（distribution runner 默认 loopback、不带该变量）行为不变：
  cookie 仍不带 `Secure`，认证和 `/ws` 连接照常工作。

状态所有者：无持久化状态；cookie 是每个响应头部，由纯函数
`buildLiteTokenSetCookie` 生成，`http.ts` 是唯一调用点。

## 3. 请求流程

```text
GET /api/...?token=T
  → hasValidLiteToken: query token 命中
  → isLiteTokenCookieSecure({ socketEncrypted, forwardedProto, trustProxy })
  → buildLiteTokenSetCookie(T, { secure })
  → Set-Cookie: Path=/; Max-Age=...; HttpOnly; SameSite=Lax[; Secure]
  → 继续正常处理请求
```

失败/拒绝路径不变：错误 token 仍 401，不写 cookie。

## 4. 验收场景

| #   | 场景                                                           | 期望                                                                  |
| --- | -------------------------------------------------------------- | --------------------------------------------------------------------- |
| C1  | 真实 TLS socket（单测输入 `socketEncrypted: true`）            | cookie 含 `Secure`                                                    |
| C2  | plain HTTP、无代理头                                           | cookie 不含 `Secure`；含 `Max-Age`/`HttpOnly`/`SameSite=Lax`/`Path=/` |
| C3  | plain HTTP + `X-Forwarded-Proto: https`，`trustProxy` 默认关闭 | 不含 `Secure`（头被忽略，防伪造）                                     |
| C4  | plain HTTP + `X-Forwarded-Proto: https`，`trustProxy: true`    | 含 `Secure`                                                           |
| C5  | plain HTTP + `X-Forwarded-Proto: http`，`trustProxy: true`     | 不含 `Secure`                                                         |
| C6  | plain socket 上 absolute-form `https://...` request target     | 不含 `Secure`（URL scheme 不参与判定）                                |
| C7  | 已有 lite-token 认证回归                                       | Bearer / query / cookie 三种入口与 401 行为不变                       |

测试文件：`packages/server/test/liteTokenCookie.test.ts`；既有的
`packages/server/test/serverInfoHttp.test.ts:102-138` 继续覆盖认证回归。
C1 是判定函数级验证；当前 server 没有内置 TLS listener，无法在 `createHttpServer`
上做真实 TLS 集成，这一点在“未解决项”中如实标注。

本次实现时 shell 启动持续返回 `spawn /bin/zsh EAGAIN`（一次 freshness 检查 + 一次重试
均失败），因此 `pnpm vitest run packages/server/test/liteTokenCookie.test.ts`
（以及 `serverInfoHttp.test.ts`、`pnpm typecheck`）均为 not_run，未经执行验证。

## 5. 兼容性与风险

- 现有 plain-HTTP 用户：无行为变化（只是 cookie 增加 `Max-Age`）。
- HTTPS 反向代理用户：需要设置 `ZCODE_SERVER_TRUST_PROXY=1` 才能让浏览器端
  cookie 带 `Secure`；未开启时保持修改前行为，不会因为错误信任头而产生新风险。
- 错误开启 `trustProxy` 会让直连客户端伪造 `https`，使 cookie 被标记 `Secure`。
  该标记只会限制浏览器在 HTTPS 下发送 cookie，不会提升权限；但部署文档必须明确
  “仅限受信代理”。
- `Max-Age` 使 cookie 在浏览器中持久化 30 天；服务端令牌轮换时旧 cookie 仍会携带，
  与现有 cookie 认证语义一致，401 后用户重新用新 token 打开即可覆盖。

## 6. 明确不做

- 不引入 `__Host-` 前缀或改名（兼容性决策）。
- 不实现 Origin allowlist、token 交换后从 URL 移除 token、CSRF token（属于
  R10/其他条目）。
- 不新增内置 TLS listener；TLS 终止仍由外部代理或未来独立条目负责。
