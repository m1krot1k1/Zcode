# Interface localization

## Product rule

- User-facing ZCode-owned interface text is rendered in the locale selected in Settings (or the system locale when selected); English is the source contract, not a silent translation fallback for Russian.
- Russian and Simplified Chinese catalogs must have the same message IDs as `en-US.ts`. Each translated message must preserve the exact placeholder names and ICU plural/select structure required by its English source.
- Product names, code identifiers, shortcuts, shell commands, file paths, and provider/model IDs remain unchanged where users must copy or recognize them. Their surrounding explanatory text is localized.
- Language selection remains persisted and synchronized through the existing settings/IntlProvider ownership; active sessions and external provider/plugin content stay within their existing locale contracts.

## Ownership and behavior

- `packages/ui/src/i18n/locales/en-US.ts` owns the message-ID and placeholder contract.
- `packages/ui/src/i18n/locales/ru-RU.json` and `zh-CN.ts` own their translations.
- `IntlProvider` owns resolution and locale preference; settings own the user control. Missing translation IDs in a supported locale are a catalog defect and must be caught by verification rather than silently accepted as complete localization.

## Acceptance scenarios

1. Catalog parity check proves that each supported locale contains exactly the English message IDs and preserves placeholder and ICU argument structure.
2. Russian prose is not copied from English except for an explicit, reviewed allowlist of brand names, self-names of languages, technical identifiers, and commands.
3. The language setting can select Russian, persists across restart, follows System when requested, and updates the rendered UI without a restart where the current provider supports it.
4. Settings, catalog, CodeIndex, graph, provider errors, and agent activity render in Russian without clipping or overflow at desktop and narrow layouts.

## Validation

- Run the locale catalog parity/placeholder test and focused UI rendering tests.
- Manually inspect representative Russian screens and long translated labels at desktop and narrow widths.
- Do not claim translated content for model-generated replies, third-party plugin surfaces, or remote provider pages unless those systems expose a locale contract.
