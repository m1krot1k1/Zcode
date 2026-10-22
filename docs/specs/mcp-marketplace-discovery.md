# MCP marketplace discovery from Cline

## Status and scope

This spec defines a bounded MCP marketplace discovery slice for the ZCode MCP settings surface. It adds read-only discovery from Cline's known catalog endpoint while keeping ZCode's bundled catalog as the only source of executable install configuration. The bundled catalog may contain reviewed, OS-neutral hosted MCP endpoint presets as well as pinned local stdio packages.

This is not a verified package marketplace. The remote feed is not signed, and ZCode does not verify npm package integrity or transitive dependency integrity. The UI must not claim that a Cline listing or a configured package is verified by ZCode.

## Cline IDE profile discovery

The MCP import source resolves one Cline settings file using this precedence: explicit `CLINE_MCP_SETTINGS_PATH`, `CLINE_DATA_DIR`, `CLINE_DIR`, then an existing Cline extension profile in a supported editor, then the standard `~/.cline/data/settings/cline_mcp_settings.json` fallback. The editor profile is `globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`, under the platform's normal user-data root for VS Code Stable, VS Code Insiders, Cursor, or VSCodium. The order is deterministic and only exact known filenames are checked; ZCode does not recursively scan editor profiles or import unrelated settings. If no candidate exists, the standard Cline CLI path remains the diagnostic source path. Existing parsing, secret filtering, and explicit import/save behavior are unchanged.

Acceptance evidence: path resolver unit tests cover explicit override precedence, each platform's user-data root, editor ordering, first-existing selection, and fallback when no profile exists. Import tests prove the selected IDE profile is the source path and keep credential values out of diagnostics.

## Curated npm package pins and provenance

Every curated npm stdio preset must name an exact direct-package version in both its `version` field and generated `npx` arguments (`package@version`). The following versions and license identifiers were checked against the npm registry package metadata on 2026-10-21. The repository links identify the upstream source recorded by npm; npm package pages are the package/version metadata source of record.

