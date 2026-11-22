# Z06 — packages/rpc, packages/shared, packages/client: RPC, протокол, shared-контракты, client SDK

> Research-only артефакт. Продуктовый код, конфиги, зависимости и lockfile не изменялись.
> Дата исследования: 2026-11-11. Ветка `dev`, HEAD `d10f0b69` («Выпустить macOS Preview 3.17.102»).
> Единственная запись этого филиала — данный файл. Метки: **[Observed]** — проверено по исходнику/команде; **[Inference]** — вывод из evidence; **[Unknown]** — источники не подтверждают.

## 1. Scope and method

### 1.1. Загруженный skill и границы

- Skill `research` загружен по точному имени через `Skill`. Применена его дисциплина: primary sources (код, тесты, docs), разделение FACT / HYPOTHESIS / UNKNOWN, фиксация непроверенного.
- Роль: researcher, read-only, кроме одного partial-файла. `pnpm typecheck`, полный unit-набор, E2E, тяжёлые сборки, desktop runtime и живой mobile relay не запускались.
- Выполнялись только точечные команды: `git status/branch/log`, `node scripts/check-workspace-freshness.mjs`, `node --version`, `find`, `rg`, `nl -ba`, `sed -n`, `wc`, `awk`, `cat`; `npx vitest run` для трёх узких наборов; ad-hoc probes через `./node_modules/.bin/tsx -e` для поведения сериализатора/клиента (не тесты и не committed regression).
- CodeIndex использован: `status` → `state: ready`, `partial: false`, generation `1453`, 10007 files, 26791 chunks, 278154 symbols, 377669 edges, диагностика `Embedding search is unavailable; showing lexical results.` **[Observed]** Load-bearing факты подтверждены чтением исходников, а не только индексом.

### 1.2. Preflight (Observed)

```text
$ git status --short
?? docs/research/
$ git branch --show-current
dev
$ git log -1 --oneline
d10f0b69 Выпустить macOS Preview 3.17.102.
```

```text
$ node scripts/check-workspace-freshness.mjs
[freshness] 基线新鲜：dev（与 origin/dev 同步），相对 origin/main：ahead 344 / behind 0（阈值 50）
EXIT_CODE=0
```

```text
$ node --version
v26.9.0
```

Node среды (26.9.0) не совпадает с пином `mise.toml` (24.14.0) — это зафиксировано в Z01; на выводы Z06 не влияет, но объясняет, что тесты запускались не на целевом Node.

### 1.3. Как читалась область

