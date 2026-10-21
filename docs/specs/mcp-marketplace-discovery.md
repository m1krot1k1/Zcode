# MCP marketplace discovery from Cline

## Status and scope

This spec defines a bounded MCP marketplace discovery slice for the ZCode MCP settings surface. It adds read-only discovery from Cline's known catalog endpoint while keeping ZCode's bundled catalog as the only source of executable install configuration.

This is not a verified package marketplace. The remote feed is not signed, and ZCode does not verify npm package integrity or transitive dependency integrity. The UI must not claim that a Cline listing or a configured package is verified by ZCode.

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
Later normal MCP lifecycle -> Host starts/checks configured server
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
| Configure a feed ID present in local allowlist | existing form draft from the matching local preset                                              | existing MCP settings service after explicit Save | command/args/auth/version/source come from local code only                   |
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
