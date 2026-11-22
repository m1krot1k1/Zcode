# Provider model autodiscovery

## Product rules

- After a personal Provider's credential fields (`api.baseUrl` or `access.apiKey`) are saved successfully, ZCode asks that Provider's own `GET <api.baseUrl>/models` endpoint for its model catalog. Discovery never blocks, delays, or rolls back the save.
- The Provider response is the source of truth for every field it reports. `models.dev` only fills fields the Provider response omitted. A field no source reports stays unset; ZCode never guesses, derives, or hardcodes context/output limits or reasoning levels.

| Field             | Source of truth                                                     | Fallback                                                          |
| ----------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `id`              | `/models` `id` (non-empty)                                          | none — the entry is skipped                                       |
| `displayName`     | `/models` `name`                                                    | `id`                                                              |
| `contextWindow`   | `/models` `limit.context`                                           | `models.dev` `limit.context` for the same Provider and model ID   |
| `maxOutput`       | `/models` `limit.output`                                            | `models.dev` `limit.output` for the same Provider and model ID    |
| `reasoningEffort` | `/models` `capabilities.reasoning.effort` when `supported === true` | none — levels are only copied verbatim from the Provider response |

- Resolution order per field is: Provider response, then `models.dev`, then unset. A later source never overrides an earlier one, and an ambiguous `models.dev` match (same model ID under several Providers) is treated as no match.
- `models.dev` is read from `<ZCode data root>/models-dev-cache.json` with a 24 hour TTL. A fresh cache is used without network access. A stale cache is served immediately and refreshed in the background. Without a cache, one bounded request is attempted; if it fails, models are imported without enrichment and no error is surfaced.
- `importDiscoveredModels` creates an ordinary personal model per discovered ID through `addPersonalModel`, skipping IDs that already exist (built-in or personal). It writes `properties.contextWindow` and `optionSpecs.maxOutputTokens.max` when known, and `optionSpecs.reasoningLevel.values` only when the Provider reported them. Existing manual model edits are never overwritten.
- Discovery and import are best-effort: transport failures, timeouts, a missing Provider, invalid JSON, or a single failing model return an empty/partial result and are logged at `warn`; they are never thrown to the caller.
- `reasoningLevel`/`maxOutputTokens` API maps keep coming from the existing `modelConfigRules.modelApiRules`; autodiscovery does not duplicate them.

## Verification scenarios

1. `/models` returns context, output and reasoning efforts → imported models carry all three fields.
2. `/models` returns IDs only → models are imported with an empty context and no error.
3. Provider endpoint is unreachable → empty list, no error, the provider save still succeeds.
4. Context badge formatter: `1000000` → `1M`, `128000` → `128K`, `undefined` → no badge.
