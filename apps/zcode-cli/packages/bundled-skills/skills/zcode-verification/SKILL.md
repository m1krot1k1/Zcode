---
name: zcode-verification
description: Use when checking a ZCode code change or task result, selecting focused validation, and reporting concrete evidence without overstating success.
---

# ZCode verification

Start with the current workspace instructions, feature spec, package scripts, and affected tests. Choose checks that exercise the changed behavior and satisfy those instructions; do not substitute a generic checklist for repository requirements.

## Verify

1. Read back the changed files and compare the result with the requested behavior and spec.
2. Run the narrowest relevant test or reproduction, then required type, lint, integration, or packaging checks for the affected surface.
3. Read the actual output. If a check cannot run, record it as not run and state why. A successful command that never exercises the changed path is not coverage of that behavior.
4. For UI or runtime behavior, use the relevant live application or end-to-end path when available. Static checks alone do not prove the user-visible result.

## Report evidence precisely

- Separate passed checks, failures, and checks not run.
- Name the command or observed runtime event and the result that supports each claim.
- Distinguish execution completion from acceptance of the user's goal. Tests, receipts, model text, and a zero exit code prove only what their contract actually checks.
- Do not claim CI, release publication, external service behavior, or end-to-end success without observing that outcome.

Follow higher-priority workspace and user instructions when they specify additional validation or a different scope.
