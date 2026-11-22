---
name: code-craft
description: Use in ZCode when implementing or refactoring code; keep the change understandable, scoped, and protected by a meaningful check.
---

# Code craft

1. Read the owning spec, nearby implementation, and tests before editing.
2. Make the smallest change that satisfies the requested behavior. Keep state ownership and module boundaries explicit.
3. Use names that describe intent. Comments should explain a constraint or reason, not narrate the next line.
4. Add a regression check for changed behavior. Prefer an integration-shaped check for cross-module behavior; do not add unrelated tests.
5. Handle expected failures deliberately and preserve the original cause. Do not swallow errors or turn an unverified result into success.
6. Match local style and avoid unrelated formatting or cleanup in the same change.
7. Run the required checks for the affected package and report exactly what passed, failed, or was not run.

The neighboring implementation is evidence, not permission to copy unsafe behavior or cross ZCode's architecture boundaries.
