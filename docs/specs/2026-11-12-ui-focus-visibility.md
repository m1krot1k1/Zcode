# UI Focus Visibility and Toast Live Regions

## Problem

`packages/ui/src/styles.css` applied a global reset:

```css
*:focus,
*:focus-visible {
  outline: none !important;
  box-shadow: none !important;
}
```

This removed the browser's default `:focus-visible` indicator **and** every
component focus ring (Tailwind `ring-*` is box-shadow based), so keyboard users
could not see where focus was. Separately, components commonly use the shadcn
utilities `ring-ring` and `text-muted-foreground`, but the theme never defined
`--color-ring` or `--color-muted-foreground`; those utilities rendered as nothing.

`packages/ui/src/components/ui/toast.tsx` also rendered transient notices without
any live region, so screen readers never announced them.

## Contract

- Theme tokens: `--color-ring: var(--color-brand)` and
  `--color-muted-foreground: var(--color-foreground-subtle)` are defined in
  `@theme`. Both reuse existing tokens, so all themes (light, dark, Zai light,
  Zai dark) keep working without new colors.
- Focus: only non-keyboard focus is suppressed
  (`:focus:not(:focus-visible) { outline: none }`). Keyboard focus keeps component
  ring/outline styles, and elements without custom styles fall back to the UA
  `:focus-visible` indicator. `forced-colors` mode must not reset outlines.
- No new shared `!important` outline is added (see `DESIGN.md` accessibility
  rules). Mouse clicks keep the previous "no focus frame" behavior.
- Toast: each message root is its own live region —
  `role="status"`/`aria-live="polite"` by default, `role="alert"`/
  `aria-live="assertive"` for warnings — with `aria-atomic="true"`. The shared
  stack containers stay non-live so multiple messages are not announced twice.

## Verification

- `packages/ui/test/focusAndSemanticColorTokens.test.ts` asserts both tokens and
  guards against reintroducing the global `!important` reset.
- `packages/ui/test/toast.test.ts` asserts the rendered roles and `aria-live`
  values.
- Visual check: keyboard tab through buttons/inputs in light and dark themes;
  pointer clicks must not show the default focus frame.
