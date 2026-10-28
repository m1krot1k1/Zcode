---
name: ui-craft
description: Use in ZCode when designing, implementing, or reviewing interfaces for accessibility, responsive behavior, visual consistency, and verifiable interaction.
---

# UI craft

Build interfaces that are clear, accessible, responsive, and consistent with ZCode's design system. A checklist is a floor, not a substitute for understanding the user's task or reviewing the actual interface.

## Before changing the interface

1. Read the repository's `DESIGN.md`, the owning feature specification, and the closest existing component or screen.
2. Identify the user's primary task, the surfaces and screen sizes affected, and the state owner. Reuse shared components, design tokens, public hooks, and platform services instead of adding a parallel UI path.
3. For behavior or state changes, read the relevant service contract and tests. Keep data and platform behavior in their existing owners; components should render and collect interaction state.

## Craft and accessibility

- Use semantic controls for actions, navigation, headings, and form fields. Give inputs visible labels and controls accessible names; do not rely on placeholders or icons alone.
- Keep keyboard interaction complete and predictable. Preserve DOM/focus order, provide a visible focus indicator, and make menus and dialogs operable without a pointer.
- Maintain readable contrast in supported themes and do not use color as the only status signal. Use the repository's semantic color and typography tokens rather than hard-coded values.
- Keep targets comfortably usable with mouse, touch, and keyboard. Provide spacing between adjacent actions and avoid requiring precise pointer placement.
- Design for narrow windows, mobile web, text expansion, and zoom. Allow content to reflow without clipping essential controls or locking page zoom.
- Respect reduced-motion preferences. Motion must not be the only way to convey state, and transient status should remain perceivable long enough to understand.
- Provide clear loading, empty, success, and error states. Explain errors in plain language with an actionable next step; make destructive or multi-step actions recoverable where the existing interaction supports it.
- Render user-provided content through the framework's escaped text paths. Do not inject raw HTML unless an existing, reviewed sanitizer contract requires it.

## Verify and review

1. Run the relevant checks declared by the owning package. For a user-visible change, prefer its existing UI or desktop E2E path; use an available browser or running application when the environment provides one.
2. Exercise the affected interaction with keyboard and pointer, check narrow and wide layouts, and review supported themes. A screenshot alone does not prove interaction behavior.
3. In review, report concrete issues with the screen/state, reproduction, impact, and evidence. Distinguish checked properties from assumptions; do not claim a contrast ratio, accessibility audit, or browser verification that was not measured or observed.
4. If the real UI cannot be run, report what was checked in source/tests and name the unverified visual or interaction risks.

For non-visual implementation details, regression tests, and error handling, also follow the bundled `code-craft` skill.