| Preset          | npm package             | Exact version | npm license metadata | npm package metadata                                                       | Upstream repository                                                                         |
| --------------- | ----------------------- | ------------- | -------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Context7        | `@upstash/context7-mcp` | `4.4.1`       | MIT                  | [npm package](https://www.npmjs.com/package/@upstash/context7-mcp/v/4.4.1) | [upstash/context7](https://github.com/upstash/context7)                                     |
| Chrome DevTools | `chrome-devtools-mcp`   | `1.9.0`       | Apache-2.0           | [npm package](https://www.npmjs.com/package/chrome-devtools-mcp/v/1.9.0)   | [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) |
| Playwright      | `@playwright/mcp`       | `0.0.83`      | Apache-2.0           | [npm package](https://www.npmjs.com/package/@playwright/mcp/v/0.0.83)      | [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp)                     |
| DuckDuckGo      | `duckduckgo-mcp-server` | `0.1.2`       | MIT                  | [npm package](https://www.npmjs.com/package/duckduckgo-mcp-server/v/0.1.2) | [zhsama/duckduckgo-mcp-server](https://github.com/zhsama/duckduckgo-mcp-server)             |
| Web Fetch       | `@yawlabs/fetch-mcp`    | `0.8.5`       | MIT                  | [npm package](https://www.npmjs.com/package/@yawlabs/fetch-mcp/v/0.8.5)    | [YawLabs/fetch-mcp](https://github.com/YawLabs/fetch-mcp)                                   |
| Firecrawl       | `firecrawl-mcp`         | `3.33.0`      | MIT                  | [npm package](https://www.npmjs.com/package/firecrawl-mcp/v/3.33.0)        | [firecrawl/firecrawl-mcp-server](https://github.com/firecrawl/firecrawl-mcp-server)         |

These pins make the selected top-level package version explicit; they do not lock or attest its transitive dependencies, publisher identity, tarball integrity beyond npm's normal transport/metadata, or runtime behavior. License values are publisher-supplied npm metadata, not a legal review. A version/license change requires updating this record and the matching code/test pin together.

## Curated hosted endpoint presets

These hosted endpoints are independent of local OS paths and package installation. Authentication is performed by the user through the existing MCP HTTP connection flow; the catalog never contains tokens, OAuth state, account-specific site IDs, or local paths. Product access and the provider's pricing terms still apply. Labels in the UI are descriptive requirements, not guarantees of free usage.

| Preset  | Official endpoint / source                                                                                                                                                                               | Authentication                                                            | Usage label and scope                                                                                                                                                                                   |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Todoist | [official MCP setup](https://developer.todoist.com/), [official server repository](https://github.com/Doist/todoist-mcp)                                                                                 | Provider-hosted OAuth authorization; no token is bundled.                 | Official developer hub says the MCP is free to use with any Todoist account; account/service conditions may apply.                                                                                      |
| Webflow | [official MCP setup](https://developers.webflow.com/mcp/reference/getting-started), [plan and permission details](https://help.webflow.com/hc/en-us/articles/52536562285203-Webflow-MCP-server-overview) | Provider-hosted OAuth; user selects the sites or Workspaces to authorize. | Available on Webflow Site plans including Starter. MCP usage does not consume Webflow AI credits; the connected AI tool's plan/credits may apply. No public official server source/license is asserted. |
| Apify   | [official MCP guide](https://docs.apify.com/mcp), [official repository](https://github.com/apify/apify-mcp-server)                                                                                       | Provider-hosted OAuth or user-supplied Bearer token.                      | Discovery/docs subset can be used without auth; Actor execution and account data require auth and may incur Actor/platform charges. Never describe arbitrary Actors as free.                            |

The endpoint and auth claims above were checked against vendor primary sources on 2026-10-22. Prices, included quotas, and provider product behavior can change; do not encode them as guaranteed entitlements. Browserbase is deliberately excluded: its [official setup](https://docs.browserbase.com/integrations/mcp/setup) requires the API key as a query parameter, while the current MCP HTTP config contract safely supports OAuth or request headers only. Putting that credential in the persisted URL would leak it into configuration and diagnostics; add this provider only after the contract supports secret query parameters without persistence or logging. Its old stdio repository reports Apache-2.0 but is archived (2026-07-20). Todoist's official npm package currently reports MIT and Node >=24/npm >=11; it is not used by this remote preset. Apify's official repository reports MIT; the hosted preset does not bundle its package. Webflow publishes hosted setup documentation but no official server source/license was established here.

Accepted case: hosted presets produce only HTTP MCP configs with the vendor endpoint and empty auth configuration. The existing MCP protocol handshake performs OAuth when supported; for API-key providers the user enters their credential in the existing HTTP headers editor. Catalog selection remains a draft and never persists a server or starts a connection. UI must show the auth method and any relevant usage scope before selection. No preset may contain credentials or static absolute paths.

Accepted case: each curated npm stdio preset has a non-empty exact `version`, and its setup arguments end in precisely `<packageName>@<version>`. Cline feed metadata cannot change those values.

## Ownership

- `IMcpSyncService` is the only UI-facing service used to load MCP marketplace metadata. The service implementation performs network I/O and returns parsed metadata; the UI never fetches the feed directly.
- The immutable `COMMUNITY_MCP_PRESETS` list in `@zcode/shared` owns all executable setup values: command, args, package/version, auth requirement, and source URL.
- The settings form and existing MCP settings service remain the only owners of user configuration writes. Loading or selecting a marketplace entry does not persist config or launch that newly selected listing. Existing saved servers continue through the current settings/status lifecycle.
- Cline's feed owns only untrusted discovery metadata. It never owns command, args, environment variables, HTTP headers, credentials, package version, transport, or enabled state.

## Feed and parser contract

- The endpoint is the fixed `https://cline.github.io/marketplace/catalog.json`; there is no user-supplied catalog URL in this slice.
- The request is Host-side, GET-only, has a short timeout, uses `redirect: "error"`, requires a JSON content type, and enforces a bounded response body and entry count.
- The root must be an object with an `entries` array. Only records whose `type` is `mcp` are candidates. IDs, labels, text, tags, and HTTPS links have bounded lengths and reject C0/C1 and Unicode bidi control characters or malformed values. The Cline author may be a string or `{ name, url }`; only a sanitized bounded name is displayed.
- A malformed root fails the catalog load. Malformed individual entries are omitted and counted in a sanitized warning; duplicate normalized IDs are omitted to prevent ambiguous cards. Raw response text, package args, secrets, and server-provided error bodies are not logged or returned to UI.
- Returned records expose discovery metadata only: stable ID, name, optional descriptive text/tags/author, validated source/homepage links, and whether their ID corresponds to an existing local curated preset. Raw `install` configuration is discarded.
- An entry matching a local curated preset may open the existing Configure draft using the local preset object. It never uses remote feed fields to form that draft. An unknown feed entry is visible as an external listing and has no Install/Configure action.
- The built-in catalog remains visible and usable if the feed is unavailable. Feed load failure is represented as an explicit unavailable state with a retry action; it does not remove or alter bundled presets.

## Trust and threat model

- HTTPS and the fixed hostname protect transport under the host's normal certificate trust; they do not authenticate catalog contents independently of Cline's hosting/release pipeline.
- A compromised Cline catalog, Cline hosting account, or TLS trust chain could inject misleading metadata or links. Metadata is rendered as text, external links are opened only after an explicit user action, no feed command can be executed, and unknown entries cannot be installed from the feed.
- A malicious/misleading feed entry reusing a bundled ID cannot alter its local package, command, args, version, auth fields, or source URL. A matching ID can only lead to the existing local preset's editable draft.
- A compromised package publisher/registry, or compromised transitive dependency, remains outside this slice's guarantees. A configured stdio package may execute code under the existing MCP runtime when the user saves/enables it and a session starts. The settings UI must retain the current explicit save and runtime lifecycle.
- No GitHub/npm signing key, new registry, OAuth credential, or Cline auth state is introduced or trusted by this feature.

## Event order

```text
Open MCP settings -> UI requests IMcpSyncService.loadMarketplaceCatalog
                  -> Host fetches fixed Cline catalog -> bounded parser
                  -> UI displays discovery records and local bundled presets
Select a known bundled entry -> local preset creates editable draft
Save in existing settings form -> existing MCP settings owner persists config
Later normal MCP lifecycle -> Host connects to configured HTTP endpoint
                  -> OAuth challenge opens existing authorization action, or
                     user-provided API key header authenticates the request
```

Closing settings or discarding a draft does not persist or launch the selected listing. Status checks for already saved MCP servers continue through the existing lifecycle. A stale catalog response from an earlier refresh cannot overwrite a later refresh result.

## Accepted cases

| Case       | Setup/action                                                                                                        | Required assertions                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCPDISC-01 | Load valid feed containing MCP and non-MCP entries.                                                                 | Only bounded MCP metadata is returned; raw install args, env, headers, OAuth, and commands are absent.                                                           |
| MCPDISC-02 | Feed entry ID matches a local preset but has hostile command/args/auth/version.                                     | UI action uses the exact local preset values; no feed-provided executable data is reachable from the configure draft.                                            |
| MCPDISC-03 | Feed contains an unknown MCP entry.                                                                                 | Metadata is visible with an external/unverified label; there is no Install or Configure action.                                                                  |
| MCPDISC-04 | Feed has invalid root, non-JSON content type, redirect, oversized body, timeout, malformed entry, or duplicate IDs. | Invalid loads fail closed; invalid records are omitted with a sanitized count; no raw body is surfaced.                                                          |
| MCPDISC-05 | Feed is unavailable.                                                                                                | Static bundled presets remain available, error state and retry are shown, and no preset/config state changes.                                                    |
| MCPDISC-06 | Load settings, refresh, select a bundled preset, then discard the form.                                             | Loading/refreshing/selecting/discarding creates no persistent config and does not launch that unsaved preset; existing saved-server status checks are unchanged. |
| MCPDISC-07 | Select a bundled preset and explicitly save via existing form.                                                      | Existing settings owner writes the locally owned config; existing status/handshake path is responsible for runtime evidence.                                     |
| MCPDISC-08 | Select each hosted preset and inspect the generated draft and catalog warnings.                                     | Draft is HTTP with exact vendor URL, no embedded secret. UI states OAuth/API-key requirement and usage limits before Configure.                                  |

## Evidence limits

Parser and service fixture tests prove input bounds, fail-closed handling, sanitization, and that remote install fields cannot become executable config. UI tests prove state presentation, local allowlist routing, and absence of actions for unknown entries. An integration test with the existing MCP settings owner can prove explicit-save behavior. None of these proves Cline feed authenticity, npm package integrity, package safety, successful third-party service auth, or runtime tool correctness. Those require independent upstream signing/integrity evidence and a real MCP handshake, which are outside this slice.

## Impact brief and coverage plan

| Field                   | Decision                                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability              | `capability.mcp-curated-catalog`                                                                                                               |
| Change layers           | option-source, presentation, commit-effect boundary                                                                                            |
| Primary UI surface      | MCP settings catalog inside `McpSettingsSection`                                                                                               |
| Feed owner              | existing Host service instance behind `IMcpSyncService`                                                                                        |
| Executable config owner | `COMMUNITY_MCP_PRESETS` in shared; only the existing MCP form/save flow writes settings                                                        |
| Out of scope            | plugin marketplace lifecycle, arbitrary catalog installation, Cline OAuth token migration, package integrity verification, MCP runtime changes |

| User scenario                                  | UI/state owner                                                                                  | Commit sink                                       | Mode/invariant                                                               |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| Browse built-in presets                        | existing settings component; immutable shared presets                                           | none until existing form Save                     | works offline; never starts a process on render                              |
| Browse Cline feed                              | settings component holds loading/result/error projection; Host `IMcpSyncService` fetches/parses | none                                              | fixed HTTPS origin; no renderer fetch; feed fields never configure execution |
| Configure a feed ID present in local allowlist | existing form draft from the matching local preset                                              | existing MCP settings service after explicit Save | endpoint/command/args/auth/version/source come from local code only          |
| Browse an unknown feed ID                      | external listing card                                                                           | none                                              | visible metadata only; no configure/install action                           |

| Candidate                                    | Disposition | Guard / reason                                                                                     |
| -------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------- |
| Remote catalog metadata refresh              | accepted    | GET fixed Cline URL via Host service, bounded response/parser, explicit loading/error/retry states |
| Unknown feed entry one-click install         | pruned      | feed is unsigned and must not supply executable config                                             |
| Cline import credentials copied into catalog | pruned      | imports and marketplace discovery are distinct flows; Cline auth state is not trusted/migrated     |
| Feed failure removes bundled options         | pruned      | local curated list remains the existing offline source                                             |
| Feed ID collision changes a preset's command | pruned      | only exact local preset object can create a draft                                                  |

| Case                   | Coverage target                                          | Evidence                                                                                                   |
| ---------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| MCPDISC-01/02/03/04/05 | shared parser and `mcpSyncService.test.ts` fixtures      | validated metadata only, local allowlist authority, hostile/malformed input rejection, no network in tests |
| MCPDISC-03/05/06       | `mcpCommunityCatalog.test.ts`                            | unknown listing has no action; error/retry/static catalog behavior; selecting/discarding does not save     |
| MCPDISC-07             | `mcpSettings.test.ts` plus existing settings owner tests | only explicit Save reaches persistence; real runtime handshake remains a separate integration proof        |

Codegraph is not available in this environment; direct callers and ownership were checked from current source and the feature graph. The planned graph delta adds the discovery service/parser code seeds and this spec to the existing MCP catalog capability; it does not create a new product surface or settings owner.
