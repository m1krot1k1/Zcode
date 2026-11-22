---
name: zcode-test-driven-development
description: ZCode test-driven development. Use for behavior changes and bug fixes that need a focused regression test before implementation.
---

# ZCode test-driven development

Use short red → green → refactor cycles to turn the accepted behavior into executable evidence. Follow the repository's current instructions and specifications; this skill does not replace them or invent project commands.

## One vertical slice at a time

1. Read the relevant spec, interface contract, and existing tests. Identify the public boundary where the changed behavior is observed and the smallest affected test target from the package's current scripts.
2. State the concrete behavior and triggering case the test will protect. Prefer a user-observable result or public contract over private helper calls, implementation layout, or mocks of internal collaborators.
3. Add one focused regression test for that case. Run it before the implementation and confirm it fails for the expected missing or incorrect behavior. A syntax error, broken fixture, or unrelated setup failure is not a valid red result; fix the test setup and rerun.
4. Make the smallest implementation change that satisfies the failing case. Run the focused test and confirm it passes.
5. Repeat for the next independently meaningful behavior. Refactor only after the relevant tests are green, then rerun them.
6. Run the additional type, lint, architecture, package, or UI checks required by repository instructions and the affected surface. Report the exact commands and outcomes; say “not run” when a check was not executed.

## ZCode-specific boundaries

- Repository specifications and `AGENTS.md` define required behavior and verification. Do not ask the user to approve ordinary test seams already made clear by those contracts; ask only when behavior or ownership is genuinely ambiguous.
- Use the target package's existing test framework, fixtures, and commands. Do not add a parallel test harness or assume a root-wide command applies to every package.
- For desktop or web interaction changes, add or update the applicable E2E case as well as focused unit coverage. A unit test does not prove that the packaged UI works.
- Keep tests behavior-focused and deterministic. Avoid sleeps, broad snapshots that hide meaningful changes, duplicated assertions, and weakened checks used only to make a test pass.
- Never describe an unrun test as passing or treat a passing test as proof of a broader runtime or release scenario it does not exercise.
