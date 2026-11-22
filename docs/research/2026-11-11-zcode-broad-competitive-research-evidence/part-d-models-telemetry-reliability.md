# BRANCH D — Models / providers / routing, telemetry / evals, performance / reliability, data / privacy

Evidence appendix for the broad competitive research pass. Research only: no production code, config,
dependency or lockfile was changed; no commits, no package installs, no dev servers.

Baseline recorded at start of work:

| Item | Value |
| --- | --- |
| Date (UTC) | `Wed Nov 11 06:08:06 UTC 2026` (`date -u`) |
| Branch | `dev` (`git rev-parse --abbrev-ref HEAD`) |
| HEAD | `d10f0b69f98677091e0428a92839e4a1e01e04ca` — `2026-11-10 21:15:50 +0300` "Выпустить macOS Preview 3.17.102." |
| Working tree | clean (`git status --porcelain` empty) |
| Skill loaded | `performance-tuning` (`<home>/Desktop/Zcode Preview.app/Contents/Resources/glm/packages/bundled-skills/skills/performance-tuning/SKILL.md`) |
| CodeIndex | `state: ready`, generation 1440, 10 007 files / 26 791 chunks / 278 154 symbols; not partial, no diagnostics |

Repo root for all paths below: `<repo-root>`.

---

## 1. Coverage matrix

Legend: **implemented** = owned code path with tests; **partial** = works but a stated dimension is
missing or only one transport/layer covers it; **weak** = exists but thin, convention-only, or docs-only;
**absent** = no implementation found in this checkout; **NA** = out of branch scope.

