# Code index status indicator

Status: active

This document defines the product contract for the compact local code index
indicator. Index lifecycle, persistence, search, and status fields remain owned by
[agent-workbench-code-intelligence.md](agent-workbench-code-intelligence.md); this
document only fixes how the existing status projection is presented. It does not
change the host contract or add states.

## Surfaces

- The composer context-window trigger in `CodeIndexPopover` (icon button with a
  status dot).
- The "Local code index" pill in `AgentWorkbenchView`.

Both surfaces derive their presentation from one pure helper so the two locations
cannot disagree about the same status.

## Tone mapping

`state` is the authoritative service field. `partial` refines only `ready`; it does
not create a fifth service state. Order of precedence:

1. `state` selects the base category.
2. `ready && partial === true` becomes `partial`.

| `state`     | `partial`             | Tone       | Dot class                  | Pill class                                                   |
| ----------- | --------------------- | ---------- | -------------------------- | ------------------------------------------------------------ |
| `unindexed` | any                   | `neutral`  | `bg-foreground-subtle`     | `bg-tag text-foreground-subtle`                              |
| `indexing`  | any                   | `indexing` | `bg-warning animate-pulse` | `bg-warning-surface text-warning-surface-foreground`         |
| `ready`     | `false` / `undefined` | `ready`    | `bg-success`               | `bg-success-surface text-success-surface-foreground`         |
| `ready`     | `true`                | `partial`  | `bg-warning`               | `bg-warning-surface text-warning-surface-foreground`         |
| `degraded`  | any                   | `degraded` | `bg-destructive`           | `bg-destructive-surface text-destructive-surface-foreground` |

The dot is rendered for every tone, including `neutral` and `degraded`; it is never
hidden when the index is absent or unhealthy. Only `indexing` pulses.

All mapping classes use the semantic tokens defined in `packages/ui/src/styles.css`.
Raw palette utilities (`bg-emerald-500`, `text-amber-600`, `text-amber-*`) must not be
used in the mapping. Light, dark, and Zai themes resolve through the CSS variables;
no `dark:` variant is needed or permitted for this indicator.

The neutral classes are deliberately `--color-foreground-subtle` (dot) and
`--color-tag` + `--color-foreground-subtle` (pill). `bg-muted`, `bg-muted-foreground`,
and `text-muted-foreground` are not defined by this repository's `@theme` block, so
Tailwind generates no rules for them; using them would leave the neutral dot without
a background color. `--color-foreground-subtle` and `--color-tag` are defined for
`:root`, `.dark`, `.theme-zai-light`, and `.theme-zai-dark`.

## Freshness

The status contract has no explicit `stale` field. "Current" means
`state === "ready" && partial !== true`. `generation` and `updatedAt` are
informational metadata: they are displayed in the popover and must not alter the
tone. A future stale state must first be added to the service contract; the UI must
not infer it from timestamps.

## Accessibility

The indicator must not communicate status by color alone.

- The dot carries `data-testid="composer-code-index-indicator"` and
  `data-code-index-tone="{tone}"` in the composer trigger.
- The trigger button exposes the localized status in both `aria-label` and `title`,
  and carries `data-code-index-state` plus `data-code-index-tone`.
- A visually hidden live region (`role="status"`, `aria-live="polite"`) announces the
  localized status whenever it changes. It is rendered by the popover component even
  while the popover is closed.
- The Workbench pill keeps `data-testid="agent-workbench-index-state"` and
  `data-code-index-state`, adds `data-code-index-tone`, and always shows its status
  text.
- The dot itself is decorative (`aria-hidden="true"`); the accessible name and live
  region carry the meaning.

Status labels are resolved by `codeIndexStateKey(status)` in
`packages/ui/src/agent-workbench/codeIndexIndicator.ts`, which maps the derived tone
rather than `state` alone. Both visible surfaces and the accessible labels call the
same helper, so tone and text cannot disagree:

| Tone       | i18n key                        | en-US           | ru-RU              | zh-CN    |
| ---------- | ------------------------------- | --------------- | ------------------ | -------- |
| `neutral`  | `agentWorkbench.stateUnindexed` | Not indexed     | Не проиндексирован | 尚未索引 |
| `indexing` | `agentWorkbench.stateIndexing`  | Indexing        | Индексируется      | 正在索引 |
| `ready`    | `agentWorkbench.stateReady`     | Ready           | Готов              | 就绪     |
| `partial`  | `agentWorkbench.statePartial`   | Partial         | Частичный          | 部分索引 |
| `degraded` | `agentWorkbench.stateDegraded`  | Needs attention | Требует внимания   | 需要处理 |

`agentWorkbench.statePartial` is the only key this contract adds. The `degraded` tone
deliberately does not reuse `codeGraph.state.degraded`, whose English copy is
"Partial index" and would make a failed index read like partial coverage. While the
status is still loading, the helper returns `codeIndex.loadingStatus`. The trigger
message is `codeIndex.triggerWithStatus` with a `{status}` placeholder, present in
`en-US`, `ru-RU`, and `zh-CN`.

## States and feedback

- `unindexed`: neutral dot, neutral pill. The popover offers the existing explicit
  "Build local index" action; no build starts implicitly.
- `indexing`: warning dot with pulse plus the existing progress text. The pulse is
  additive motion, not the only signal.
- `ready`: success tone; the popover shows counts, embedding readiness, and the last
  update time.
- `partial`: warning tone. Coverage details stay in the existing neutral disclosure.
  The disclosure also lists localized skip reasons derived from known diagnostic
  sentences (`codeIndex.skip.secret`, `codeIndex.skip.size`, `codeIndex.skip.limit`,
  and `codeIndex.skip.other` with a count). Raw diagnostic text is never rendered.
  The dot, pill, popover badge, trigger name, and live region all read as partial
  rather than plain ready, while `data-code-index-state` keeps the authoritative
  `"ready"` value. A solid warning dot is a finished partial index, not an
  indexing pass that failed to clear.
- `degraded`: destructive tone; the popover keeps the existing retry action and the
  last committed generation remains visible.
- Unknown or still-loading status: neutral tone with the localized `codeIndex.loadingStatus`
  announcement; counts are not presented as an authoritative zero.

## Acceptance scenarios

- Rendering the popover with each of the five tones produces one indicator node with
  the matching `data-code-index-tone` and dot class from the table; `indexing` also
  carries `animate-pulse`.
- `unindexed` and `degraded` still render the indicator node.
- The trigger accessible name contains the localized status; the live region text
  matches the same localized status.
- The Workbench pill renders the same tone and the same text through the shared helper
  while preserving `data-code-index-state` as the authoritative `state` value.
- `ready && partial === true` renders the partial text in both the popover badge and
  the Workbench pill, never "Ready". A secret/size/limit diagnostic renders the
  matching localized skip reason and never the raw diagnostic sentence.
- While `state === "indexing"`, the composer indicator and the Workbench pill keep
  requesting status even when the popover is closed and the Build button is idle.
  A slower status response that started earlier must not replace a newer one.
- No raw palette color utility appears in the indicator mapping.