- Манифесты и entrypoints: `packages/{rpc,shared,client}/package.json`, `cat`, `nl -ba`.
- Дерево и объём: `find … -type f`, `wc -l` (rpc/src 3300 строк, rpc/test 1453; client/src без тестов 1967, client/test 1607; shared/src 55698 — включая colocated `contract.test.ts`, shared/test 35696).
- RPC: все 16 файлов `packages/rpc/src` (buffer, foundation, serialization, protocol, persistent-protocol, channels.shared, channelClient, channelServer, delayedChannel, ipc, proxy-channel, logging-middleware, network-telemetry-middleware, remote, index).
- Protocol v1: `packages/shared/src/zcode-protocol/index.ts` (4895 строк) — шапка, константы версий, request/notification/response/error schemas, method table, contract table; плюс `trace.ts`.
- Protocol v4: `core.ts`, `wire.ts`, `wire-codec.ts`, `wire-reassembly.ts`, `wire-assembler.ts`, `wire-fault.ts`, `transport.ts`, `command.ts`, `delta.ts`, `apply.ts` и индекс пакета.
- Shared/platform: `platform.ts` (1229 строк), `remote-workspace-identity.ts`, `task-realtime-core.ts`, `web-remote-control.ts`, `validation.ts`, `handshake.ts`, `server-remote.ts`, `source-server/compatibility.ts`.
- Client: все 12 файлов `packages/client/src`, все 6 файлов `packages/client/test` и один тест внутри src.
- Runtime validation sites: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/{transport,server,server-types}.ts`, `.../zcode-protocol-v4/v4-gateway.ts`, `packages/services/src/zcode-agent/{zcodeStdioTransport,zcodeAgentConnectionScope}.ts`.
- Docs (первоисточники проектных решений): `docs/architecture/rpc.md`, `docs/architecture/communication-protocol-layers.md`, `docs/architecture/rpc-channel-init-timing.md`, `docs/zcode-protocol.md`, `docs/v4-refactor/04-sync-and-recovery.md`, `05-transport-and-backpressure.md`, `09-protocol-schema.md`, `11-deletion-plan.md`, `docs/v4-refactor/design-review.md`.

## 2. Coverage table

| # | Область (пункт конверта Z06) | Статус | Основные источники |
| --- | --- | --- | --- |
| 2.1 | Карта трёх пакетов: manifest, tree, entrypoints, dependency graph, test setup | полный | `packages/rpc/package.json:1-27`, `packages/shared/package.json:1-25`, `packages/client/package.json:1-21`, `vitest.config.ts:113-142` |
| 2.2 | RPC framework: transports, request/response, streaming, cancellation, backpressure, timeouts, retries, errors, middleware, routing, serialization, lifecycle | полный (код) / частичный (runtime-поведение) | §3.1; `protocol.ts`, `persistent-protocol.ts`, `channelClient.ts`, `channelServer.ts`, `ipc.ts`, `remote.ts`, `proxy-channel.ts` |
| 2.3 | Protocol v1: schemas, strict types, runtime validation, versioning, unknown messages, capability negotiation | полный для оболочки и method table / частичный для всех 104 методов | §3.3; `zcode-protocol/index.ts:134-472, 4602-4739, 4747+` |
| 2.4 | Shared platform и identity: `IPlatformService`, utilities, `workspaceIdentity`/`remoteSessionId`, path fallback | полный для identity/platform-контрактов / частичный для всех членов интерфейса | §3.4; `platform.ts:683-1229`, `remote-workspace-identity.ts:1-174`, `task-realtime-core.ts:84-89` |
| 2.5 | Client SDK: public API, auth, lifecycle, streaming, reconnection, retries, errors, cancellation, promises/docs | полный (код) / частичный (гарантии не документированы) | §3.5; `client/src/index.ts:1-17`, `websocket.ts`, `messageport.ts`, `remoteServiceAccess.ts` |
| 2.6 | Validation: runtime vs type-only, malformed input, fuzzing | полный (карта) / пробел (fuzz отсутствует) | §4; `server-types.ts:224-255`, `bootstrap/.../transport.ts:267-291`, `zcodeStdioTransport.ts:256-270` |
| 2.7 | Tests: contract, serialization, reconnect, version compatibility; gaps | полный (инвентарь и запуск узких наборов) | §7; `packages/rpc/test/*`, `packages/shared/test/zcodeProtocolV4*`, `packages/client/test/*` |
| 2.8 | Gaps/risks и strengths | полный (по evidence) | §4, §5 |

## 3. Capability inventory

### 3.1. Пакеты и dependency graph (Observed)

| Пакет | Manifest | Публичные entrypoints | Зависимости | Тесты |
| --- | --- | --- | --- | --- |
| `@zcode/rpc` | `packages/rpc/package.json:1-27`; version `1.0.0` (`:3`), `types: dist/index.d.ts` (`:6`), export `.` → `types dist`, `default src/index.ts` (`:7-12`) | `packages/rpc/src/index.ts:1-132` — 7 слоёв (Layer 0–6) | только devDeps `ts-node`, `typescript` | собственный `vitest.config.ts` (`include: test/**/*.test.ts`), 8 файлов, 71 тест |
| `@zcode/shared` | `packages/shared/package.json:1-50`; `private: true` (`:3`), root export `./src/index.ts` (`:9`), 25 subpath exports (`:10-34`), в т.ч. `./zcode-protocol-v4` (`:25`), `./web-remote-relay` (`:34`) | `src/index.ts` + subpaths; корневой `index.ts` реэкспортирует `zcode-protocol/index.js` (`:90`) и legacy types (`:93`) | `zod 4.6.5`, `@zcode/model-option-map`; devDeps `ws`, `@types/ws`, TS 6 | `packages/shared/test`: 153 файла, включая 31 `zcodeProtocolV4*.test.ts` (539 `it()` по regex-подсчёту; см. §8.1 о методике подсчёта) |
| `@zcode/client` | `packages/client/package.json:1-21`; `private: true` (`:3`), export `.` → `src/index.ts` (`:6`), `./globals` (`:7`) | `packages/client/src/index.ts:1-17` — 5 групп экспортов | `@zcode/rpc`, `@zcode/services`, `@zcode/shared` (`:13-17`) | 6 файлов в `client/test`, 45 `it()`; 1 тест в `src` **не собирается** root-конфигом |

Потребители (по `rg` в `package.json`): `@zcode/rpc` — `packages/server`, `packages/zcode-server-cli`, `packages/desktop`, `packages/services`, `packages/ui`, `packages/client`; `@zcode/client` — `packages/desktop`, `packages/server`, `packages/web`; `@zcode/shared` — почти все пакеты и `apps/zcode-cli/packages/*`.

Архитектура RPC по документации и коду: Layer 0 foundation → Layer 1 serialization → Layer 2 `IMessagePassingProtocol` → Layer 3 ChannelServer/ChannelClient → Layer 4 IPCServer/IPCClient → Layer 5 ProxyChannel → Layer 6 Remote (`packages/rpc/src/index.ts:1-29`, `docs/architecture/rpc.md:5-35`). **[Observed]**

### 3.2. RPC framework: что реально реализовано

**Транспорты.**
- `IMessagePassingProtocol` — только `send(buffer)`, `onMessage`, опциональный `drain()` (`protocol.ts:24-28`). `ConnectionFlowControl` — read-only `unacknowledgedBytes` + `onSaturated`/`onDrained` (`protocol.ts:35-39`).
- `MessagePortProtocol` — неделимые сообщения, sideband flow-control объект `{__zcodeRpcControl:"connection-flow-v1", state}`; всё, что не `Uint8Array` и не валидный control-объект, отбрасывается (`protocol.ts:41-59, 362-398`).
- `SocketProtocol` — 13-байтовый заголовок `type(1)|id(4)|ack(4)|length(4)` поверх `ChunkStream`, обрабатывает TCP-фрагментацию/склейку (`protocol.ts:86-178, 196-231, 237-308`). Ждёт полный кадр перед потреблением заголовка (`:274-278`); кадры не-Regular типов молча игнорирует (`:294-297`).
- `PersistentProtocol` — ACK/replay/keepalive: KeepAlive каждые 5 с (`persistent-protocol.ts:77`), ACK timeout 20 с (`:81`), watermarks по умолчанию 1 MiB / 256 KiB (`:92-94`), replay buffer 8 MiB / 45 с (`:95-96`). При переполнении replay-буфера отправляет `Disconnect` и закрывает сессию (`:123-143, 240-249`). `replaceSocket()` перепривязывает socket и заново пишет все unacked сообщения (`:149-160`).
- `RemoteAgentConnection` — resolver → socket factory → PersistentProtocol → IPCClient → auto-reconnect с задержками `[0,5,5,10,10,10,10,10,30]` секунд (`remote.ts:247, 279-322`).
- `createQueuePair()` — in-memory пара для тестов (`protocol.ts:319-340`).

**Request/response, routing, cancellation.**
- Типы запросов: `Promise=100`, `PromiseCancel=101`, `EventListen=102`, `EventDispose=103`; ответов: `Initialize=200`, `PromiseSuccess=201`, `PromiseError=202`, `PromiseErrorObj=203`, `EventFire=204` (`channels.shared.ts:18-31`).
- `ChannelServer` умеет `deferInit` и `ready()` — фикс гонки «Initialize отправлен раньше регистрации channel» (`channelServer.ts:22-36`, история: `docs/architecture/rpc-channel-init-timing.md:74-112`). Неизвестный channel ставится в pending с таймаутом по умолчанию 1000 мс (`channelServer.ts:25, 231-255`).
- `ChannelClient` держит запросы до `Initialize` (state machine `Uninitialized→Idle`, `channelClient.ts:14-17, 124-128, 243-248`), поддерживает отмену через `CancellationToken` (`:130-138`), при `dispose(reason)` reject-ит все pending, включая ещё не отправленные (`:250-275`).
- `IPCServer` 1:N: первый кадр соединения — ctx, на каждое соединение создаются ChannelServer+ChannelClient, есть reverse RPC через router/filter и multicast событий (`ipc.ts:95-148, 157-245`). `IPCClient` 1:1 двунаправленный (`ipc.ts:280-308`). `StaticRouter` рекурсивно ждёт новое соединение (`ipc.ts:318-339`).
- `ProxyChannel.fromService`/`toService` — автоматическое отображение методов и событий по именам `onXxx`/`onDynamicXxx` (`proxy-channel.ts:37-147, 154-172`); события буферизуются до первого подписчика (`:178-213`).

**Errors, middleware.**
- Обе стороны сохраняют `name/message/stack` и 10 структурированных полей: `code, kind, status, retryAfterMs, data, detail, details, taskId, traceId, retryable` (`channelServer.ts:136-178`, `channelClient.ts:83-111`). Есть тест на полный passthrough (`packages/rpc/test/channels.test.ts:190-253`).
- `LoggingChannelServer/Client` и `NetworkTelemetryChannelServer/Client` — декораторы без изменения wire (`logging-middleware.ts:79-157`, `network-telemetry-middleware.ts:73+`).
- Backpressure/flow-control: `PersistentProtocol` и acknowledged mobile adapter отдают события `onSaturated`/`onDrained`; sideband `MessagePortProtocol.sendFlowState` (`protocol.ts:388-390`) доходит до `v4/connection/flow` (`transport.ts:401-412`, `docs/v4-refactor/05-transport-and-backpressure.md:343-385`).

**Serialization.**
- Тип-теги: Undefined 0, String 1, Buffer 2, VSBuffer 3, Array 4, Object(JSON) 5, Int(VQL) 6 (`serialization.ts:109-117`); VQL 7-битное кодирование (`:67-103`).
- Вложенные `Uint8Array` внутри Object кодируются маркером `__zcode_rpc_nested_uint8array_v1` + base64 и восстанавливаются (`serialization.ts:136-137, 183-187, 220-250`); есть тест roundtrip (`packages/rpc/test/proxy-channel.test.ts:125-153`).

### 3.3. Protocol v1 и V4

**V1 (`packages/shared/src/zcode-protocol/index.ts`).**
- Константы: `ZCODE_PROTOCOL_NAME`, `ZCODE_PROTOCOL_VERSION = 1`, `ZCODE_PROTOCOL_V4_WIRE_VERSION = 3` (`:134-137`); `zcodeRuntimeCapabilitiesSchema` (`:138-141`); код ошибки `sessionUnavailable = -32004` (`:142-144`).
- Конверт: strict request `{id, method, params?, trace?}`, notification `{method, params?, trace?}`, response `{id, result}`, error `{id, error:{code,message,data?}}` и union `zcodeProtocolMessageSchema` (`:425-472`). `params`/`result` — `z.unknown()`, т.е. per-method валидация вынесена наружу.
- `zcodeProtocolMethods` — 104 записи (`:4602-4739`); таблица `zcodeProtocolSessionMethodContracts` — только 23 метода (`:4747+`, подсчёт по regex внутри диапазона).
- Отдельные строгие контракты: MCP UI, browser-use, topic resource relay с `sha256:` checksum и chunk 384 KiB (`:388-423`), attachment/telemetry и т.д.
- `zcodeWorkspaceRefSchema` — strict `{workspacePath, workspaceIdentity?, remoteSessionId?, workspaceKey}` (`zcode-protocol-legacy-types.ts:36-43`).

**V4 (`packages/shared/src/zcode-protocol-v4/`).**
- Версия wire `V4_WIRE_PROTOCOL_VERSION = 3` (`core.ts:7`), независимая от `protocolVersion=1` projection snapshot (тот же комментарий; тест `zcodeProtocolV4Wire.test.ts:172-196`).
- Лимиты (`core.ts:64-100`): maxFrameBytes 1 MiB, assembly 16 MiB, 1024 fragment, 32 concurrent, 32 MiB staged, 30 с timeout, 200 rows/range, attachment 20 MiB / chunk 512 KiB, upload 64 chunks / 64 MiB staged.
- Delivery profiles continuous/replayable (`core.ts:34-59`).
- `TopicWireFrame` — `complete`/`fragment`, checksum crc32, `deliveryKind: initial|online|recovery` (`wire.ts:7-43`).
- Двухуровневая валидация: `topicWireFrameCandidateSchema` намеренно проверяет только outer routing-поля и `passthrough`, inner payload остаётся `unknown`, чтобы фаулт возник в owned assembler (`wire.ts:45-82`); полная strict-схема с cross-field refine — `createTopicWireFrameSchema` (`wire.ts:85-158`).
- Encoder меряет реальный envelope по трём носителям: CLI NDJSON, Channel/Socket binary (+13 байт), mobile relay base64 (`wire-codec.ts:25-77`); фрагментация бинарным поиском бюджета, fail-closed при переполнении (`:169-240`).
- Reassembly/assembler: все проверки до публикации — метаданные, base64, дубликаты, cumulative bytes, CRC32, fatal UTF-8, JSON, envelope match, schema; ordinal tombstones (`wire-reassembly.ts:31-207`, `wire-assembler.ts:144-330, 461`).
- Fault-модель: `proto.frameAssemblyInvalidPayload` — детерминированный content-fault, остальные (timeout/gap/CRC) — транзиентные; отдельный terminal code `fault.subscription.contentRejected` (`wire-fault.ts:16-42`).
- Handshake: strict `hello` с проверкой соответствия `clientMode↔deliveryProfile` (`transport.ts:42-66`); `clientHello` с optional capabilities и **явным предупреждением**, что `.strict()` на capabilities ломает handshake со старым Host при неизвестном ключе (`transport.ts:69-92`); capability helpers (`:94-108`).
- Subscribe/resync: `SubscribeParams` с `base{logEpoch,seq}`, `visibility`, `retryInitialization` (`transport.ts:111-123`); ACK `{subscriptionId, mode, logEpoch}` (`:125-131`); строгий ACK-only ответ на subscribe (`:453-458`).
- Commands: `commandEnvelopeSchema` (`commandId/clientId/sessionId/baseRevision/baseLogEpoch/type/payload/issuedAt`) и `parseCommandEnvelope` с payload-schema по типу и CAS-требованиями (`command.ts:471-508`).
- Apply: immutable и mutable twins; `state.updated` — `Object.assign`/spread, без deep merge; неизвестные ключи нового состояния отбрасываются схемой (комментарий `delta.ts:57-59`), что даёт мягкую совместимость.

**Runtime validation sites (Observed).**
- CLI bootstrap читает NDJSON, `JSON.parse` → `zcodeProtocolMessageSchema.safeParse`; невалидный конверт → JSON-RPC `-32600` с issues и продолжение работы (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/transport.ts:267-291`).
- Dispatch: ≈111 `case` в `server.ts:695-1009`; неизвестный метод → `-32601` (`:1008`); неизвестное notification логируется и игнорируется (`:662-666`); `parseParams` маппит zod-ошибку в `-32602` с полями (`server-types.ts:224-255`).
- V4 gateway валидирует параметры `.parse()` почти на каждом методе (`v4-gateway.ts:775, 1289, 1297, 1628, 1721, 2075, 2124, 2548+`).
- Host-сторона stdio (`packages/services/src/zcode-agent/zcodeStdioTransport.ts:256-270`) при **любой** ошибке parse/envelope делает `fireClose({reason: protocol_parse_error})` — закрывает весь транспорт, в отличие от CLI.
- Host принимает V4-кадры через candidate schemas и при невалидном inner payload пишет warn и дропает кадр (`packages/services/src/zcode-agent/zcodeAgentService.ts:2690-2739`).

### 3.4. Shared platform и identity

- `IPlatformService` — `platform.ts:683-1229` (547 строк файла; 545 строк тела): 133 сигнатуры методов и 4 свойства (точный regex-подсчёт по телу интерфейса), десятки опциональных desktop-only возможностей (`pluginSandbox`, `selectDirectories`, `saveFile`, `printPageToPdf`, `createLocalMediaPreviewUrl`, `materializeWorkflowArtifactFile` и т.д.). Платформенные отличия выражаются опциональностью и документированными fallback-ами, а не runtime-детектом в UI (`platform.ts:683-748`).
- Remote-часть платформы: `connectRemote(options, requestId, context{workspacePath, workspaceIdentity, …})` (`:762-784`), `requestSourceSettingsAttachment` (`:786-787`), `bindRemoteWorkspaceSessionContext` (`:792-795`), события `onRemoteConnectionLog`/`onRemoteSessionClosed`/`onRemoteSessionReconnected` (`:750-757`).
- `RemoteSessionClosedEvent` несёт recoverable/recoveryAttempt/recoveryLimit/recoveryBudgetExhausted/reasonCode/retryable (`:476-489`); `RemoteSessionReconnectedEvent` — `previousSessionId`, `sessionId`, `workspacePath`, `workspaceIdentity` (`:491-496`). `BindRemoteWorkspaceSessionContextRequest` требует `remoteSessionId` + `workspacePath`, identity опциональна (`:601-606`).
- Identity-конструкты централизованы: `remote-workspace-identity.ts` описывает формат `remote:ssh:<host>:<port>:<username>:<posixPath>`, `remote:wsl:<distro>[:<user>]:<path>`, `remote:docker:<container>:<path>`, `remote:server:<serverId>:<path>` (`:1-13`); builder (`:74-106`), parser (`:113-155`), host-id (`:163-174`). Нормализация пути (`:39-43`); serverId нормализация (`:57-67`); WSL legacy/user disambiguation по ведущему `/` (`:140-149`).
- `workspaceKey = workspaceIdentity?.trim() || workspacePath` реализован как минимум в `task-realtime-core.ts:84-89` и `web-remote-control.ts:744-748`; закреплён в `docs/zcode-protocol.md:97-113` и `docs/agent-next-steps.md:28`.
- Bridgeability: remote workspace допускается к mobile bridge только при наличии и `workspaceIdentity`, и `remoteSessionId` (`web-remote-control.ts:750-756`); controller-адрес требует identity, если задан remoteSessionId (`controller.ts:17-34`).
- Валидация внешних relay payload: `webRemoteControlWorkspaceTargetSchema` (`validation.ts:83-92`), `webRemoteControlAppPayloadSchema` (`:421-426`), transport-frame/ACK strict schemas (`web-remote-control-rpc-transport.ts:10-143`).

### 3.5. Client SDK

- Публичный API (`client/src/index.ts:1-17`): `RemoteServiceAccess`, `connectViaProtocol`, `connectViaWebSocket`, `connectViaMessagePort`, `createMessagePortServiceConnection`, acknowledged/legacy relay protocols, payload serializer.
- `RemoteServiceAccess` — 58 вызовов `ProxyChannel.toService` в одном конструкторе (`remoteServiceAccess.ts:134-338`); опциональные способности создаются только при явном opt-in: `sourceServerManagementService` (`:240-246`), `codeIntelligenceService` (`:304-311`), `openCodeAcpRuntime` (`:312-316`), `windowProjectDirectory` (`:144-156`). Комментарий фиксирует причину: ленивый Proxy «врёт» о наличии channel (`:240-241`).
- `connectViaWebSocket` — только установка соединения: browser WS → `SocketProtocol` → `ChannelClient` → `RemoteServiceAccess`; до open — reject, после — никакого reconnect/retry (`websocket.ts:62-108`). `write` молча ничего не делает, если `readyState !== OPEN` (`:45-49`). Auth в пакете отсутствует: заголовки/токен задаёт вызывающая сторона (пример: desktop `serverRemoteConnection.ts:218-221, 266-270`).
- `createMessagePortServiceConnection` — явный lifecycle: `dispose(reason)` сначала reject-ит pending RPC через `ChannelClient.dispose(reason)`, затем `protocol.disconnect()` (`messageport.ts:25-54`).
- Legacy relay adapter (`createWebRemoteControlRelayProtocol`) — base64-кадры, seq-гейтинг, degrade при gap, буфер 50 кадров / 5 с (`webRemoteControlRelayProtocol.ts:52-220`).
- Acknowledged adapter (`createAcknowledgedWebRemoteControlRelayProtocol`) — дефолтные лимиты 1 MiB high / 256 KiB low, 8 MiB replay, 45 с grace, 30 с assembly (`webRemoteControlAcknowledgedRelayProtocolTypes.ts:10-16`); admission целой batch до первой отправки, cumulative ACK, сериализованный flush, детект gap/identity/CRC/timeout (`webRemoteControlAcknowledgedRelayProtocol.ts:29-385`). Production-потребители: `packages/desktop/src/main/webRemoteControlManager.ts:1061`, `packages/web/src/main.tsx:1693`.
- Публичного README/API-документа в `packages/client` или `packages/rpc` нет; гарантии совместимости и reconnect-политика в коде не задекларированы.

## 4. Gaps, risks, weaknesses

### 4.1. Надёжный слой не развёрнут в production

**[Observed]** `PersistentProtocol` создаётся только в `remote.ts:288` и в тестах; `RemoteAgentConnection` не используется в production-коде и даже не инстанцируется в `packages/rpc/examples/04-remote-connection.ts`; `rg "new RemoteAgentConnection|RemoteAuthorityResolverService|createURITransformer"` даёт только `docs/architecture/rpc.md` и сам `remote.ts` (`resolverService`/`socketFactory` там лишь регистрируются в примере: `examples/04-remote-connection.ts:210-214`). Production-транспорты используют `SocketProtocol` напрямую: `packages/server/src/http.ts:97`, `packages/server/src/stdio.ts:68`, `packages/server/src/remote/connect.ts:229`, `packages/zcode-server-cli/src/server-core/http.ts:111`, `packages/desktop/src/host/serverRemoteConnection.ts:188`, `packages/client/src/websocket.ts:97`.
**[Observed]** Это независимо подтверждено design-review: «PersistentProtocol 零生产部署» (`docs/v4-refactor/design-review.md:41`), и план удаления прямо говорит, что `@zcode/rpc` надо «productionize» двумя патчами (`docs/v4-refactor/11-deletion-plan.md:154`).
**[Inference]** Заявленные ACK/replay/keepalive не защищают реальные SSH/WSL/Docker/WebSocket-линки; надёжность на mobile обеспечивает отдельный acknowledged relay adapter, а desktop/stdio — никто.

### 4.2. Нет дедупликации на приёмнике и нет серверной половины reconnect

**[Observed]** `PersistentProtocol.readMessages` обрабатывает `ack`, затем `Regular` безусловно вызывает `_onMessage.fire(body)` (`persistent-protocol.ts:203-207`); сравнения `id <= incomingAckId` нет. `replaceSocket` есть только на клиенте (`:149-160`).
**[Observed]** `ReplayRequest=6`, `Pause=7`, `Resume=8` объявлены в enum (`protocol.ts:203-205`), но в switch `PersistentProtocol` отсутствуют (`persistent-protocol.ts:203-217`).
**[Observed]** design-review фиксирует: «收端无去重», «服务端无新 socket 绑回旧协议实例», ACK только с KeepAlive, «0.5 层可靠性» (`docs/v4-refactor/design-review.md:41`), и требует dedupe + session registry + reconnect token (`:60`).
**[Inference]** При включении replay-пути дубликаты сообщений будут доставлены повторно; сервер не сможет восстановить сессию после смены socket.

### 4.3. Нет верхней границы длины кадра на RPC-уровне

**[Observed]** `SocketProtocol.readMessages` и `PersistentProtocol.readMessages` читают 32-битный `length` из заголовка и ждут полный кадр без проверки максимума (`protocol.ts:271-278`, `persistent-protocol.ts:180-198`). Ограничение физического кадра 1 MiB есть только в V4-слое: на отправке — `wire-codec.ts:173-177` (`core.ts:65`), на приёме — в assembler (`wire-assembler.ts:267, 306`); в raw Channel RPC такого ограничения нет.
**[Observed probe]** Кадр с заголовком, заявляющим 512 MiB payload, был принят в `ChunkStream` без отказа: `buffered bytes (still no delivery): 13 | unack: 0`; предела на `length` нет, поэтому буфер будет расти до полного кадра (или до исчерпания памяти), а не будет отвергнут.
**[Inference]** Любой WS/stdio-пир может удерживать память пропорционально заявленному `length`; для relay-цепочки это усиливается base64.

### 4.4. Malformed RPC-кадр приводит к необработанному исключению

**[Observed probe]** Кадр с неизвестным тегом заголовка (99) прошёл `deserialize` как `undefined`, после чего `ChannelServer.onRawMessage` упал с `TypeError: Cannot read properties of undefined (reading '0')`; исключение не поймано (`channelServer.ts:68-98` не оборачивает разбор в try/catch).
**[Observed]** `deserialize` при неизвестном теге возвращает `undefined` без throw (`serialization.ts:193-218`), а `onRawMessage` делает `header[0]` (`channelServer.ts:72`).
**[Inference]** Битый или враждебный кадр на Channel-соединении может уронить процесс (Node default uncaughtException), а не только закрыть соединение.

### 4.5. Утечка pending-состояния при ошибке сериализации

**[Observed]** В `ChannelClient.sendRequest` вызов `serialize(writer, …)` стоит **до** `try { this.protocol.send(...) }` (`channelClient.ts:186-193`); `doRequest` не ловит исключение. Promise reject-ится (throw внутри executor), но `handlers` и `pendingRejections` уже заполнены (`:120-121`).
**[Observed probe]** После вызова с circular-объектом: `handlers size after serialize failure: 1`, `pendingRejections size: 1`; после BigInt: `handlers size after bigint: 2 pendingRejections: 2`.
**[Inference]** Каждый неудачный вызов с несериализуемым аргументом оставляет запись навсегда; на длинной сессии это утечка памяти и ложные записи в maps.

### 4.6. Сериализатор lossy и лоялен к мусору

**[Observed probe]** `-1 => -1` (VQL-путь, целые в диапазоне 32-бит), `2^31 => 2147483648` и `2^32 => 4294967296` (JSON fallback, значения сохраняются); при этом `NaN => null`, `Infinity => null`, `Date => "1970-01-01T00:00:00.000Z"`, `Map => {}`, `undefined` в массиве `=> null`, sparse array `=> length 2`; truncated buffer `"hello"` → `"he"` без ошибки; unknown tag → `undefined`.
**[Inference]** Контракт сериализации фактически «best effort JSON»: типы вне VQL/JSON молча деградируют, а не отвергаются. Для RPC, где обе стороны — TS, это скрывает ошибки типов до момента, когда данные уже ушли.

### 4.7. ProxyChannel открывает prototype-chain и произвольные свойства

**[Observed probe]** `fromService({hidden, onDidThing})` позволяет `call("hidden")` → `"secret"`, `call("constructor")` и `call("toString")` резолвятся через prototype chain и возвращают Promise (Object constructor / строковое представление). Код использует `handler[command]` и `typeof target === "function"` без `hasOwnProperty` (`proxy-channel.ts:85-95`).
**[Inference]** Контракт «экспонируются только методы сервиса» не enforced; любой унаследованный член объекта доступен как RPC-команда. Практический вред ограничен тем, что JSON-сериализация выкидывает функции, но поведение не предназначено и не тестируется.

### 4.8. Схемная совместимость и асимметричная политика ошибок

**[Observed]** Из 104 методов v1 только 23 имеют типизированный контракт params/result (`zcode-protocol/index.ts:4747+`); dispatch содержит ~111 case (`server.ts:695-1009`), при этом `parseParams` в `server.ts` вызывается только 2 раза, в `server-operations.ts` — 22 раза. Остальные методы валидируются ad-hoc или полагаются на типы.
**[Observed]** `clientHello.capabilities` — `.strict()`; комментарий прямо предупреждает, что старый Host не должен видеть новый ключ, иначе весь clientHello не распарсится и handshake не состоится (`transport.ts:80-89`). `hello.protocolVersion` — литерал 3 (`:45`), тест подтверждает жёсткий отказ версии 1 (`zcodeProtocolV4Wire.test.ts:172-209`).
**[Observed]** CLI при плохом конверте отвечает `-32600` и продолжает (`bootstrap/.../transport.ts:282-290`); Host при плохом конверте закрывает транспорт (`zcodeStdioTransport.ts:256-270`).
**[Inference]** Один и тот же «неизвестный/лишний ключ» имеет разную судьбу в зависимости от стороны и слоя: от мягкого warn/drop до полного разрыва Agent-сессии. Это главный операционный риск version skew.

### 4.9. Client SDK не даёт гарантий reconnect/retry/auth/cancellation

**[Observed]** `connectViaWebSocket` не переподключается и не ретраит (`websocket.ts:62-100`); `write` при закрытом сокете — no-op (`:45-49`); в `packages/web/src/main.tsx:2068-2070` `onClose` — пустой обработчик. В `packages/client` нет reconnect-кода (`rg "reconnect|retry|backoff" client/src` — пусто). Отмена возможна только если вызывающий сам передаст `CancellationToken` (единственный production-потребитель — `services/src/zcode-agent/topicResourceRelayClient.ts:18-55`).
**[Inference]** Гарантии соединения делегированы вызывающим (desktop Host, mobile relay, web bootstrap), но это нигде не задекларировано как контракт SDK; новый потребитель легко получит «висящие» RPC после close.

### 4.10. Тестовые пробелы

**[Observed]** `packages/rpc/test` не содержит ни одного теста для `remote.ts` (`rg` по `RemoteAgentConnection|RemoteAuthorityResolverService|createURITransformer` в тестах — пусто), нет тестов `replaceSocket`, dedupe, oversize-кадра, malformed-заголовка, явного ACK-cadence, backpressure на SocketProtocol. Есть только: ChunkStream, PersistentProtocol watermarks/replay bounds, queue pair, MessagePort sideband, channels, ipc, proxy, serialization, buffer, foundation, logging middleware (`packages/rpc/test/*.test.ts`, 71 тест).
**[Observed]** `packages/client/src/remoteServiceAccess.sampling.test.ts` не собирается root-конфигом: `vitest run packages/client/src/remoteServiceAccess.sampling.test.ts` → `No test files found` (include: `packages/*/test/**/*.test.ts` и `packages/*/src/**/contract.test.ts`, `vitest.config.ts:113-122`). Это «мертвый» тест.
**[Observed]** Fuzz/property-based testing отсутствует: `fast-check` не найден ни в manifest, ни в исходниках; комментарий `workflow-runs-delta.ts:17` говорит «被 property 测试钉住», но grep не находит property-генераторов — только детерминированные циклы и фикстуры.
**[Observed]** V4-домен покрыт хорошо: 31 файл `zcodeProtocolV4*.test.ts`, ≥539 `it()`; golden-границы 1 MiB−1/1 MiB/1 MiB+1, UTF-8 split, reorder/dup/missing/checksum, 16 MiB и 16 MiB+1 (`zcodeProtocolV4Wire.test.ts:340-522`), mobile raw 64/65 фрагментов и 30 с timeout (`webRemoteControlRpcTransport.test.ts:61-574`).

## 5. Strengths and differentiators

1. **Чистая слоистость и транспортная независимость.** Верхние слои видят только `send/onMessage`; один и тот же Channel RPC работает поверх MessagePort, stdio, WebSocket (`rpc/src/index.ts:4-28`, `docs/architecture/rpc.md:35, 165-170`). Это позволяет добавлять транспорт без переписывания протокола.
2. **Детерминированная физическая упаковка V4.** Метрика считает реальные три носителя (CLI NDJSON, Channel binary с 13-байтовым заголовком, mobile relay base64), а не «примерный JSON»; фрагментация подбирается бинарным поиском и fail-closed (`wire-codec.ts:25-77, 169-240`). Это редкая для IPC-фреймворков строгость.
3. **Атомарная сборка кадров.** До публикации проверяются длина, метаданные, base64, дубликаты, CRC32, UTF-8, JSON и schema; ordinal tombstone не даёт старым фрагментам «воскресить» состояние (`wire-assembler.ts:192-330`, `wire-reassembly.ts:31-207`).
4. **Typed fault-модель с разделением детерминированных и транзиентных ошибок.** `proto.frameAssemblyInvalidPayload` ведёт к немедленному `contentRejected`, а не к бесполезным re-subscribe (`wire-fault.ts:16-42`, `docs/v4-refactor/05:227-248`).
5. **Bounded replay и flow-control с реальными тестами.** Watermarks 1 MiB/256 KiB, replay 8 MiB/45 с, обязательный admission всех байт batch до первой отправки, cumulative ACK и reentrancy-тесты (`client/test/webRemoteControlRelayProtocol.test.ts:386-967`).
6. **Богатая ошибка end-to-end.** `name/message/stack` + 10 структурированных полей переживают RPC и проверены тестом (`channels.test.ts:190-253`).
7. **Строгие схемы там, где это критично.** V1 конверт strict; V4 domain — strict + `superRefine` cross-field (fragmentIndex<fragmentCount, checksum format, topic match), команды — закрытый union типов с payload-schema (`command.ts:471-508`).
8. **Централизованная identity.** `remote-workspace-identity.ts` — единственная точка построения/разбора authority; `resolveWorkspaceKey` и `workspaceIdentity?.trim() || workspacePath` зафиксированы кодом и документацией; WSL legacy-формат разбирается без миграции (`remote-workspace-identity.ts:113-155`).
9. **Явная capability-модель и изоляция scope.** `ServiceCollection.exposeOnChannelServer` принимает exposure policy (`services/src/collection.ts:34-47`), desktop применяет её по `clientMode` (`windowHostAttachmentRpcPolicy.ts:85-111`), `RemoteServiceAccess` создаёт опциональные прокси только по явному opt-in (`remoteServiceAccess.ts:144-156, 240-246, 304-316`).
10. **Объём и дисциплина V4-тестов.** Сотни golden/edge-тестов на coalesce, apply, workflow runs, wire, attachments; exact-boundary тесты — сильная страховка при изменениях формата.

## 6. Candidate recommendations

### R1. Ограничить длину кадра и обезопасить разбор на RPC-границе

- **Problem/gap:** `SocketProtocol`/`PersistentProtocol` принимают любой 32-битный `length` без верхней границы; malformed header приводит к uncaught TypeError.
- **ZCode evidence:** `packages/rpc/src/protocol.ts:274-278` (ожидание полного кадра), `packages/rpc/src/persistent-protocol.ts:180-198`, `packages/rpc/src/channelServer.ts:68-98` (нет try/catch), probe: 512 MiB header принят, unknown tag → `TypeError: Cannot read properties of undefined (reading '0')`.
- **Proposed solution:** добавить `maxFrameBytes` в `PersistentProtocolOptions`/`SocketProtocol` (default согласовать с реальными payload-бюджетами, напр. 1 MiB для relay, настраиваемо выше для stdio), при превышении — typed close reason и уничтожение соединения; обернуть `onRawMessage`/`onMessage` в try/catch → protocol error response или close; добавить тесты на 1 MiB−1/1 MiB/1 MiB+1 и на неизвестный тег/truncated payload.
- **Scope:** rpc transport + channel server. **Out of scope:** изменение 13-байтового формата заголовка, V4 wire-лимиты.
- **Expected effect:** устранение memory-DoS и падения процесса от одного битого кадра.
- **Risks:** легитимные крупные Channel-payload (медиа, большие snapshot) могут превысить дефолт; нужен per-transport конфиг и явный список крупных методов (напр. `file.readMediaPreview` до 8 MiB, `services/src/file/fileService.ts:35`).
- **Complexity:** M. **Priority:** P0.
- **Acceptance criteria:** неизвестный тег не роняет процесс; кадр сверх лимита закрывает соединение с typed reason; существующие 71 rpc-тест и все Channel-потребители проходят.
- **Verification:** новые unit-тесты в `packages/rpc/test/protocol.test.ts`/`channels.test.ts`, интеграционный прогон `packages/zcode-server-cli/test/coreHttp.test.ts` и `packages/desktop/test/serverRemoteConnection.test.ts`.

### R2. Исправить утечку pending-состояния при ошибке сериализации

- **Problem/gap:** `serialize` вне try, при throw maps `handlers`/`pendingRejections` не очищаются.
- **ZCode evidence:** `packages/rpc/src/channelClient.ts:66-147, 186-193`; probe: handlers 1→2 после circular/BigInt.
- **Proposed solution:** обернуть serialize+send в try/catch внутри `doRequest`; при ошибке удалить `handlers`/`pendingRejections`, reject-ить типизированной ошибкой (`SerializationError`), не отправлять запрос; аналогично защитить `sendCancelOrDispose`.
- **Scope:** `channelClient.ts` + тест. **Out of scope:** изменение формата сериализации.
- **Expected effect:** отсутствие утечки на каждый несериализуемый аргумент; предсказуемая ошибка вместо «висящего» handler.
- **Risks:** низкие; поведение reject не меняется.
- **Complexity:** S. **Priority:** P1.
- **Acceptance criteria:** после reject по circular/BigInt `handlers.size === 0` и `pendingRejections.size === 0`; существующие тесты отмены/диспоуза проходят.
- **Verification:** regression-тест в `packages/rpc/test/channels.test.ts` с проверкой внутренних map через test-only seam (или поведенческий тест «повторный вызов после ошибки работает»).

### R3. Унифицировать политику malformed/unknown сообщений между CLI и Host

- **Problem/gap:** CLI отвечает `-32600` и продолжает, Host закрывает весь stdio-транспорт при любой ошибке parse/envelope.
- **ZCode evidence:** `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/transport.ts:267-291`; `packages/services/src/zcode-agent/zcodeStdioTransport.ts:256-270`; unknown method: `bootstrap/src/zcode-protocol/server.ts:1008`; unknown notification: `:662-666`.
- **Proposed solution:** разделить классы ошибок: (a) JSON/фрейминг/конверт невалиден → close с typed reason; (b) неизвестный method → `-32601` без закрытия; (c) невалидные params известного method → `-32602` без закрытия; (d) неизвестные поля в optional-расширяемых объектах → strip по схеме, не reject. Зафиксировать политику в shared-документе и тестах.
- **Scope:** CLI bootstrap transport, services stdio transport, shared protocol docs. **Out of scope:** изменение набора методов.
- **Expected effect:** version skew не убивает сессию из-за одного нового поля; при этом порча потока по-прежнему fail-closed.
- **Risks:** ослабление fail-closed на security-границе; компенсировать явным перечнем «fatal envelope errors».
- **Complexity:** S/M. **Priority:** P0.
- **Acceptance criteria:** тест «неизвестный method → -32601, транспорт жив»; тест «битый JSON → close»; тест «лишнее поле в params не закрывает сессию»; обе стороны ведут себя одинаково.
- **Verification:** unit-тесты в `packages/services/test/zcodeStdioTransport.test.ts` и bootstrap-тестах; прогон узкого набора без E2E.

### R4. Ограничить ProxyChannel-owned поверхностью и запретить prototype-chain команды

- **Problem/gap:** `handler[command]` резолвит унаследованные члены; `constructor`/`toString` доступны как RPC.
- **ZCode evidence:** `packages/rpc/src/proxy-channel.ts:85-95`; probe: `hidden` → `"secret"`, `constructor`/`toString` → Promise.
- **Proposed solution:** использовать `Object.prototype.hasOwnProperty.call(handler, command)`; запретить `__proto__`, `constructor`, `prototype`, `then`; опционально — allowlist методов при `fromService`; тест на прототипные имена и на штатные методы/события.
- **Scope:** `proxy-channel.ts` + тесты + все сервисы (поведение должно сохраниться). **Out of scope:** изменение naming convention `onXxx`/`onDynamicXxx`.
- **Expected effect:** поверхность RPC равна объявленному сервису; исчезает неявный доступ к Object.prototype.
- **Risks:** если какой-то сервис полагался на унаследованный метод (маловероятно), он сломается; проверить `rg` по `fromService`.
- **Complexity:** S. **Priority:** P1.
- **Acceptance criteria:** `call("constructor")`/`call("toString")` отклоняются; все 9 proxy-тестов и сервисные каналы проходят.
- **Verification:** `packages/rpc/test/proxy-channel.test.ts` + smoke-прогон `RemoteServiceAccess` тестов.

### R5. Свести per-method схемы в единый реестр и измерять покрытие валидации

- **Problem/gap:** 104 метода, 23 типизированных контракта, ~111 dispatch case, валидация размазана и частична.
- **ZCode evidence:** `packages/shared/src/zcode-protocol/index.ts:4602-4739` (104), `:4747+` (23); `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts:695-1009` (111 case, 2 `parseParams`); `server-operations.ts` (22 `parseParams`).
- **Proposed solution:** единая таблица `method → {paramsSchema, resultSchema}`, используемая CLI dispatch и Host-клиентом; CI-проверка, что каждый метод из `zcodeProtocolMethods` либо имеет схему, либо помечен `unvalidated(reason)`; для V4 — аналогично из `V4_METHODS`.
- **Scope:** shared protocol registry, CLI dispatch, services client. **Out of scope:** переписывание бизнес-логики методов.
- **Expected effect:** unknown/invalid params ловятся на границе, а не в глубине; видимая метрика покрытия вместо иллюзии типов.
- **Risks:** большой механический объём; риск сломать «мягкие» legacy-контракты; внедрять поэтапно с allowlist.
- **Complexity:** L. **Priority:** P1.
- **Acceptance criteria:** реестр покрывает 100% методов или явно помеченные исключения; CI падает при добавлении метода без записи; тест перечисляет таблицу.
- **Verification:** unit-тест реестра + `pnpm typecheck`/`pnpm lint` на затронутых пакетах (в этом исследовании не запускались).

### R6. Задокументировать/добавить контракт reconnect, auth и cancellation в client SDK

- **Problem/gap:** SDK не переподключается, не ретраит, не аутентифицируется; `write` молча теряет данные при закрытом сокете; `onClose` у web-входа пустой.
- **ZCode evidence:** `packages/client/src/websocket.ts:45-49, 62-100`; `packages/web/src/main.tsx:2068-2070`; `rg reconnect|retry|backoff` в `client/src` — пусто; `messageport.ts:25-54` (только dispose).
- **Proposed solution:** минимальный контракт: `connectViaWebSocket` возвращает handle с `onClose(reason)`, `reconnect()`/`dispose()`, `isClosed`; pending RPC reject-ятся при close (сейчас `ChannelClient` не связан с `ws.onClose`); README с матрицей «кто владеет reconnect» (desktop Host / mobile relay / web bootstrap). Auth оставить вызывающей стороне, но задокументировать обязательные заголовки и запрет логирования токена.
- **Scope:** `packages/client`, docs. **Out of scope:** реализация reconnect-политики внутри SDK (её владелец — Host/relay).
- **Expected effect:** предсказуемое поведение при обрыве, отсутствие «вечных» pending, ясные границы ответственности.
- **Risks:** двойной reconnect (SDK + relay); поэтому только handle/контракт, без встроенного backoff.
- **Complexity:** M. **Priority:** P1.
- **Acceptance criteria:** close WS → все pending reject с typed reason; повторный `reconnect()` создаёт новый ChannelClient; README содержит матрицу владельцев; тест на close→reject.
- **Verification:** unit-тест `packages/client/test/websocket.test.ts` (новый) + существующие relay-тесты.

### R7. Матрица совместимости hello/capabilities и version-skew тесты

- **Problem/gap:** handshake жёстко привязан к wire v3, capabilities strict в одну сторону; нет таблицы «capability → since version → кто объявляет».
- **ZCode evidence:** `packages/shared/src/zcode-protocol-v4/transport.ts:42-92` (strict + комментарий о поломке старого Host), `:94-108`; `zcodeProtocolV4Wire.test.ts:172-196` (только version literal).
- **Proposed solution:** реестр capability-битов с минимальными версиями и правилом объявления; table-driven тесты: old host + new client, new host + old client, отсутствие/наличие optional keys; для wire — явная политика «только hard cut v3» или dual-read.
- **Scope:** shared handshake schemas, tests, docs. **Out of scope:** реализация dual-read, если политика остаётся hard cut.
- **Expected effect:** предотвращение «неубиваемого» рассинхрона handshake при добавлении capability.
- **Risks:** добавление тестов не меняет поведение; реестр нужно поддерживать.
- **Complexity:** M. **Priority:** P2.
- **Acceptance criteria:** тесты покрывают оба направления skew; новый capability нельзя добавить без записи в реестр (CI-проверка).
- **Verification:** `packages/shared/test/zcodeProtocolV4Wire.test.ts` + новый `zcodeProtocolV4Compatibility.test.ts`.

### R8. Добавить property/fuzz-тесты на reassembly и десериализатор RPC

- **Problem/gap:** fuzz отсутствует; комментарий обещает property-тесты, которых нет.
- **ZCode evidence:** нет `fast-check` в manifest/исходниках; `packages/shared/src/zcode-protocol-v4/workflow-runs-delta.ts:17-19` заявляет property-контракт; ручные циклы в `zcodeProtocolV4WorkflowRunsDelta.test.ts:228, 319`.
- **Proposed solution:** `fast-check` для `reassembleTopicWireFrames`/`TopicWireFrameAssembler.accept` (произвольный порядок, дубликаты, порча base64/CRC/длины) и для `deserialize` (случайные усечения/теги); bounded runs (например 200 кейсов) в CI.
- **Scope:** тесты shared/rpc. **Out of scope:** изменение production-кода под fuzz.
- **Expected effect:** обнаружение crash/panic-путей до релиза; формальное подтверждение «никогда не публикуем частичный кадр».
- **Risks:** нестабильные/долгие CI-прогоны; фиксировать seed и лимит кейсов.
- **Complexity:** M. **Priority:** P2.
- **Acceptance criteria:** property-набор зелёный за <30 с; при порче любого байта нет частичной публикации; найденные баги закрыты или оформлены.
- **Verification:** новый `packages/shared/test/zcodeProtocolV4WireProperty.test.ts` + прогон `vitest run` по этому файлу.

### R9. Убрать/пометить мёртвый тест и зафиксировать тестовый контракт пакетов

- **Problem/gap:** `packages/client/src/remoteServiceAccess.sampling.test.ts` не собирается root-конфигом; `packages/rpc` имеет отдельный конфиг, но root-прогон подхватывает иначе; нет явного перечня «что считается unit-набором пакета».
- **ZCode evidence:** `vitest.config.ts:113-122`; прогон `vitest run packages/client/src/remoteServiceAccess.sampling.test.ts` → `No test files found`; `packages/rpc/vitest.config.ts:1-7`.
- **Proposed solution:** перенести тест в `packages/client/test/` или расширить include; добавить package-level script `test` для client; зафиксировать в docs/testing, какие наборы обязательны.
- **Scope:** тестовая конфигурация и один файл. **Out of scope:** переписывание тестов.
- **Expected effect:** исчезновение «мертвых» тестов, предсказуемый affected-прогон.
- **Risks:** минимальные.
- **Complexity:** S. **Priority:** P2.
- **Acceptance criteria:** тест собирается и проходит в root-прогоне; `pnpm test:unit:affected` его видит; docs обновлён.
- **Verification:** `vitest run packages/client/test/remoteServiceAccess.sampling.test.ts` (после переноса).

## 7. Open questions and unverified

1. **[Unknown]** Реальные payload-бюджеты raw Channel: какой максимальный размер сообщения фактически передаётся через MessagePort/WS в production (медиа, snapshot)? От этого зависит безопасный default `maxFrameBytes` в R1. Косвенно: `MAX_MEDIA_PREVIEW_BYTES = 8 MiB` (`services/src/file/fileService.ts:35`), `attachmentMaxBytes = 20 MiB` (`core.ts:84`), комментарий о 15 MB snapshot (`zcodeStdioTransport.ts:214-218`).
2. **[Unknown]** Кто и как сейчас восстанавливает desktop/stdio-соединение после обрыва, если `PersistentProtocol`/`RemoteAgentConnection` не используются? `rg` показывает только `SocketProtocol`; восстановление, вероятно, живёт в Host/Environment Registry, но в рамках Z06 это не проверено (вне scope пакетов).
3. **[Unknown]** Есть ли внешние (не workspace) потребители `@zcode/rpc` — публичный пакет с version 1.0.0, но без `publishConfig`/private. Не проверялись registry/релизные артефакты.
4. **[Unknown]** Точная семантика `Pause`/`Resume`/`ReplayRequest`: enum есть, обработчиков нет; возможно, зарезервированы под будущий протокол, но это не задекларировано.
5. **[Unknown]** Покрытие 81 «непокрытого» v1 метода: часть валидируется внутри handler-ов, которые я не открывал построчно; утверждение «только 23 из 104 имеют контракт» относится к таблице `zcodeProtocolSessionMethodContracts`, а не к фактической валидации в `server-operations.ts`.
6. **[Unknown]** SLO/поведение при переполнении replay-буфера на реальном mobile relay: тесты покрывают adapter, но не живой relay + desktop main + host attachment.
7. **[Unknown]** Совместимость старых клиентов с новыми необязательными полями V4 snapshot: часть схем не strict (комментарий `delta.ts:57-59`), но полный перечень «какие ключи старый клиент молча теряет» не составлялся.
8. **[Unknown]** `platform.ts` содержит платформенно-специфичные ветки (WSL/SSH/Docker/Server), но их runtime-реализации (desktop main, web stub, mobile) в Z06 детально не проверялись — только контракт и identity-правила.

## 8. Evidence appendix

### 8.1. Команды и результаты (Observed)

Методика подсчёта: «тесты» в таблицах — либо вывод vitest (фактический запуск), либо regex-подсчёт `^\s*(it|test)\(` по файлам; это разные метрики (например, `it.each` даёт одно вхождение в regex и N тестов в vitest), поэтому числа сопоставимы только внутри одного метода.

| Команда | Результат |
| --- | --- |
| `git status --short` | `?? docs/research/` |
| `git branch --show-current` | `dev` |
| `git log -1 --oneline` | `d10f0b69 Выпустить macOS Preview 3.17.102.` |
| `node scripts/check-workspace-freshness.mjs` | exit 0; «基线新鲜: dev, ahead 344 / behind 0» |
| `node --version` | `v26.9.0` |
| `CodeIndex status` | ready, partial=false, generation 1453; embedding unavailable → lexical |
| `cd packages/rpc && npx vitest run` | 8 files, **71 tests passed** (466 ms) |
| `vitest run <4 файла client/shared>` | 4 files, **67 tests passed** (client relay 28, remoteServiceAccess 6, v4 wire 16, rpc transport 17) |
| `vitest run packages/client/src/remoteServiceAccess.sampling.test.ts` | `No test files found`, exit 1 |
| `wc -l` | rpc/src 3300, rpc/test 1453, client/src (без тестов) 1967, client/test 1607, shared/src 55698, shared/test 35696 |
| `awk` по `zcodeProtocolMethods` | 104 записи (`index.ts:4602-4739`); 23 contract (`:4747+`); ≈111 dispatch case (`server.ts:695-1009`) |
| `rg -c '^\s*(it|test)\('` по 31 `zcodeProtocolV4*.test.ts` | 539 вхождений (широкий regex с `it.each` даёт 551; фактически выполнено vitest — см. точечные прогоны) |

### 8.2. Ad-hoc probes (Observed, не committed tests)

Все probes выполнялись через `./node_modules/.bin/tsx -e` на текущем рабочем дереве; они воспроизводят поведение исходников, но не являются регрессионными тестами.

1. **Serializer edge cases:**
   ```text
   negative -1 => -1
   2^31 => 2147483648
   2^32 => 4294967296
   truncated => he
   unknown tag => undefined
   NaN => null | Infinity => null
   Date => 1970-01-01T00:00:00.000Z
   Map => {}
   undefined-in-array => [null,1]
   ```
2. **ChannelClient serialization failure:** после circular-объекта `handlers size after serialize failure: 1`, `pendingRejections size: 1`; после BigInt — `handlers size after bigint: 2 pendingRejections: 2`.
3. **Malformed RPC frame (tag 99):** `uncaughtException from malformed RPC frame: TypeError Cannot read properties of undefined (reading '0')`.
4. **Frame length без upper bound:** заголовок с `length = 512 MiB` → `buffered bytes (still no delivery): 13 | unack: 0`, отказа нет.
5. **ProxyChannel prototype surface:** `call("hidden")` → `Promise { 'secret' }`; `call("constructor")` и `call("toString")` резолвятся (Promise).

### 8.3. Ключевые file:line

| Тема | Файл:строки |
| --- | --- |
| RPC-слои и экспорт | `packages/rpc/src/index.ts:1-132` |
| `IMessagePassingProtocol` / flow-control | `packages/rpc/src/protocol.ts:24-59` |
| Кадр 13 байт, `ChunkStream`, `SocketProtocol` | `packages/rpc/src/protocol.ts:86-308` |
| ACK/replay/keepalive | `packages/rpc/src/persistent-protocol.ts:46-296` |
| Каналы и типы сообщений | `packages/rpc/src/channels.shared.ts:18-67`; `channelClient.ts:54-275`; `channelServer.ts:13-285` |
| IPC 1:N / 1:1 | `packages/rpc/src/ipc.ts:95-339` |
| Remote/reconnect | `packages/rpc/src/remote.ts:98-329` |
| ProxyChannel | `packages/rpc/src/proxy-channel.ts:37-213` |
| Сериализация | `packages/rpc/src/serialization.ts:67-291` |
| V1 константы/конверт/methods/contracts | `packages/shared/src/zcode-protocol/index.ts:134-144, 425-472, 4602-4739, 4747+` |
| V1 workspace ref | `packages/shared/src/zcode-protocol-legacy-types.ts:36-43` |
| V4 limits/profiles | `packages/shared/src/zcode-protocol-v4/core.ts:7, 34-100` |
| V4 wire schema/codec/assembly | `wire.ts:7-158`; `wire-codec.ts:25-240`; `wire-reassembly.ts:31-207`; `wire-assembler.ts:144-330, 461` |
| V4 fault-модель | `packages/shared/src/zcode-protocol-v4/wire-fault.ts:16-42` |
| V4 handshake/subscribe/methods | `packages/shared/src/zcode-protocol-v4/transport.ts:23-131, 164-458` |
| V4 command envelope | `packages/shared/src/zcode-protocol-v4/command.ts:471-508` |
| Apply/delta | `apply.ts:67-219`; `delta.ts:41-64` |
| Runtime validation CLI | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/transport.ts:267-291`; `server.ts:695-1009`; `server-types.ts:224-255` |
| Runtime validation Host | `packages/services/src/zcode-agent/zcodeStdioTransport.ts:256-270`; `zcodeAgentService.ts:2690-2739`; `zcodeAgentConnectionScope.ts:208-231, 674-691` |
| Platform interface | `packages/shared/src/platform.ts:683-1229`; remote события `:476-496, 601-606, 762-795` |
| Identity | `packages/shared/src/remote-workspace-identity.ts:1-174`; `task-realtime-core.ts:84-89`; `web-remote-control.ts:744-756` |
| Client entrypoints | `packages/client/src/index.ts:1-17`; `websocket.ts:23-108`; `messageport.ts:25-71`; `remoteServiceAccess.ts:134-338` |
| Client relay | `webRemoteControlRelayProtocol.ts:52-220`; `webRemoteControlAcknowledgedRelayProtocol.ts:29-385`; `...Types.ts:10-16` |
| Docs (решения) | `docs/architecture/rpc.md:5-35, 165-170, 381-397, 450-457`; `docs/architecture/rpc-channel-init-timing.md:74-112`; `docs/zcode-protocol.md:28, 97-113`; `docs/v4-refactor/05:103-130, 150-248, 343-385, 413`; `docs/v4-refactor/design-review.md:41, 60`; `docs/v4-refactor/11-deletion-plan.md:154` |

### 8.4. Тесты: что покрыто и что нет

| Область | Покрыто | Не покрыто |
| --- | --- | --- |
| Serialization | roundtrip undefined/string/int/array/object/VSBuffer/Uint8Array/float/bool; nested Uint8Array через Proxy | отрицательные/большие int, NaN/Infinity, Date/Map, truncated, unknown tag |
| Transport framing | ChunkStream exact/partial/cross-chunk; fragmented RPC calls | oversize length, malformed header, unknown type tag |
| Backpressure/replay | watermarks, replay byte/grace overflow, disconnect | production-интеграция с real socket, dedupe, ACK cadence |
| Channels | call/errors/structured errors/listen/queue before channel/ctx/dispose/cancel? (cancel только foundation) | отмена in-flight на server, unknown channel timeout (явного теста нет) |
| IPC | server/client/reverse call/routing/multicast? (multicast не в 4 тестах) | reconnect, disconnect semantics |
| Remote | — | всё: `RemoteAgentConnection`, resolver, socket factory, URI transformer, `replaceSocket` |
| V1 protocol | 65 `it()` включая strict-схемы, version/method listing | все 104 метода, unknown-message policy, fuzz |
| V4 wire | 16 тестов: version, 1 MiB границы, UTF-8 split, reorder/dup/missing, checksum, 16 MiB | fuzz, zlib/binary frames (не реализованы) |
| V4 domain | 31 файл, 539 `it()` (regex-подсчёт): command, coalesce, apply, workflow runs, permissions, attachments | property-based (нет `fast-check`) |
| Mobile relay adapter | 28 тестов: ACK, replay, saturation, degrade, reentrancy, 64 fragments, 30 s | живой relay, desktop-main↔host-attachment интеграция |
| Client SDK | RemoteServiceAccess optional capabilities, relay, logging | websocket lifecycle/reconnect, messageport close→pending reject, auth |

**Coverage status: partial.**

Что не проверялось: полный `pnpm test`, `pnpm typecheck`, `pnpm lint`, E2E, desktop/Electron runtime, живой mobile relay, SSH/WSL/Docker-подключения, все 104 v1-метода построчно, все 133 метода `IPlatformService` в реализациях, публикация/внешние потребители `@zcode/rpc`. Часть выводов о поведении (утечка maps, prototype-доступ, отсутствие frame-cap) получена ad-hoc probes на текущем исходнике и должна быть подтверждена committed regression-тестами до трактовки как product-гарантии.

Подтверждение: изменён/создан только этот partial-файл; production-код, конфиги, lockfile и git-история не менялись.