| # | Topic | Status | Evidence (file:line) | Tests | Docs | Conclusion |
| --- | --- | --- | --- | --- | --- | --- |
| g1 | Model runtime / adapters | implemented | `apps/zcode-cli/packages/adapters/src/model/model-execution.ts:9` (AI SDK `createAnthropic`/`createOpenAI`/`createOpenAICompatible`), `:518`,`:528`,`:538` (three provider factories), `:66` (4th kind `opencode-sdk`) | `adapters/tests/model-execution.test.ts`, `opencode-model-execution.test.ts`, `model.test.ts`, `runner.test.ts`, `new-model-wire.test.ts` | `docs/model-provider-opencode-config.md`, `docs/model-request-output-tokens.md` | Vercel AI SDK v6 wrapper with provider-specific fetch shims; no in-repo HTTP protocol client. |
| g2 | Provider registry | implemented | `packages/provider/src/registry.ts:46` class, `:74` `validateSelection`, `:94` `replace`, `:143` duplicate-provider throw, `:160` duplicate-model throw | `packages/provider/test/registry.test.ts`, `registry-service.test.ts` (24 files in `packages/provider/test`) | `docs/model-provider-family-merge.md` | Immutable revisioned view; validation covers provider/model/reasoning-level presence. |
| g3 | Built-in / account / personal provider config | implemented | `packages/provider/src/sources.ts:24` (4 layers: builtin, account, personal, runtime), `packages/provider/src/resolver.ts:186` overlay order, `:218` model-rule composition | `provider/test/todo21-resolution.test.ts`, `resolver.test.ts`; `provider-node/test/new-model-catalog*.test.ts` | `docs/model-provider-config-overrides.md`, `docs/builtin-provider-config-build-environments.md` | Three-layer config overlay with fail-closed account snapshot (`sources.ts:68`). |
| g4 | Model config rules (layering/overlay) | implemented | `packages/provider/src/config/model-config.ts:372` `ModelConfigRules`, `:385` `composeEffective`, `:395` resolve loop, `:432` `resolveForModelApi` two-pass | `provider/test/model-config-rules.test.ts`, `model-rule-collections.test.ts` | `config/provider/zcode-builtin.json` (7507 lines: 25 template rules, 10 provider rules, 83 model rules, 73 model-API rules, 55 provider-site rules, 338 template-model rules, 30 builtin-provider-model rules) | Rules are ordered overlays; API-specific pass re-resolves after route selection, then re-pins the route. |
| g5 | Token limits / context window | partial | `apps/zcode-cli/packages/contracts/src/config/index.ts:287` idle 600 s, `:290` first-token 90 s; `core/src/runtime/methods/model-token-limits.ts:7` default 32 K output, `:17` preflight cap = `contextWindow - usage - 1000`; `core/src/compact/policy.ts:9` default 200 K window, `:13` 32 K output reserve, `:16` 13 K buffer | `adapters/tests/model-output-tokens-wire.test.ts`, `goal-verifier-model-options.test.ts`; `core/tests` compaction suites | `docs/model-request-output-tokens.md`, `docs/context-window-usage-state.md` | Two limits exist (base 32 K, preflight remaining-window) but the `legacy` strategy string is still accepted and only documented as input compat (`model-token-limits.ts:21`). |
| g6 | Modalities / capability projection | implemented | `packages/provider/src/resolver.ts:86-103` serialized `inputFormat`/`outputFormat` + `supportsToolCall`/`supportsJsonSchemaOutput`/`supportsNativeWebSearch`/`supportsMidConversationSystem`/`requiresMfjsToolSchema`; `adapters/src/model/media-transform-policy.ts:9` unsupported-media projection; `tool-transform.ts:109`,`:346`; `model-execution.ts:549` structured-output binding | `adapters/tests/model-transform-tool-media.test.ts`, `mfjs-properties-wire.test.ts`, `video-wire.test.ts`, `strict-tool-schema.test.ts` | `docs/compact-media-capability-projection.md`, `docs/multimodal-tool-result-p0-cases.md` | Capabilities are frozen model facts, not re-queried per request (`model-execution.ts:545-547`). |
| g7 | Reasoning / thinking levels | implemented | `packages/model-option-map/src/option-maps.ts:1` (CEL-style option maps compiled once), `:22` `compileModelOptionMaps`; `adapters/src/model/reasoning-history-normalization.ts:31`; `provider-node/src/legacy-reasoning-level*.ts` | `adapters/tests/async-migration-startup.test.ts`, `runtime-reasoning-provider-replay.test.ts`, `reasoning-provider-compatibility.test.ts`; `provider-node/test/reasoning-level-migration.test.ts` | `docs/composer-model-thinking.md`, `docs/openrouter-reasoning-request-contract.md` | Reasoning level maps to provider request JSON via declarative merge patches; history normalization handles provider replay. |
| g8 | Provider routing | implemented | `adapters/src/model/provider-endpoint-routing-fetch.ts:7` (per-attempt routing port + `apiKeyId`), `model-execution.ts:483-490` (routing fetch applied before security fetch), `model-execution.ts:555` transport cached per provider only | `adapters/tests/provider-endpoint-routing-fetch.test.ts`, `project-token-request-auth.test.ts` | `docs/bigmodel-api-environment-origin.md`, `docs/zcode-endpoint-switching.md` | Endpoint routing is per attempt (comment at `model-execution.ts:484`: ID must not be cached per provider). |
| g9 | Fallback | partial | `core/src/runtime/methods/provider-quota-fallback.ts:6` `MAX_PROVIDER_ATTEMPTS = 3`, `:63` candidate selection, `:105` wrapper model, `:172` "no fallback after output emitted", `:62` `QUOTA_RETRY_AFTER_THRESHOLD_MS = 600_000` | `core/tests/provider-quota-fallback.test.ts` (incl. cause-chain detection at `:303`) | — no dedicated spec doc found | Fallback exists **only** for quota-exhaustion (402 / `insufficient_balance` / FreeUsageLimit / 429 with >10 min Retry-After). No fallback for auth failure, network error, 5xx, or model deletion. `F-FALLBACK-001` in `docs/model-provider-regression-case-catalog.md` is still `[待确认]`. |
| g10 | Retry / backoff | implemented | `adapters/src/model/retry-policy.ts:20` default 10 retries, `:21-23` 2 s base, ×2, 60 s cap, `:38` `MAX_HONORED_RETRY_AFTER_MS = 300_000`; `runner-retry.ts:43` `calculateRetryDelay` with jitter `:55`; `retry-budget.ts:24` unbounded/single-attempt budgets; `empty-completion-retry.ts:9` (1 retry); `stream-idle-timeout.ts:5` (+30 s per retry) | `adapters/tests/retry-budget.test.ts`, `runner-retry.test.ts`, `runner-retry-after-policy.test.ts`, `runner-empty-delta-retry.test.ts`, `first-token-watchdog.test.ts` | `docs/v4-composer-api-retry-status.md`, `docs/bigmodel-business-error-retry.md` | Retry is layered: budget gates → delay computation → Retry-After honoring; provider-requested wait >5 min becomes terminal quota. |
| g11 | Usage / cost accounting | partial | Tokens: `adapters/src/storage/session-store/repositories/usage.ts:20` full `model_usage` insert, `:166` `turn_usage`, `:260` `tool_usage`; source `core/src/runtime/methods/usage-observability.ts:60-119`. Cost: **hardcoded 0** at `core/src/runtime/methods/message-persistence.ts:337`, `turn-step-finish.ts:29`, `turn-stop.ts:86`,`:137`, `timeline-persistence.ts:130`; no `cost` column in any usage table (`migrations.ts:532-660`) | `adapters/tests/usage-query.test.ts` (4), `session-store.test.ts` (59, incl. usage at `:2890-3030`) | `apps/zcode-cli/docs/design/v2/usage-observability.md` ("not a permanent billing ledger") | Token accounting is thorough (7 token fields + raw JSON). **No monetary cost accounting exists anywhere.** `MessageInfo.cost`/`StepFinishPart.cost` (`contracts/src/interfaces/session-store.port.ts:413`,`:695`) are always 0. |
| m1 | UI / service logging | implemented | `packages/services/src/logger/serviceLogger.ts:18` `createServiceLogger`, `:30` debug gated by dev env; `docs/performance/renderer-production-logging.md` (production renderer logging no-op, `packages/ui/src/logger.ts` sole entry) | `apps/zcode-cli/packages/adapters/tests/logging.test.ts` | `apps/zcode-cli/docs/design/v2/logging.md` (three layers: session event / structured JSONL / trace span) | Service logger contract is small and consistent; UI logger is a separate, stricter production-silent layer. |
| m2 | Event journal | implemented | `apps/zcode-cli/packages/contracts/src/events/in-memory-session-event-store.ts:40-44` retention mode, `:98` transient eviction, `:105-107` `slimRetainedModelRequest`; durable sqlite `session_entry` table `adapters/src/storage/session-store/migrations.ts:200`; DWF journal `migrations.ts:979-1050` (`dwf_run`/`actor`/`node`/`event`) | `adapters/tests/dwf-journal-store.test.ts`, `session-store.test.ts`; `docs/analysis/memory-leak-fix-plan-cli-event-store.md` (implementation verified + spec referenced) | `docs/analysis/memory-leak-fix-plan-cli-event-store.md`, `apps/zcode-cli/docs/design/v2/logging.md` | In-memory event list is turn-window bounded (fixed token-frequency leak), durable state is sqlite. |
| m3 | Usage DB schema + retention | implemented | `migrations.ts:532` migration `0010_usage_observability`; `model_usage` `:535-585` (39 columns, 4 indexes); `turn_usage` `:587-618`; `tool_usage` `:620-658`; retention `repositories/usage.ts:17-18` `30 days`, `:335-355` `pruneUsage` in an `immediate` transaction | `usage-query.test.ts` (all-time query at `:133`, day-bucketing), `session-store.test.ts:2958` prune | `apps/zcode-cli/docs/design/v2/usage-observability.md` §Retention | Prune runs **after every write** (`usage.ts:163`, `:256`, `:332`) — not at startup, despite the design doc saying "startup or after writes". |
| m4 | Traces / OTel | implemented | `apps/zcode-cli/packages/telemetry/src/otlp-exporter.ts:60-100` (BatchSpanProcessor: batch 100, queue 2000, 5 s delay, 3 s timeout; GZIP; DELTA metrics); `:31-32` metric interval 300 000 ms, trace sample 0.1; span topology `docs/trace/cli-agent-telemetry.md:30-45` | `telemetry/tests/otlp-integration.test.ts`, `otlp-cost-controls.test.ts` (3), `agent-trace-runtime.test.ts` (13) | `docs/trace/cli-agent-telemetry.md` (schema v6), `docs/trace/reference/otel-concepts.md`, `docs/trace/model-attempt-error-diagnostics.md` | Well-specified span tree: `agent_turn → agent_step → model_call → model_attempt`, plus `tool_execution`/`command_execution`/`context_compaction`. |
| m5 | Metrics | implemented | `telemetry/src/agent-metrics.ts:47-90` (8 duration histograms, attempts histogram, token counter, TTFT ×3, stall counter, max-idle, creation-drop, abandoned); low-cardinality allowlist `:195-226`, `:104`; `otlp-cost-controls.test.ts:71` (10-bucket cap, min/max off) | `agent-metrics.test.ts`, `otlp-cost-controls.test.ts` | `docs/monitoring/performance-telemetry-catalog.md`, `docs/monitoring/ttft-stage-telemetry.md` | Metric label sets are allowlisted per span; high-cardinality IDs excluded deliberately (`agent-metrics.ts:30-34` comment). |
| m6 | Error taxonomy | implemented | `contracts/src/model/index.ts:101-121` `ModelErrorCode` (14 values), `:131-144` `ModelRetryReason` (10), `:148-160` `ModelFailureReason` (superset + 8); classifier mapping `adapters/src/model/failure-classifier.ts` — 62 `code:`/`reason:` assignments | `failure-classifier.test.ts` (45 `it`), `runner-provider-business-network.test.ts`, `opencode-quota-error.test.ts` | `docs/trace/model-attempt-error-diagnostics.md`, `docs/chat-error-detail-telemetry.md` | Taxonomy is stable, closed and mapped to retryability; provider business codes are a separate mapped layer (`failure-provider-business-codes.ts`, 409 lines). |
| m7 | Evals / benchmarks | weak | `scripts/delegation-routing-benchmark.mjs:1-8` (paired JSONL gate, never runs an LLM); `scripts/prism10-experiment-gate.mjs:6-11` (min 20 cases / 2 trials, max cost ratio 1.25, latency ratio 1.3); `apps/zcode-cli/tools/prompt-trajectory/` (fixture replay, `record`/`derive`/`model-io`/`run:testcases`) | `scripts/test/delegation-routing-benchmark*.test.mjs`, `prism10-experiment-gate.test.mjs`; `prompt-trajectory/tests` (9 files) | `apps/zcode-cli/tools/prompt-trajectory/README.md` (explicitly records two known-broken paths as of 2026-10-14) | There is **no in-repo model quality eval harness**: no golden-set runner, no pass@k, no LLM-judge, no model leaderboard. The two gates score externally produced records. |
| m8 | Eval fixtures / regression catalogs | partial | `docs/model-provider-regression-case-catalog.md` (~60 scenario cases, many `[待确认]`); `apps/zcode-cli/packages/core/tests/fixtures` (3 entries); `prompt-trajectory` testcase discovery convention `src/testcases.ts:21-46` but **no committed `testcases/` directory** | see above | `docs/model-provider-regression-case-catalog.md` | Scenario catalog is documentation for manual testers, not an executable eval. |
| n1 | Streaming / backpressure | implemented | `docs/performance/streaming-tool-input-backpressure.md` (protocol-boundary coalescing of `text_delta`/`reasoning_delta`/`tool_input_delta`; 1000 ms Write/Edit budget; tombstone buffer for background tasks); code: `adapters/src/model/streaming-tool-call-assembler.ts`, `tool-result-media-projection.ts` | `adapters/tests/task-output-wire.test.ts`, `tool-result-cache-wire.test.ts` | `docs/performance/streaming-tool-input-backpressure.md` | Backpressure is at three boundaries: protocol server, UI projection, tool-input dedup. |
| n2 | Cancellation / timeouts | implemented | `first-token-watchdog.ts:58` (abort with typed error, `unref` timer), `stream-idle-timeout.ts:9` (+30 s per retry), `createLinkedAbortController` `:60`; `runner-stream.ts:164` per-attempt controller | `first-token-watchdog.test.ts`, `project-token-cancellation.test.ts` | `docs/contracts` (retry budget) | Three independent timeouts: first-token 90 s, stream idle 600 s (+30 s per retry), HTTP/OTel 3-5 s. Cancellation is signal-chained parent → attempt. |
| n3 | Concurrency limits | implemented | `bootstrap/src/app/workflow-concurrency-governor.ts:1-70` process-level per-`provider/model` bucket; `dynamic-workflow/src/engine/concurrency.ts:25-37` AIMD constants (0.75 decrease, +1 per 4 successes, floor 1, idle reset 300 s); defaults `bootstrap/src/app/workflow-default-concurrency.ts`; main agent is observer-only `workflow-concurrency-governor.ts:414-420` | `dynamic-workflow/tests/engine/concurrency.test.ts`, `engine-retune-concurrency.test.ts`; `adapters/tests/runner-admission.test.ts` | `docs/dynamic-workflow/concurrency.md` (very detailed spec incl. epoch rule, cooldown, seeding) | This is the most sophisticated reliability component in the branch: AIMD + epoch damping + run-fair round-robin queue + seat gate. |
| n4 | Resource limits / capacity guards | implemented | Telemetry: `agent-trace-runtime.ts:117` `maxActiveWriters = 5000`, `:581-600` capacity drop metric + warning; `model-api-recorder.ts:58-59` 30 min call age / 1000 active calls, `:331` sweep; model IO: `runner-debug.ts:35-42` 3 rollout files / 64 MiB / 256 MiB debug / 64-256 baseline messages | `telemetry/tests/model-api-recorder.test.ts`, `agent-trace-runtime.test.ts` | `docs/model-io-full-retention-setting.md` | Every observability path has an explicit bound and a drop counter; model-IO never blocks requests (`runner-debug.ts:531` bare catch). |
| n5 | Recovery | partial | Event store: turn-window eviction with 60 s tick fallback (`in-memory-session-event-store.ts:78`); stream retry boundary `stream-retry-boundary.ts:5-19` (retry-safe prelude buffered); "no replay after visible output" `runner-stream.ts:1557`; migration crash recovery `adapters/tests/migration-crash-recovery.test.ts` | `prism-projection-recovery.test.ts`, `migration-crash-recovery.test.ts`, `project-token-runner-recovery.test.ts` | `docs/trace/…`, `docs/analysis/memory-leak-fix-plan-cli-event-store.md` | Recovery exists per-layer but there is **no unified session-level resume contract** for a crashed provider mid-turn beyond event replay. |
| n6 | Rapid-refill / breakers | partial | AIMD controller is the effective breaker (cap→1 floor, `cooldownUntil` from Retry-After `concurrency.ts:186-188`); **no provider circuit-breaker with open/half-open state** found; `request-security-edition/recovery.ts:1-24` is a stub in this edition | `concurrency.test.ts` | `docs/dynamic-workflow/concurrency.md` "Cooldown and idle reset" | Concurrency throttling substitutes for a breaker for workflow traffic, but the **main agent never queues** (`workflow-concurrency-governor.ts:414`), so main-agent traffic has no breaker at all. |
| t1 | Secret redaction in logs | implemented | `telemetry/src/error-sanitizer.ts:1` 2048-char cap, `:59` 4096 pre-truncate, `:60-88` URL / Authorization / query-secret / `sk-`/`ghp_`/AKIA/AIza / email / POSIX+Windows path redaction; `adapters/src/model/runner-network-headers.ts:4-40` header-name redaction (substring match on authorization/api-key/token/secret/cookie); `runner-debug-redaction.ts:20-60` image/video data URL omission | `telemetry/tests/error-sanitizer.test.ts` (6), `runner-debug-media-redaction.test.ts`, `model-request-security.test.ts` | `docs/monitoring/event-report-privacy.md`, `docs/monitoring/event-report-delivery-reliability.md` | Two independent redaction layers (telemetry and model-IO), both allowlist-first. `/event/report` additionally hard-redacts all `error_msg` to `[redacted]` rather than regex-guessing. |
| t2 | Telemetry retention | partial | Usage: 30 days hard-coded (`usage.ts:17`). Model IO: 3 files / 64 MiB production (`runner-debug.ts:35-37`). Telemetry OTel: **client-side no retention policy** — relies on collector (`otlp-exporter.ts` has no TTL). `/event/report`: no client retention, bounded 2 attempts + 2 s quit flush. Log export: 3-day mtime filter (`docs/desktop/log-export-retention.md`) | `usage-query.test.ts`, `otlp-cost-controls.test.ts` | `docs/desktop/log-export-retention.md`, `docs/monitoring/event-report-delivery-reliability.md` | Local retention is explicit per store; remote retention (OTel/ARMS/`/event/report`) is entirely server-side and undocumented in-repo. |
| t3 | Local storage layout / privacy boundaries | implemented | `docs/settings-storage-management.md` §1.2 (two roots `~/.zcode` and `{dataBaseDir}/.zcode`, documented split, model-IO hard-coded to `homedir()/.zcode/cli/{debug,rollout}` `runner-debug.ts:588-590`); credential store `packages/services/src/credential/credentialService.ts:33` `credentials.json` with encryption provider `:142`; export exclusions `docs/desktop/log-export-retention.md` | `packages/services/test` credential suites | `docs/settings-storage-management.md`, `docs/desktop/log-export-retention.md`, `docs/tmpdir-storage-paths-spec.md` | Storage split is a **known, deliberately preserved** boundary, not a bug. Credentials never ship in log exports. |
| t4 | Telemetry opt-out / consent | weak | OTel: requires endpoint env (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`/`_ENDPOINT`) **and** not `ZCODE_MODEL_TELEMETRY_ENABLED=0` (`telemetry/src/bootstrap.ts:124`); `/event/report`: build-time endpoint only (`telemetryCore.ts:418` comment), no runtime user toggle found | `telemetry/tests/bootstrap.test.ts` (4) | `docs/monitoring/event-report-privacy.md` | Opt-out exists at **build/env** level, not as a user-facing Settings switch. No `DO_NOT_TRACK`-style handling found. |

---

## 2. Detailed findings

### 2.1 Model runtime and adapters

**Fact.** The runtime is a Vercel AI SDK v6 wrapper, not a bespoke protocol client. `AiSdkProviderKind`
is a closed union of four values (`model-execution.ts:66`):

- `openai` → `createOpenAI(...)` uses `provider.responses` (`:518-525`) — Responses API only.
- `anthropic` → `createAnthropic(...)` with an Authorization-header shim (`:528-535`).
- `openai-compatible` → `createOpenAICompatible(...)` with `includeUsage: true` (`:546`) and
  `supportsStructuredOutputs` bound to the **frozen model fact** (`:549`, comment `:545-547`).
- `opencode-sdk` → long-lived `OpencodeProvider` subprocess; lifecycle explicitly owned by the caller
  (`:527` comment "OpenCode provider 生命周期由 owning process 显式结束"), disposed via
  `disposeAfterStream` (`:769`).

**Fact.** Transport order per request is deterministic and non-negotiable:
network/proxy fetch → endpoint routing fetch (`:483-490`) → request-security `protectTransport`
(`:492`) → provider-business-error fetch (`:500`) → option-map fetch (`:508`) → SDK factory.
The comment at `:484` states the `apiKeyId` is per-attempt on purpose: caching it per provider would
leak credentials across account switches.

**Fact.** Transport caching is per provider (`resolveProviderTransport`, `:559-582`) and emits a
non-fatal proxy fallback warning that deliberately contains only `host:port` (`:571-576`).

**Boundary.** `toAiSdkProviderConfig` (`:830-870`) maps `api.type` → kind and throws on unknown API
types (`:871`). So the set of possible provider protocols is exactly three wire types plus OpenCode SDK,
even though the built-in config declares 25 templates.

### 2.2 Provider registry, config layers, and rules

**Fact.** Four config sources feed one resolver (`packages/provider/src/sources.ts:24-34`): builtin,
account overlay, personal, and runtime-discovered catalog. `ProviderConfigResolver.resolve`
(`resolver.ts:186-330`) applies exactly this order:

1. account providers are filtered to known builtins and stripped of `group` (`:190-196`);
2. `concreteBuiltin = builtin.overlay(account)` (`:197`);
3. builtin templates overlay onto concrete builtins (`:199-204`);
4. personal providers overlay (`:205-211`);
5. personal templates overlay for non-builtin ids (`:212-218`);
6. model rules compose builtin-then-personal-exact (`:218-221`, `ModelConfigRules.composeEffective`
   `model-config.ts:385-387` — personal rules are filtered to **exact** model rules only).

**Fact.** Executability is a four-way conjunction: `enabled && accessEntitled && accountCurrent &&
noProviderIssues` (`resolver.ts:263-264`), then `executable = providerExecutable && modelEnabled &&
noModelIssues` (`:283`), then `selectable = executable && visibility !== "hidden"` (`:284`).
Account-backed providers are never globally disable-able (`:243` comment, `:246`).

**Fact.** Duplicate provider/model ids are a hard error at registry build (`registry.ts:143`,`:160`), and
`replace()` validates the whole candidate before swapping any internal structure (`:94-108` comment).

**Fact.** Built-in catalog size, from `config/provider/zcode-builtin.json` (revision 36):

| Rule collection | Count | Line |
| --- | --- | --- |
| `templateRules` | 25 | `:6` |
| `providerRules` | 10 (all `account:*` families) | `:895` |
| `modelRules` (match-regex) | 83 | `:1113` |
| `modelApiRules` | 73 | `:2674` |
| `providerSiteRules` | 55 | `:3488` |
| `templateModelRules` | 338 | `:4569` |
| `builtinProviderModelRules` | 30 | `:7293` |

Provider families declared in templates: `zai-api`, `zai-standard-api`, `bigmodel-api`,
`bigmodel-standard-api`, `moonshot-kimi`, `minimax`, `deepseek`, `qwen-alibaba-model-studio-cn`,
`qwen-alibaba-model-studio-intl`, `xiaomi-mimo`, `xiaomi-mimo-token-plan`, `openai`, `anthropic`, `xai`,
`openrouter`, `opencode-api`, `opencode-go-inference`, `opencode-zen`, `opencode-go`, `opencode-go-chat`,
`opencode-go-messages`, `opencode-go-responses`, `opencode-zen-responses`, `opencode-zen-messages`,
`opencode-zen-chat`.

### 2.3 Routing, fallback, retry

**Fact.** Fallback is narrow and explicit. `provider-quota-fallback.ts`:

- max 3 total attempts including primary (`:6`, also clamped again at `:105`);
- candidates must be same model class: same `modelId` OR (context window ≥ source AND tool-call AND
  json-schema AND every source-required input modality) (`:262-296`);
- **streaming fallback stops after the first emitted event** (`:183-186` comment "已输出内容后不能换
  Provider，否则会把两段回答拼在一起");
- quota classification accepts 402, `insufficient_balance`, `FreeUsageLimitError`, free-limit regex, and
  429 with Retry-After > 10 min (`:300-345`), walking up to 5 cause links (`:298`).

**Inference.** Because fallback requires *same model class*, "fallback" here means "same model on a
different provider/plan", not "degrade to a cheaper or different model". This matches the account-family
design (`docs/model-provider-family-merge.md`) but is a product-level limitation: a user with one
provider gets no fallback.

**Fact.** Retry defaults are aggressive: 10 retries, 2 s base, ×2 backoff, 60 s cap, jitter 0.5–1.0
(`retry-policy.ts:20-23`, `runner-retry.ts:55`). With the 90 s first-token and 600 s idle timeouts this
permits a very long wall-clock stall before user-visible failure — which the code itself acknowledges
(`first-token-watchdog.ts:6-8`: "叠加既有重试可长达数小时").

**Fact.** Retry is *not* one loop. It is at least five: attempt loop (`runner-stream.ts:140-148`),
signature-repair extra attempt (`:145`), auth-refresh extra attempts (`:145`), empty-completion retry
(`empty-completion-retry.ts:9`, 1 max), and core-level stream recovery (`runner-stream.ts:1557`
comment). `retry-budget.ts` exists precisely because four call sites would otherwise special-case budget.

### 2.4 Usage and cost

**Fact.** Token accounting is genuinely strong. `model_usage` has 39 columns
(`migrations.ts:535-585`) covering logical request id, attempt index, trace/span, session/turn/message,
query source, provider/model/agent/mode/task type, status, timestamps, TTFT, finish reason, tool count,
seven token fields, retry count, `retryable`, `cancelled_by_user`, `context_exceeded`, error
type/code/message, and raw usage/provider-metadata JSON. Four indexes support time/model, session/turn,
trace and query-source queries.

**Fact — gap.** There is no monetary cost anywhere:

- `message-persistence.ts:337`, `turn-step-finish.ts:29`, `turn-stop.ts:86`,`:137`,
  `timeline-persistence.ts:130` all write literal `cost: 0`;
- `migrations.ts` usage tables have no `cost` column at all (verified: no `cost` match in the migration
  file);
- `MessageInfo.cost` and `StepFinishPart.cost` exist in contracts (`session-store.port.ts:413`,`:695`) and
  are forwarded to the protocol (`message-mapper.ts:26`,`:104`) but are always zero;
- the design spec explicitly says usage is "not a permanent billing ledger"
  (`apps/zcode-cli/docs/design/v2/usage-observability.md` §Goal).

**Inference.** Usage is a *volume and latency* observability store, not a billing or budget-enforcement
store. Any product feature that claims "cost so far" would be fabricating numbers today.

**Fact.** Retention is 30 days (`usage.ts:17-18`) and enforce is `pruneUsage` called inside every write
(`usage.ts:163`, `:256`, `:332`) inside an `begin immediate` transaction (`:339-352`). Startup pruning
advertised by the design doc is not implemented: repo-wide search shows `pruneUsage` is only (a) exported
from the repository module, (b) re-exported by `sqlite-session-store.ts:987`, (c) declared on the port
(`session-store.port.ts:1301`), (d) used as a *presence check* in the runtime narrowing guard
(`core/src/runtime/methods/usage-observability.ts:341`, `turn-tool-usage.ts:67`), and (e) called in
tests. There is no invocation from store open or process start.

**Fact.** App Usage range handling: `since = 0` when `range === "all"`, else `until - rangeDays*86400000`
(`bootstrap/src/zcode-protocol/server-operations.ts:1895`); `UsageStatsRange = "all" | "7d" | "30d"`
(`packages/shared/src/usage-stats.ts:11`). Because the store prunes at 30 days, `range: "all"` in practice
returns ≤30 days.

**Fact.** Day bucketing uses a fixed `tzOffsetMs` (`usage.ts:388` comment), with a documented DST error of
up to 1 hour, explicitly accepted as acceptable for usage statistics.

### 2.5 Logging, journal, traces, metrics, errors

**Fact.** Logging contract is three-layer (`apps/zcode-cli/docs/design/v2/logging.md`): session event
(recoverable facts), structured JSONL (diagnostic index, redacted), trace span (timing/causality). The
service logger is deliberately tiny: 4 levels, trace-id prefix, debug gated to dev
(`serviceLogger.ts:18-66`). Renderer logging is production-silent by Vite `import.meta.env.PROD`
(`docs/performance/renderer-production-logging.md`), with one explicit exception for memory diagnostics.

**Fact.** Trace schema is v6 and stable. Span tree: `agent_turn → agent_step → {model_call →
model_attempt[1..n], tool_execution → command_execution?}` plus `context_compaction` and
`detached_operation` (`docs/trace/cli-agent-telemetry.md:30-45`). `model_call` is the logical call
(retry/fallback-superseding); `model_attempt` is the physical request; success rates are defined per
level (`:48-52`). `zcode.*` attributes are authoritative; `gen_ai.*`/`http.*`/`server.*` are projections
only (`:100-104`).

**Fact.** Metrics are allowlist-constrained per span. `TERMINAL_LABELS` maps each of 8 span names to an
explicit attribute list (`agent-metrics.ts:225+`), `allowMetricAttributes` filters (`:104`, `:128`,
`:135`, `:155`). Histograms cap at 10 buckets and disable min/max
(`otlp-cost-controls.test.ts:71-80`). Trace sampling 0.1 with parent-based inheritance so no partial
trees (`otlp-cost-controls.test.ts:20-63`).

**Fact.** Error sanitizer is defense-in-depth and bounded: truncate to 4096 → 13 regex families →
truncate to 2048 (`error-sanitizer.ts:59-89`); error chain depth 8, cycle-detected (`:97-116`); a
WeakSet "claim" prevents the same error body from appearing on every ancestor span (`:37-52`).

**Fact.** `model_usage`/`turn_usage`/`tool_usage` and OTel are separate stores by design
(`docs/trace/cli-agent-telemetry.md:56-63` table) — Trace never goes to local logs or RUM.

**Fact.** `/event/report` privacy is stronger than regex: all non-empty `error_msg` becomes
`[redacted]`, login URL keeps only lowercase hostname, and the same pure function runs in UI and Core
(`docs/monitoring/event-report-privacy.md`). Delivery is bounded: 5 s timeout, 2 attempts, 300 ms/1 s
retry, 2 s quit flush, no persisted outbox
(`docs/monitoring/event-report-delivery-reliability.md` §投递合同, §退出 drain).

### 2.6 Performance, reliability, concurrency

**Fact.** The concurrency governor is the strongest engineering artifact in this branch. Per
`${providerId}/${modelId}` bucket (`workflow-concurrency-governor.ts:26-30`), AIMD
(`concurrency.ts:25-37`), with three non-obvious mechanisms:

- **epoch damping**: a refusal only cuts the cap if the request was admitted under the current cap; a
  burst of 13 admits yielding 8 × 429 produces exactly one cut
  (`docs/dynamic-workflow/concurrency.md` "The epoch rule");
- **clean-slate prototype**: an exponential backoff wrapper is used as a local base class inside the
  controller, but the public surface is a constrained interface (`concurrency.ts:1-37`);
- **fairness**: waiters are queued per run and granted round-robin, and `tryAcquire` is refused while
  waiters exist, so a request-heavy run cannot starve a late small run
  (`workflow-concurrency-governor.ts:36-42` comment).

**Fact.** Default parallelism is `max(4, min(16, availableParallelism() - 2))`, computed once per
process, with an explicit rationale for the floor of 4 (remote providers, not local cores)
(`docs/dynamic-workflow/concurrency.md` "Two bounds on a run"). Auto-growth ceiling is `max(2D,
largest live run bound)`.

**Fact.** The main agent never queues (`workflow-concurrency-governor.ts:414-420`: `observerAdmission`
is `tryAcquire` → immediate `grant`, "不排队、不看冷却"). This protects main-agent latency but means
that in a process where a workflow is saturating the provider, the main agent's requests still go out and
can absorb 429s — the cap is enforced on subagents only.

**Fact.** Observability has explicit capacity guards and "fail silent" semantics:
`maxActiveWriters = 5000` with a `creation_drop` counter (`agent-trace-runtime.ts:117`,`:581-600`);
`ModelApiTelemetryStatusSink` 1000 calls / 30 min age with periodic sweep (`model-api-recorder.ts:58-59`,
`:331-346`) and full exception isolation so telemetry can never break the model path
(`model-api-recorder.ts:80-96`); model-IO writes wrapped in a bare `catch {}`
(`runner-debug.ts:531-533`).

**Fact.** Model-IO has a subtle, evidence-backed fix: because appending to a GB-scale JSONL after
re-reading and expanding the whole history previously caused native V8 crashes, the writer **resets** the
file rather than rewriting when over the size limit (`runner-debug.ts:495-530`, especially the
`:524-527` comment). Full-retention mode skips rotation, limits, pruning and compaction but **does not**
skip redaction (`:487-495`).

### 2.7 Evaluations

**Fact — the largest gap in this branch.** There is no in-repo model-quality evaluation:

- `scripts/delegation-routing-benchmark.mjs` explicitly "only compares recorded JSONL results; it never
  runs an LLM" (`:3-7`), and synthetic fixtures "are useful for testing the gate, not for claiming model
  gains" (`:6-7`).
- `scripts/prism10-experiment-gate.mjs` "Scores externally recorded PRISM pairs. It never runs models or
  authenticates receipts" (`:2`), with gates: ≥20 cases, ≥2 trials, cost ratio ≤1.25, latency ratio ≤1.3
  (`:6-11`).
- `apps/zcode-cli/tools/prompt-trajectory/README.md` is a **fixture replay** tool (prompt assembly
  continuity), and its own README records that `record:prompt` and `model-io` were broken as of
  2026-10-14.
- `docs/model-provider-regression-case-catalog.md` is a manual QA scenario list, not executable; many rows
  are still `[待确认]` (e.g. `F-APP-002`, `F-QUEUE-001`, `F-COMPACT-001`, `F-FALLBACK-001`).

**Inference.** ZCode can measure *efficiency* (tokens, TTFT, tool bytes, concurrency) and *reliability*
(classifier outcomes) far better than it can measure *quality*. There is no tie between a model/provider
change and a task-success metric.

### 2.8 Data, privacy, retention

**Fact.** Credentials: `credentials.json` under the credentials dir
(`credentialService.ts:33`), values encrypted through a `cipherProvider` (`:142`); a comment states
safeStorage/keychain migration is future work (`:23-24`). Credential files are explicitly excluded from
both manual and feedback log archives (`docs/desktop/log-export-retention.md` §Excluded Credential
Stores).

**Fact.** Log export is bounded by mtime (3 days), excludes `credentials.json`, `agent-config/**`,
`certs/**`, any `debug` path segment, retired ACP dirs, caches and `node_modules`
(`docs/desktop/log-export-retention.md`).

**Fact.** Storage roots intentionally split: app services honor `dataBaseDir`, the CLI agent stays at
`~/.zcode/cli/config.json storage.dir`, and model-IO is hard-coded to `homedir()/.zcode/cli/{debug,
rollout}` (`docs/settings-storage-management.md` §1.2 table, `runner-debug.ts:588-590`). The doc calls
this an explicit product boundary preserved on purpose, and an E2E test asserts it.

**Fact.** Telemetry enablement is build/env, not user-facing: OTel requires an endpoint env var and is
disabled by `ZCODE_MODEL_TELEMETRY_ENABLED=0` (`bootstrap.ts:124`); `/event/report` requires a
build-time endpoint (`telemetryCore.ts:418`). No Settings toggle, no `DO_NOT_TRACK` handling was found
(repo-wide search for `DO_NOT_TRACK`, `opt-out`, `disableTelemetry` returned no matching implementation).

---

## 3. Inventories

### 3.1 Providers (built-in templates)

| Template id | API type | Base URL | Models | Access |
| --- | --- | --- | --- | --- |
| `zai-api` | `anthropic-messages` | `https://api.z.ai/api/anthropic` | 2 | `zhipu-coding-plan-api-key` |
| `zai-standard-api` | `openai-chat-completions` | `https://api.z.ai/api/paas/v4` | 24 | `api-key` |
| `bigmodel-api` | `anthropic-messages` | `https://open.bigmodel.cn/api/anthropic` | 2 | `zhipu-coding-plan-api-key` |
| `bigmodel-standard-api` | `openai-chat-completions` | `https://open.bigmodel.cn/api/paas/v4` | 24 | `api-key` |
| `moonshot-kimi` | `anthropic-messages` | `https://api.moonshot.cn/anthropic` | 6 | `api-key` |
| `minimax` | `anthropic-messages` | `https://api.minimaxi.com/anthropic` | 8 | `api-key` |
| `deepseek` | `anthropic-messages` | `https://api.deepseek.com/anthropic` | 2 | `api-key` |
| `qwen-alibaba-model-studio-cn` | `anthropic-messages` | `https://dashscope.aliyuncs.com/apps/anthropic` | 13 | `api-key` |
| `qwen-alibaba-model-studio-intl` | `openai-chat-completions` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | 14 | `api-key` |
| `xiaomi-mimo` | `anthropic-messages` | `https://api.xiaomimimo.com/anthropic` | 4 | `api-key` |
| `xiaomi-mimo-token-plan` | `anthropic-messages` | `https://token-plan-cn.xiaomimimo.com/anthropic` | 2 | `api-key` |
| `openai` | `openai-responses` | `https://api.openai.com/v1` | 10 | `api-key` |
| `anthropic` | `anthropic-messages` | `https://api.anthropic.com/v1` | 5 | `api-key` |
| `xai` | `openai-responses` | `https://api.x.ai/v1` | 3 | `api-key` |
| `openrouter` | `anthropic-messages` | `https://openrouter.ai/api` | 58 | `api-key` |
| `opencode-api` | `openai-chat-completions` | `https://opencode.ai/zen/go/v1` | 61 | `api-key` |
| `opencode-go-inference` | `openai-chat-completions` | `https://opencode.ai/zen/go/v1` | 3 | `api-key` |
| `opencode-zen` | `openai-chat-completions` | `https://opencode.ai/inference/openai/v1` | 2 | `api-key` |
| `opencode-go` | `openai-chat-completions` | `https://opencode.ai/zen/go/v1` | 27 | `api-key` |
| `opencode-go-chat` | `openai-chat-completions` | `https://opencode.ai/zen/go/v1` | 16 | `api-key` |
| `opencode-go-messages` | `anthropic-messages` | `https://opencode.ai/zen/go/v1` | 8 | `api-key` |
| `opencode-go-responses` | `openai-responses` | `https://opencode.ai/zen/go/v1` | 2 | `api-key` |
| `opencode-zen-responses` | `openai-responses` | `https://opencode.ai/zen/v1` | 14 | `api-key` |
| `opencode-zen-messages` | `anthropic-messages` | `https://opencode.ai/zen/v1` | 16 | `api-key` |
| `opencode-zen-chat` | `openai-chat-completions` | `https://opencode.ai/zen/v1` | 14 | `api-key` |

Account provider rules (10): `account:zai-individual-coding-plan`, `account:zai-team-coding-plan`,
`account:zai-start-plan`, `account:zai-offpeak-idle-plan` (hidden), `account:zai-highspeed-card` (hidden),
and the five BigModel equivalents. Sources: `config/provider/zcode-builtin.json:895-1112`.

### 3.2 Adapters / providers (code)

| Kind | Factory | File:line | Notable options |
| --- | --- | --- | --- |
| `openai` | `createOpenAI` → `.responses` | `model-execution.ts:518-525` | `createOpenAIResponsesJsonCompatFetch` |
| `anthropic` | `createAnthropic` | `:528-535` | `createAnthropicCompatFetch`, forced `Authorization` header `:535` |
| `openai-compatible` | `createOpenAICompatible` | `:538-554` | `includeUsage: true` `:546`, `supportsStructuredOutputs` `:549` |
| `opencode-sdk` | `OpencodeProvider` / `createOpencodeServer` | `:18`,`:20`, branch ~`:430-477` | subprocess lifecycle, workspace-dir assertion `:819-829` |

Adapter modules: 60 files / 15 413 lines under `adapters/src/model/` (verified `ls | wc -l` and
`cat | wc -l`). Notable ones — `runner-stream.ts`
(1752), `runner-debug.ts` (905), `opencode-session.ts` (869), `failure-classifier.ts` (856),
`failure-inspection.ts` (545), `runner-diagnostics.ts` (542), `failure-provider-business-codes.ts` (409),
`anthropic-stream-compat.ts` (378), `tool-transform.ts` (374), `reasoning-history-normalization.ts` (295),
`stream-idle-timeout.ts` (167), `first-token-watchdog.ts` (120), `retry-policy.ts` (120),
`retry-budget.ts` (~60), `empty-completion-retry.ts` (113), `stream-retry-boundary.ts` (31).

### 3.3 Usage / telemetry stores

| Store | Location | Owner | Contents | Retention |
| --- | --- | --- | --- | --- |
| `model_usage` | CLI sqlite `~/.zcode/cli/db/db.sqlite` | CLI runtime | per logical model request, 39 columns | 30 days, prune-on-write |
| `turn_usage` | same | CLI runtime | per user turn aggregate | 30 days |
| `tool_usage` | same | CLI runtime | per tool call, side-effect flags, bytes | 30 days |
| `session_entry` | same | CLI runtime | durable typed entries (model selection, execution state, task terminal…) | session cascade delete |
| in-memory session events | `contracts/src/events/in-memory-session-event-store.ts` | CLI runtime | transient turn-window + slimmed model requests | turn-window + 60 s tick |
| `dwf_*` | same sqlite | dynamic workflow | run/actor/node/event/activity journal | run-scoped |
| OTel traces | remote OTLP | CLI telemetry | span tree, schema v6 | server-side (not client) |
| OTel metrics | remote OTLP | CLI telemetry | 17 metric instruments (`agent-metrics.ts:56-90`) | server-side |
| model-IO JSONL | `~/.zcode/cli/{debug,rollout}` | adapter | full request/response records | 3 files / 64 MiB prod, 256 MiB dev, or unlimited (explicit toggle) |
| `/event/report` | remote HTTP | Desktop Main | product events, `error_msg` always redacted | server-side |
| telemetry state | `~/.zcode/v2/telemetry-state.json` | Desktop Main | `deviceMid`, daily-active dedupe | persistent local |

### 3.4 Eval / benchmark assets

| Asset | Type | Executes models? | Gate |
| --- | --- | --- | --- |
| `scripts/delegation-routing-benchmark.mjs` | paired JSONL scorer | No | baseline vs candidate, per-task |
| `scripts/prism10-experiment-gate.mjs` | paired PRISM scorer | No | ≥20 cases, ≥2 trials, cost ≤1.25×, latency ≤1.3× |
| `apps/zcode-cli/tools/prompt-trajectory` | fixture replay + trajectory recorder | Optionally (proxy) | prompt-continuity expectations |
| `apps/zcode-cli/e2e/{compact-microcompact,file-tools-atomic-write,memory}` | desktop E2E | No (agent mocked/limited) | UI scenarios |
| `docs/model-provider-regression-case-catalog.md` | manual QA catalog | No | human judgement |
| `apps/zcode-cli/packages/core/tests/fixtures` | 3 fixtures (`guarded-deletion-oracle.mjs`, `memory/`, `runtime-input-presentation.json`) | No | unit assertions |
| `packages/provider-node/test/fixtures` | config fixtures | No | config assertions |

---

## 4. Strengths worth preserving

1. **Error taxonomy as a closed contract.** `ModelErrorCode` / `ModelRetryReason` / `ModelFailureReason`
   are exhaustive string unions (`contracts/src/model/index.ts:101-160`) with a single classifier that
   maps 62 sites (`failure-classifier.ts`). Retryability, quota-exhaustion and user-visibility all derive
   from one place instead of provider-message regexes scattered across layers.
2. **Concurrency governor with epoch damping.** The AIMD + epoch + fairness design
   (`concurrency.ts:25-37`, `docs/dynamic-workflow/concurrency.md`) solves burst-429 over-correction and
   run starvation. This is a differentiator worth keeping and generalizing.
3. **Deliberate observability capacity guards that fail silent.** Every telemetry path has a numeric
   bound, a drop counter, and a guarantee not to break the model request
   (`agent-trace-runtime.ts:581`, `model-api-recorder.ts:80`, `runner-debug.ts:531`).
4. **Two-layer redaction with bounded cost.** Header-name allowlist plus substring matching
   (`runner-network-headers.ts`), message regex families with pre/post truncation
   (`error-sanitizer.ts`), media data-URL omission (`runner-debug-redaction.ts`), plus the
   redact-everything policy for `/event/report` `error_msg`. Bounded CPU/memory is explicit
   (`error-sanitizer.ts:56-58`).
5. **Trace/metric semantic separation.** Logical `model_call` vs physical `model_attempt`, with success
   rates defined per level and `zcode.*` as authoritative vs `gen_ai.*` projections
   (`docs/trace/cli-agent-telemetry.md:30-52`). Most products conflate these.
6. **Usage schema breadth.** 39 columns including cache read/write split, reasoning tokens, TTFT, retry
   count, `context_exceeded`, and raw provider usage JSON (`migrations.ts:535-585`). That is enough to
   build a real efficiency dashboard without a schema change.
7. **Turn-window event retention.** The in-memory event store is explicitly bounded and slims retained
   model requests (`in-memory-session-event-store.ts:78-110`), fixing a per-token leak with an
   evidence-based fix rather than a cache guess.
8. **Model-IO size-reset instead of rewrite.** The `runner-debug.ts:524-530` fix (reset rather than
   expand a GB-scale file) is a real production crash fix and the comment records the reason.

---

## 5. Candidate recommendations

All are research candidates; none was implemented. "Competitor evidence needed" marks where a
competitive claim must be verified before this is used in a comparison.

### D-R1 — Monetary cost accounting

- **Problem.** `cost` is a structural field in the message/step contract but is hardcoded `0` on every
  write path; there is no price table anywhere. Any "cost" UI or budget feature would be fabricated.
- **ZCode evidence.** `core/src/runtime/methods/message-persistence.ts:337`,
  `turn-step-finish.ts:29`, `turn-stop.ts:86`,`:137`, `timeline-persistence.ts:130`;
  `contracts/src/interfaces/session-store.port.ts:413`,`:695`; no `cost` column in
  `migrations.ts:532-660`; design intent "not a permanent billing ledger"
  (`apps/zcode-cli/docs/design/v2/usage-observability.md`).
- **Solution + boundaries.** Add an optional `provider_pricing` config block (per provider/model, per
  token type, versioned, user-overridable) and compute cost in `recordModelUsageFact`
  (`usage-observability.ts:60`) from already-captured token fields; store `cost_usd` +
  `pricing_revision` in `model_usage` and surface in the existing `/usage` aggregate. Do **not** compute
  cost inside the adapter; do not gate requests on cost; do not infer prices from model names. Bounded:
  a missing price yields `null`, not `0` (0 is a lie).
- **Effect.** Turns the usage store from volume/latency into a usable spend ledger; unblocks budget
  alerts and per-plan cost attribution.
- **Risk.** S/M. Pricing drift and cache-token semantics (Anthropic cache write vs read) are the real
  hazards; both are already captured as separate fields.
- **Priority.** P1 (highest product value per unit of work in this branch).
- **Acceptance.** Given a priced model and a completed response, `model_usage.cost_usd` equals
  `input×in_price + output×out_price + cache_read×read_price + cache_write×write_price`; unpriced model
  stores `null`; existing token aggregates unchanged.
- **Verification.** Unit test in `usage-query.test.ts` style with a fixture pricing table, plus a
  migration test that old rows read as `NULL`. **Competitor evidence needed** (Codex/Copilot/Cursor cost
  display) before any comparative claim.

### D-R2 — Generalize fallback beyond quota exhaustion

- **Problem.** Fallback fires only on quota signals and only to a *same-model-class* provider. Auth
  failure, TLS/proxy error, repeated 5xx, model deletion, and context overflow produce user-visible
  failure with no configured alternative.
- **ZCode evidence.** `provider-quota-fallback.ts:6`,`:62`,`:105`,`:300-345`; `isSameModelClass`
  `:262-296`; catalog rows `F-FALLBACK-001`, `F-SETTINGS-002` still `[待确认]`
  (`docs/model-provider-regression-case-catalog.md`).
- **Solution + boundaries.** Split "quota fallback" from a new opt-in "degraded fallback" policy:
  a user/workspace setting listing an ordered fallback model per primary, applied for an explicit
  failure-reason subset (auth_failed, network_error, server_error after N retries) and **never** after
  streamed output (reuse `provider-quota-fallback.ts:183-186`). Emit `model_fallback` telemetry with
  `from`/`to`/`reason` (event shape already exists at `:12-16`) and a user-visible notice.
- **Effect.** Converts a hard failure class into a degraded-but-useful turn without silently changing
  the model.
- **Risk.** M. Requires a product decision on consent/visibility; silent fallback is an anti-pattern in
  this repo's own catalog (`F-FALLBACK-001` "不应发生: 所有错误都静默切到第一个模型").
- **Priority.** P2.
- **Acceptance.** With a configured fallback, a primary that fails with `auth_failed` before any output
  results in one fallback attempt, a persisted `model_usage` row per attempt, and a visible notice;
  after any emitted delta, zero fallback attempts.
- **Verification.** Extend `core/tests/provider-quota-fallback.test.ts` with the new reason matrix.
  **Competitor evidence needed.**

### D-R3 — Model-quality evaluation harness

- **Problem.** No executable quality eval exists. Efficiency and reliability are measured; quality is
  not. Both existing "benchmarks" only score externally produced records
  (`delegation-routing-benchmark.mjs:3-7`, `prism10-experiment-gate.mjs:2`).
- **ZCode evidence.** As above; `prompt-trajectory/README.md` §Current limitations records two broken
  capture paths; `testcases/` discovery exists (`src/testcases.ts:21-46`) but no committed case directory.
- **Solution + boundaries.** Add a fixture-driven eval package under `apps/zcode-cli/tools/` that runs a
  small set of repo-native tasks (edit-a-file, run-a-test, fix-a-failing-check) against a configurable
  provider/model matrix, with deterministic graders (exit code, file hash, test result) and a
  paired-report format compatible with the existing gates. Reuse `prompt-trajectory` fixture recording;
  do not add an LLM judge in v1; do not run in CI on every push (cost); do not tier on synthetic
  fixtures.
- **Effect.** Makes model/provider/routing changes falsifiable.
- **Risk.** M/L (fixture maintenance, flakiness, API cost). Gate must require paired arms and ≥2 trials,
  matching `prism10-experiment-gate.mjs:6-8`.
- **Priority.** P1 for research/infra; P3 for user-facing.
- **Acceptance.** One command produces a JSONL with `taskId/arm/success/durationMs/tokens`; the existing
  `delegation-routing-benchmark.mjs` gate accepts it unmodified.
- **Verification.** Run on 2 models × 20 tasks; report success delta with a sign test.
  **Competitor evidence needed** (Codex/Copilot eval transparency).

### D-R4 — Main-agent admission path

- **Problem.** The governor protects subagent traffic only; the main agent is an observer that never
  queues and never honors cooldown (`workflow-concurrency-governor.ts:414-420`). During a large workflow
  run, main-agent requests can still be refused by the provider.
- **ZCode evidence.** `workflow-concurrency-governor.ts:66-70` (observer contract), `:414-420`
  (immediate grant), `docs/dynamic-workflow/concurrency.md` table "the main agent … never queues, never
  waits for cooldown".
- **Solution + boundaries.** Keep the "main agent must never wait behind workflow traffic" guarantee but
  add a **pressure signal**, not a queue: if the bucket is in cooldown or at floor, publish
  `model_request_admitted`-adjacent status so the UI can show "provider is throttling" and optionally
  apply the cooldown to the main agent's *next* attempt only (bounded single wait, not a queue). Do not
  introduce a second state owner; the controller snapshot is already readable (`:430-432`).
- **Effect.** Removes the misleading impression that the product is healthy while the provider is
  refusing everything.
- **Risk.** S/M. Must not regress the "main turn is never blocked" invariant.
- **Priority.** P2.
- **Acceptance.** With the bucket at floor and cooling down, the main agent's first attempt still goes
  out immediately; the UI receives a throttling status; a second attempt within the cooldown waits at
  most one Retry-After window.
- **Verification.** `concurrency.test.ts` plus a governor integration test with a fake clock.
  **Competitor evidence needed.**

### D-R5 — Telemetry user opt-out and retention disclosure

- **Problem.** Telemetry enablement is env/build-level only; there is no Settings control and no
  in-repo statement of remote retention.
- **ZCode evidence.** `bootstrap.ts:124` (`ZCODE_MODEL_TELEMETRY_ENABLED`), `telemetryCore.ts:418`
  (build-time endpoint only); repo-wide search found no `DO_NOT_TRACK` or user toggle; remote retention
  absent from `docs/monitoring/event-report-delivery-reliability.md` and
  `docs/trace/cli-agent-telemetry.md`.
- **Solution + boundaries.** Add a single Settings switch that sets both the `/event/report` and OTel
  enablement for the process, with a restart-or-live effect documented; publish actual server retention
  in `docs/monitoring/`. Do not weaken the existing redaction; do not add a second telemetry state owner
  (extend `app-runtime-preferences`).
- **Effect.** Removes a compliance and trust gap and makes the "privacy-first" position verifiable.
- **Risk.** M. Requires product/legal input on retention numbers; do not invent them.
- **Priority.** P2 for enterprise; P3 otherwise.
- **Acceptance.** Toggling off produces zero OTLP export and zero `/event/report` POSTs in a live run;
  toggling on restores both without losing `deviceMid`.
- **Verification.** `bootstrap.test.ts` extension + an Electron E2E observing the absence of requests.
  **Competitor evidence needed** (Codex/Copilot telemetry settings).

### D-R6 — Usage retention: make startup prune real and `all` honest

- **Problem.** Design doc claims pruning "on startup or after writes"; implementation prunes only on
  write. `range: "all"` therefore silently means "≤30 days", which will be read as a bug by users.
- **ZCode evidence.** `usage.ts:17-18`,`:335-355`; only write-path callers (`:163`,`:256`,`:332`);
  `server-operations.ts:1895` `since = 0` for `"all"`;
  `apps/zcode-cli/docs/design/v2/usage-observability.md` §Retention.
- **Solution + boundaries.** Add one `pruneUsage()` call at store open (bounded, transactional, logged
  once) and either (a) rename the range to `since-retention` or (b) surface the effective earliest date
  in the snapshot so the UI can label it. Do not extend retention without a size budget.
- **Effect.** Removes a silent data-semantics mismatch with a two-line change.
- **Risk.** S.
- **Priority.** P1 (cheap, correctness).
- **Acceptance.** Opening a store with rows older than 30 days removes them exactly once; the snapshot
  reports `earliestAvailableAt`; UI can show "since <date>" for `all`.
- **Verification.** `usage-query.test.ts` + `session-store.test.ts:2958` style tests.

### D-R7 — Model-IO full-retention guardrails

- **Problem.** The "keep everything" toggle (`runner-debug.ts:487-495`) has no disk budget at all; a
  single long session can grow without bound, and the setting is global (not per session).
- **ZCode evidence.** `docs/model-io-full-retention-setting.md` ("不淘汰旧 session 文件，不按单 session
  容量重置"); `runner-debug.ts:487-492` returns before rotation and size checks.
- **Solution + boundaries.** Add a high but finite ceiling and a single `warn` once per session when it
  is crossed; keep "no pruning/compaction" semantics otherwise, so the diagnostic guarantee holds.
  Do not silently truncate records.
- **Effect.** Prevents the diagnostic mode from becoming a disk-filling failure mode on shared hosts.
- **Risk.** S.
- **Priority.** P2.
- **Acceptance.** With full retention on and the ceiling set, writes continue but a single warning is
  emitted; no record is dropped or compacted.
- **Verification.** `runner-debug` unit test with a fake size threshold.

---

## 6. Open questions, unverified areas, failed commands

**Unverified / not run (and why):**

1. **No tests were executed.** This is a research-only branch; per the hard constraint no dev servers or
   long processes were started. All test counts above are static counts of `it(`/`test(` occurrences, not
   passing results.
2. **`pnpm typecheck` / `pnpm lint` were not run.** They are not evidence for narrative research and
   would take significant time; the branch made no code change to check.
3. **Remote retention is unknown.** Neither `docs/trace/cli-agent-telemetry.md` nor
   `docs/monitoring/event-report-delivery-reliability.md` states server-side retention. Marked "unknown",
   not "absent".
4. **`config/default.json` and `config/provider/zcode-builtin.test.json` were not fully read** — only the
   builtin production catalog was enumerated. The test catalog may differ in provider coverage.
5. **`packages/provider-node` sync/download integrity was only partially inspected.** I confirmed a
   sha256 `sourceKey` and a release-signature comparison (`zcode-builtin-provider-config-source.ts:41`,
   `:220`) but did not trace whether the downloaded payload is content-verified against a signature.
6. **`opencode-sdk` provider semantics are not fully traced.** The `OpencodeProvider` lifecycle and the
   prompt projection (`projectOpenCodePrompt`, `model-execution.ts:~600`) were read at a high level only;
   tool-protocol compatibility claims should be re-verified before being stated as facts.
7. **No competitor evidence was collected.** Every competitor-dependent recommendation above is marked
   "Competitor evidence needed" and must not be used as a comparative claim until sourced.
8. **`request-security-edition/recovery.ts` is a stub in this checkout** (`:1-24` returns
   `extraAttempts = 0`, `claim() → false`, empty-stream error `undefined`). Whether a full edition exists
   in another build configuration is unknown from this checkout; it may be an edition-selection
   artifact rather than a missing feature.
9. **`prism10` / `delegation-routing-benchmark` were not executed**; their gate thresholds are read from
   source, not observed.
10. `rg` patterns containing `\b` / parentheses inside a `-rn` pipe produced a shell regex error once
    (`rg: regex parse error`); the query was rerun with a corrected pattern. No conclusion depends on the
    failed invocation.

**Checked areas with no significant gap found** (so they are not repeated as recommendations):

- Error taxonomy completeness and retryability mapping (`contracts/src/model/index.ts:101-160`,
  `failure-classifier.ts`, 45 tests).
- Trace/metric semantic separation and schema versioning (`docs/trace/cli-agent-telemetry.md`, schema v6).
- Metric label cardinality control (`agent-metrics.ts:195-226`) and histogram bucket capping
  (`otlp-cost-controls.test.ts:71-80`).
- Trace sampling correctness — parent-based, no partial trees (`otlp-cost-controls.test.ts:20-63`).
- Secret redaction coverage for headers, query params, known key formats, emails and paths
  (`error-sanitizer.ts:59-89`, `runner-network-headers.ts:20-42`).
- Telemetry never blocking the model path (`model-api-recorder.ts:80-96`, `runner-debug.ts:531`).
- Duplicate provider/model detection and atomic registry swap (`registry.ts:94-108`,`:143`,`:160`).
- Config overlay ordering and account fail-closed behavior (`sources.ts:68-90`, `resolver.ts:186-221`).
- Model-IO capacity/rotation for bounded mode (`runner-debug.ts:35-42`, `:493-530`).
- Usage schema breadth and index coverage (`migrations.ts:535-658`).
- Concurrency governor fairness and burst damping (`workflow-concurrency-governor.ts:36-42`,
  `concurrency.ts:25-37`).
- Stream backpressure at three boundaries (`docs/performance/streaming-tool-input-backpressure.md`).
- Log export exclusions for credentials, debug dirs, agent-config and certs
  (`docs/desktop/log-export-retention.md`).

---

## 7. Appendix (Russian narrative)

### 7.1 Что проверено и на каком основании

Работа велась только чтением: `git rev-parse`, `date -u`, `rg -n`, `node -e` по JSON-каталогу и чтение
исходников. Рабочее дерево на момент старта чистое, ветка `dev`, HEAD `d10f0b69`. CodeIndex находился
в состоянии `ready` без диагностики, поэтому навигация шла по индексу и точечным grep, без широкого
обхода репозитория.

Ключевой вывод по методу: все утверждения ниже либо подтверждены `file:line`, либо помечены как
`inference` (вывод) или `unknown` (нет данных). Числа тестов — это статический подсчёт вхождений
`it(`/`test(`, а не результат прогона: тесты в этой ветке не запускались, потому что задача
исследовательская и запрещает долгие процессы.

### 7.2 Модели и провайдеры

Рантайм — обёртка над Vercel AI SDK v6, а не собственный HTTP-клиент. Реально существует четыре
исполняемых вида провайдера: `openai` (только Responses API), `anthropic`, `openai-compatible` и
`opencode-sdk` (внешний процесс). Всё остальное разнообразие — это конфигурация: 25 шаблонов в
`config/provider/zcode-builtin.json`, из них 15 внешних вендоров и 10 наборов `opencode-*`, плюс
10 account-правил для Z.ai/BigModel.

Слоёв конфигурации ровно три плюс динамический: builtin, account overlay, personal и
runtime-discovered. Порядок наложения жёстко зафиксирован в `resolver.ts:186-221`, а признаки
`executable`/`selectable` вычисляются конъюнкцией четырёх условий (`:263-284`). Дубликаты
провайдеров и моделей — жёсткая ошибка (`registry.ts:143`,`:160`), а `replace()` сначала полностью
валидирует кандидат и только потом меняет индексы.

Правила модели — это упорядоченные оверлеи с отдельным вторым проходом после выбора маршрута
(`model-config.ts:432`), поэтому API-специфичные рекомендации не могут переписать выбранный
`api`/`baseUrl`. Это аккуратное решение, которое стоит сохранить.

Token-лимиты: базовый output 32 000, preflight-ограничение `contextWindow - usage - 1000`,
context window по умолчанию 200 000, резерв авто-компакции 32 000, буфер 13 000. Строка `legacy` в
стратегии бюджета всё ещё принимается, хотя фактически обе ветки идут по preflight; это чистая
техническая задолженность, а не дефект.

### 7.3 Routing, fallback, retry

Маршрутизация эндпоинта выполняется на каждую попытку и не кэшируется по провайдеру — в коде прямо
записано, почему (`model-execution.ts:484`): иначе при смене аккаунта можно переиспользовать чужой
`apiKeyId`. Это правильный выбор.

Fallback — самое узкое место продуктовой логики. Он срабатывает только по квоте (402,
`insufficient_balance`, `FreeUsageLimitError`, 429 с Retry-After больше 10 минут), максимум три
попытки, и только на модель того же класса. После первого отданного события потока fallback
запрещён. Следствие: у пользователя с одним провайдером fallback фактически отсутствует, а ошибки
авторизации, сети, TLS и удаления модели не имеют альтернативы. В каталоге регрессий строка
`F-FALLBACK-001` до сих пор помечена `[待确认]` — то есть продукт сам ещё не решил, как это должно
работать.

Retry-политика агрессивна: 10 повторов, 2 с база, ×2, потолок 60 с, джиттер. В сочетании с
90-секундным watchdog первого токена и 600-секундным idle это допускает очень долгое зависание;
комментарий в `first-token-watchdog.ts:6-8` честно говорит, что суммарно это «может длиться часами».

### 7.4 Учёт использования и стоимость

Токен-учёт сильный: 39 колонок в `model_usage`, раздельные cache read/write, reasoning, TTFT,
retry count, `context_exceeded`, raw usage JSON, четыре индекса. Это готовая основа для дашборда
эффективности без изменения схемы.

Денег нет вообще. Поле `cost` существует в контракте сообщения и части шага, но везде
записывается литералом `0` (пять мест), а в таблицах использования колонки стоимости нет. Дизайн-спека
прямо говорит, что usage — не биллинговый журнал. Любая фича «сколько я потратил» сегодня была бы
выдумкой. Это рекомендация №1 по соотношению пользы и трудозатрат.

Ретенция: 30 дней, удаление выполняется внутри каждой записи в транзакции `begin immediate`.
Дизайн-документ обещает также prune на старте, но в коде такого вызова нет. Диапазон `all` в API
фактически означает «не больше 30 дней», потому что старые строки уже удалены — это стоит либо
переименовать, либо показать пользователю реальную раннюю дату.

### 7.5 Телеметрия, логи, трейсы, ошибки

Логирование разделено на три слоя с разными владельцами: событие сессии (восстанавливаемые факты),
структурный JSONL (диагностический индекс с редактированием) и span (тайминг и причинность).
Продовый renderer молчит по `import.meta.env.PROD`, сервисный логгер минимален.

Трассы — schema v6, дерево `agent_turn → agent_step → model_call → model_attempt`, плюс
`tool_execution`, `command_execution`, `context_compaction`, `detached_operation`. Разделение
логического вызова и физической попытки с разными знаменателями для success rate — сильная сторона,
которую большинство продуктов путают. Атрибуты `zcode.*` объявлены авторитетными, `gen_ai.*` —
только проекция.

Метрики ограничены allowlist по каждому span, гистограммы не более 10 бакетов, min/max отключены,
сэмплирование трасс 10 % с наследованием решения родителя, поэтому не бывает обрезанных деревьев.
Это осознанная политика контроля стоимости, а не случайность.

Таксономия ошибок — закрытые строковые объединения (14 кодов, 10 причин повтора, плюс 8 в
`ModelFailureReason`) и единственный классификатор с 62 точками отображения. 45 тестов на
классификатор. Это одна из самых зрелых частей ветки.

Санитайзер ошибок — двухступенчатый: обрезка до 4096, тринадцать семейств регулярных выражений,
финальная обрезка до 2048, глубина цепочки 8, защита от циклов, и WeakSet-«claim», чтобы тело одной
ошибки не дублировалось на всех родительских span. Для `/event/report` выбран ещё более строгий
подход: весь `error_msg` заменяется на `[redacted]` без попытки угадать секрет.

Телеметрия имеет защиту по ёмкости: 5000 активных writers, 1000 активных вызовов, 30 минут возраст вызова,
счётчик отброшенных span и полная изоляция исключений, чтобы наблюдаемость никогда не ломала
основной запрос.

### 7.6 Производительность, надёжность, конкурентность

Лучший инженерный артефакт ветки — процессный AIMD-регулятор конкурентности по ключу
`provider/model`. В нём есть три нетривиальные вещи: демпфирование всплеска через epoch (волна из
13 запросов даёт ровно одно снижение cap), возврат к «хорошему» уровню вместо повторного умножения, и
честная очередь по run'ам с ротацией, чтобы один крупный run не заморил маленький. Спецификация
(`docs/dynamic-workflow/concurrency.md`) подробнее, чем обычно бывает документация.

Ограничение: главный агент в этом механизме — только наблюдатель, он никогда не ждёт и не уважает
cooldown. Это защищает отзывчивость основного чата, но означает, что при насыщении провайдера
запросами workflow основной агент всё равно получит 429 и не покажет пользователю, что провайдер
тормозит.

Фоновые границы тоже аккуратны: backpressure на трёх уровнях (протокольный сервер, UI-проекция,
дедупликация tool input), три независимых таймаута (первый токен 90 с, idle 600 с с шагом +30 с,
HTTP 3–5 с), цепочка AbortSignal от родителя к попытке.

Слабых мест два. Первое — нет полноценного circuit breaker с состояниями open/half-open: AIMD-пол и
cooldown из Retry-After играют его роль только для workflow-трафика. Второе — нет единого контракта
возобновления сессии после падения провайдера посреди хода; восстановление существует послойно
(событийный журнал, retry-safe prelude, «не переигрывать после видимого вывода»), но не как
продуктовая гарантия.

### 7.7 Оценки качества (evals)

Это самый большой пробел. В репозитории нет исполняемого eval-харнесса качества моделей: ни
golden-set, ни pass@k, ни LLM-judge, ни лидерборда. Оба «бенчмарка» скорее являются гейтами для
внешне записанных данных: `delegation-routing-benchmark.mjs` прямо пишет, что никогда не запускает
модель, а `prism10-experiment-gate.mjs` оценивает внешние PRISM-пары с порогами 20 кейсов, 2 прогона,
стоимость ≤1.25×, задержка ≤1.3×. Инструмент `prompt-trajectory` — это воспроизведение фикстур для
проверки сборки промпта, и его собственный README фиксирует две сломанные команды на 2026-10-14.

Итог: ZCode умеет измерять эффективность (токены, TTFT, байты инструментов, конкурентность) и
надёжность (исходы классификатора) гораздо лучше, чем качество. Связи между сменой модели или
провайдера и метрикой успеха задачи нет.

### 7.8 Данные, приватность, хранение

Учётные данные лежат в `credentials.json` и шифруются через `cipherProvider`; комментарий в коде
фиксирует, что переход на safeStorage/Keychain — будущая работа. Файлы учётных данных исключены из
ручного экспорта логов и из полных архивов обратной связи.

Экспорт логов ограничен тремя днями по mtime и исключает `agent-config/**`, `certs/**`, любой
сегмент `debug`, вышедшие из эксплуатации ACP-каталоги, кэши и `node_modules`.

Разделение корней хранения (`~/.zcode` и `{dataBaseDir}/.zcode`) — осознанная продуктовая граница,
а не дефект: она зафиксирована в документации и проверяется E2E-тестом. Model-IO при этом жёстко
пишется в `homedir()/.zcode/cli/{debug,rollout}` и не следует настройке каталога данных.

Отключение телеметрии существует только на уровне сборки/переменных окружения (`OTEL_*` плюс
`ZCODE_MODEL_TELEMETRY_ENABLED=0` для CLI; build-time endpoint для `/event/report`). Пользовательского
переключателя в настройках и обработки `DO_NOT_TRACK` не найдено. Ретенция на серверной стороне в
репозитории не описана — это `unknown`, а не «отсутствует».

### 7.9 Что стоит сохранить и что делать дальше

Сохранить: закрытую таксономию ошибок, AIMD-регулятор с epoch-демпфированием, молчаливую и
ограниченную наблюдаемость, двухслойное редактирование секретов, разделение логического и физического
уровня в трассах, широту схемы usage.

Делать в первую очередь: учёт денежной стоимости (D-R1), честный `all` и prune на старте (D-R6),
затем — eval-харнесс качества (D-R3) и расширение fallback по явной продуктовой политике (D-R2).
Опционально: сигнал давления провайдера для главного агента (D-R4), пользовательский opt-out
телеметрии с публикацией ретенции (D-R5), потолок для режима полного сохранения model-IO (D-R7).

Ни одна из рекомендаций не реализована и не проверена запуском тестов. Все конкурентные сравнения
помечены как требующие отдельного сбора доказательств.
