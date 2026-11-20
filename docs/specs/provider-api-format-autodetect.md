# Provider API format auto-detection

## Goal

A custom provider should not ask the user to guess between Anthropic messages,
Chat Completions, and Responses. When a connection is first saved or its base
URL changes, ZCode probes the endpoint and persists the first format that
answers. The existing dropdown remains a manual override; a format-only edit is
never overwritten.

## Behavior

- The probe runs only when the provider has a base URL, an API key, at least one
  model id, and the provider is new or its base URL changed. Renaming, toggling,
  or changing only the API key does not probe.
- The currently saved format is probed first (when it is a wire format), then
  Chat Completions, Responses, and Anthropic Messages. The first HTTP-2xx answer
  wins; if the preferred format answers, it is kept.
- Requests are bounded to 10 seconds each and run together. Each sends one
  minimal `ping` with the smallest output budget. Bodies and keys are never
  logged; only the provider id and sanitized outcome may be logged.
- Paths follow the existing selector:
  - Anthropic Messages: `/v1/messages`, or `/messages` when the base URL already
    ends in `/v1`.
  - Chat Completions: `/chat/completions`.
  - Responses: `/responses`.
- On success the detected type is written to the provider's personal `api.type`
  overlay before save. The base URL and API key come from the form and are not
  duplicated into the overlay.
- If every format fails, the manual/default format is saved unchanged. `401/403`
  everywhere is reported as an auth failure; other failures stay non-blocking.
- The selector still supports manual choice; a later format-only save keeps it
  because the base URL did not change.

## Acceptance scenarios

- New DeepSeek provider with `https://api.deepseek.com/anthropic`, a valid key,
  and `deepseek-flash`: probing selects Anthropic Messages without user input.
- New OpenAI-compatible provider: Chat Completions answers and is selected; the
  dropdown updates after the save view returns.
- Endpoint accepts all three formats: the previously saved format remains
  selected because it is probed first.
- Invalid key: all probes return 401/403, save keeps the chosen format and the
  user can correct the key.
- Mixed models/URL: an endpoint change re-probes; a model-name edit alone does
  not.

## Verification

Unit tests cover format selection, preferred-format stability, auth failure, and
invalid input. The network probe is injected through `fetchImpl`.
