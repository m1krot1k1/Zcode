# Interface language selection

## Ownership and behavior

- `Locale` and persisted `AppSettings.locale` define supported application UI languages. `localePreference` is the user's explicit choice or `system`; the UI internationalization provider owns the resolved locale and broadcasts changes across windows.
- The language selector is available from the workspace sidebar settings menu. Selecting a language updates the current UI immediately, persists through the settings service, and synchronizes other windows. Selecting System follows the host/browser language.
- Russian (`ru-RU`) is an explicit supported language. System detection recognizes Russian host/browser locales; unrelated locales continue to resolve to English.
- Message lookup falls back per key to English so missing translations never render a blank label or raw message ID. This fallback is a safety net: new and modified user-facing strings must be translated for all shipped locales.
- Embedded third-party experiences that currently accept only `zh-CN` and `en-US` receive `en-US` while the surrounding ZCode interface remains Russian. Keep this compatibility mapping at the integration boundary; do not narrow the app's resolved locale.
- The Code Index popover and Code Graph section localize their labels, statuses, and diagnostics. Partial coverage and safe-file-exclusion details use a collapsed neutral disclosure; actual failures use semantic error styling.

## Acceptance

- Settings can select System, English, Simplified Chinese, or Russian; the selected value persists and broadcasts to another window.
- A Russian system locale resolves to `ru-RU`; an unsupported system locale resolves to English.
- Missing locale messages fall back to English. New and modified strings in language, index, and graph surfaces have translations for all shipped locales.
- Russian passed to a bilingual legacy integration maps to English; Chinese stays Chinese and English stays English.
