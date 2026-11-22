# ZCode agent profile lifecycle

## Owner and storage

`SubagentsService` is the sole owner of custom profile writes, rename recovery, and the disabled-ID state. User profiles live under the ZCode user profile root; project profiles live under that project's `.zcode/agents` root. `.cursor` files and neighboring harness repositories are never read.

An in-place edit atomically replaces one Markdown profile. A cross-name rename is a small durable transaction because the profile file and the user-level disabled-ID state are separate files. A versioned journal lives beside the profile and stores only leaf filenames, old/new profile IDs, the intended Markdown content and hashes, and the prior enabled state. It never stores absolute paths or credentials.

## Skills and Swarm roster

The profile editor reads the installed skills for its selected workspace/user scope through that scope's `SkillsService`; it never scans profile or skill files from the renderer. A profile stores selected skill names in its existing `skills` frontmatter field. The child runtime resolves those names through its existing `SkillPort`, so marketplace installation and profile association remain separate operations. The editor can associate only installed, enabled skills; a previously saved missing skill remains visible as a stale reference and is not silently erased.

Custom profiles are not offered to the explicit Swarm planner by default. `includeInSwarm: true` is a user opt-in stored in profile frontmatter. An opted-in profile enters the swarm roster only when it has a selectable non-generic name, does not collide with a built-in or earlier custom roster name, and has a non-empty explicit tool list that does not contain `*`. Canonical built-in roles remain available and cannot be replaced by custom profiles. The profile editor requires a concrete tool list before it allows swarm opt-in to be saved. Turning opt-in off removes the profile from future planner snapshots without changing its direct/manual availability.

## Rename order and recovery

```mermaid
sequenceDiagram
  participant UI as Settings / profile command
  participant S as SubagentsService
  participant J as ZCode rename journal
  participant P as Profile directory
  participant C as User agent state
  UI->>S: updateAgent(old path, new profile)
  S->>J: atomically persist intent and content
  S->>P: atomically write hidden staging file
  S->>C: disable new ID temporarily; preserve old ID state
  S->>P: atomically publish staging file only if target is absent
  S->>P: remove old file only if its captured hash is unchanged
  S->>C: finalize old/new disabled-ID mapping
  S->>J: remove completed journal
  Note over S,J: Startup/list reconciliation repeats idempotently before profile discovery.
```

Before runtime snapshots or profile lists are loaded, the service reconciles journals in the requested user/project roots. The destination is verified against the journal content hash; the source is removed only if it still matches the captured source hash. If the source was edited after the interrupted rename, that content is preserved as a disabled profile while the renamed profile retains the original enabled state. A conflicting destination is never overwritten; the journal and both user files remain for diagnosis. A temporary disabled entry prevents a renamed profile from being enabled before the old profile disappears.

Recovery is idempotent across interruption after journal creation, state preparation, staging write, source removal, destination rename, state finalization, or journal cleanup. It does not infer profile identity from directory scans and does not discard an unknown file. If a journal is malformed or a target conflicts, runtime loading fails closed for that scope and Settings reports a recovery diagnostic; unrelated profile roots remain usable.

The source and destination must remain in one selected ZCode profile root. Destination publication uses a same-directory hard link, which atomically fails if the destination already exists. If the filesystem rejects hard links, recovery removes only its own staged destination, restores the destination's recorded disabled state, removes the journal, retains the source, and reports that safe rename is unsupported. It never falls back to a replacing rename. If the source was edited to use the destination identity during interruption, recovery removes the destination only after matching its journal content, restores the original state, keeps the edited source, and reports the identity conflict.

Workspace rename validation accepts both the canonical profile ID and the existing Host path-scoped compatibility ID. It still validates the profile name from the source file before journaling; casing aliases for the same physical `agents` directory do not change profile identity. Profile recovery treats an absent or non-directory path as an empty root. The runtime watcher exposes no custom profiles while its configured root is unavailable and watches the nearest existing directory. On a direct-child unlink it rebinds the watcher before reloading the full profile set, so the watcher cache follows case-only renames even when the filesystem reports only the old spelling.

## Acceptance cases

- Selecting one installed, enabled marketplace skill for a custom profile persists its name in Markdown and a spawned instance resolves it through `SkillPort`; disabling the profile's Swarm opt-in leaves direct/manual profile use intact.
- A custom profile is absent from the explicit Swarm roster unless `includeInSwarm: true`; wildcard/inherited tools, a generic name, and collisions with built-in or earlier custom role names are excluded.
- The profile form reads skills from the selected workspace/user target service, preserves missing saved skill names with a warning, and does not route a remote profile's skills request through the local Host.
- Saving a Swarm-opted profile without a concrete explicit tool allowlist is disabled; saving a valid allowlist persists the opt-in and the profile appears in the next roster snapshot.
- In-place update failure before atomic replacement leaves the previous valid content and profile identity.
- Rename interruption at each durable step is recovered on the next service initialization; exactly one active profile remains and the original enabled/disabled choice is preserved.
- A source file edited after journal creation is retained and disabled; the intended new profile is recovered without overwriting either file.
- A destination created by another actor after intent creation is never overwritten or deleted; the source remains intact and the conflict is surfaced.
- A filesystem that does not support safe no-overwrite publication leaves the source untouched and does not retain an unresolvable journal.
- Malformed or path-traversal journal data cannot access files outside the selected ZCode profile root.
- User and project roots are reconciled independently; a failure in one does not inspect or mutate the other.
- A case-only rename followed by deletion removes the cached profile even when the filesystem reports the rename as an unlink of the old spelling only.
- Replacing a prepared scope or disposing its Host waits for both Chokidar and the parent-directory watcher to close before its owner finishes, so repeated workspace preparation does not accumulate native file handles or publish events from a retired scope.

## Watcher ownership and shutdown

```mermaid
sequenceDiagram
  participant H as Host config cache
  participant S as Profile/state scope
  participant C as Chokidar root watcher
  participant P as Windows parent compatibility watcher
  H->>S: prepare or replace scope
  S->>C: observe direct configuration root
  opt Windows cannot report an empty directory move from the root watcher
    S->>P: observe root's parent for directory replacement
  end
  H->>S: replace or dispose
  S->>P: abort and await watcher loop
  S->>C: close and await watcher
  S-->>H: disposal settled; safe to create replacement scope
```

The scope owns the Chokidar root watcher and, only on Windows, a raw parent-directory watcher for the empty-directory rename event that Chokidar may omit there. Other platforms rely on the root watcher and avoid a redundant native handle. Disposal is asynchronous and is not complete until every watcher the scope opened has settled; replacing a user, state, or workspace scope must await that boundary before opening the replacement. This prevents file-handle accumulation across Host re-preparation and gives tests a deterministic teardown contract.
