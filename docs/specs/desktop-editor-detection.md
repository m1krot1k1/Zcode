# Desktop editor discovery contract

## Ownership and behavior

The Desktop main process owns discovery of installed workspace editors and terminals. The editor definition table owns supported application identities and platform-specific canonical names; path resolution combines those names with OS-standard install roots and command lookup. UI consumers receive only successfully resolved applications through the existing editor service.

On macOS, each supported `.app` may be installed either in the shared `/Applications` directory or in the current user's `~/Applications` directory. A CLI command on `PATH` remains an independent discovery route where the editor supports one. The home directory is resolved at runtime with `os.homedir()`; no user's absolute path is stored in application code.

On Windows, existing `Program Files`, `LOCALAPPDATA`, user home, and command resolution rules remain authoritative. Linux command discovery remains unchanged.

## Acceptance

- A macOS app found only under the current user's `~/Applications` resolves to that path.
- A missing user-level bundle does not mask a valid system-level bundle or PATH command.
- The resolver does not introduce a second editor registry or persist discovery results beyond the existing app-lifetime cache.
- Tests inject the home directory and filesystem observations; they do not depend on installed host applications.
