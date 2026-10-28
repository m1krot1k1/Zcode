---
name: image-to-code
description: Use in ZCode when implementing or revising an interface from a user-provided screenshot, mockup, design export, or visual reference; inspect the reference and existing project conventions before coding, then verify the rendered result when tools permit.
---

# Visual reference to interface

Treat the user's supplied design image as evidence for the requested result. Translate its intent into the project's existing components and design system; do not treat the image as permission to ignore responsive behavior, accessibility, or the actual product constraints.

## Workflow

1. **Inspect inputs.** Identify every supplied reference and the requested screen, states, viewport, and behavior. If a reference is unavailable or ambiguous, use the available material and state what cannot be inferred.
2. **Inspect the project.** Read its design rules, the owning feature specification, nearby components, tokens, and tests. Reuse existing primitives and routes. Do not invent a parallel visual system.
3. **Describe the visual structure.** Note hierarchy, alignment, proportions, spacing, typography roles, color roles, density, image treatment, and visible interaction states. Separate exact observable details from uncertain interpretation.
4. **Plan responsive behavior.** Determine how the composition should reflow at narrow and wide sizes, which controls remain visible, and how text expansion, keyboard focus, loading, empty, error, and success states behave.
5. **Implement in the project.** Use semantic, accessible controls and existing components. Match the reference's information hierarchy and distinctive choices while avoiding unrequested decorative elements or placeholder content.
6. **Compare the rendered result.** Run the owning package's available checks and open or capture the actual page at relevant sizes when a browser or application is available. Compare the output to the reference and fix visible spacing, hierarchy, overflow, and state mismatches.

## Boundaries

- Do not claim pixel-perfect matching from source inspection alone. If rendering is unavailable, report source-level checks and leave visual matching unverified.
- Do not require generating a new image. Use image-generation tools only when the user asks for new imagery or when an available, authorized tool materially improves the requested result.
- Do not guess text, interaction, or responsive behavior that the reference cannot show; follow the product specification and identify meaningful assumptions.
- Keep screenshots, sample data, and credentials out of logs and committed fixtures unless the user explicitly supplied them for that purpose.

Use the bundled `ui-craft` skill for broader design and accessibility guidance, and the owning feature contract for behavior.
