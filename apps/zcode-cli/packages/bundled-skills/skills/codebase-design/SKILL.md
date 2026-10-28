---
name: codebase-design
description: Use in ZCode when planning or changing software structure, public interfaces, module boundaries, or dependency direction; design a small, understandable contract before expanding implementation.
---

# Codebase design

Shape software so callers can do useful work through a clear interface while implementation details and change remain localized. Use this workflow for new features, refactors, and changes that cross module or platform boundaries.

## Design workflow

1. **Find the current owner.** Read the relevant specification, public contracts, implementation, and tests. Identify which module owns decisions and mutable state. Reuse its existing command, service, hook, adapter, or event path when it already expresses the behavior.
2. **Name what callers need to know.** An interface includes types and methods, but also invariants, ordering, error behavior, permissions, persistence, and performance expectations. Keep these requirements explicit and avoid making callers coordinate hidden implementation steps.
3. **Choose a seam only when behavior can vary.** Place the seam at a real boundary such as a package contract, injected platform service, or adapter. Keep internal helpers private. Do not add an abstraction for a single implementation when there is no meaningful substitution or test boundary.
4. **Concentrate behavior behind the seam.** Prefer one small contract backed by cohesive logic over a thin pass-through that makes every caller repeat the same decisions. Keep platform and storage details in their existing owners; pure calculations should not perform IO.
5. **Check the design with scenarios.** Walk through normal, missing, repeated, stale, partial, and conflicting input. Confirm the contract makes each case predictable and that its tests can observe behavior through the intended interface.
6. **Make alternatives explicit when the design is consequential.** Compare at least two plausible interface shapes against caller simplicity, change locality, and testability. Record a durable decision only when the trade-off would otherwise surprise future maintainers.

## ZCode-specific constraints

- Follow the current workspace's architecture, language, and public package exports. Do not assume the target project is ZCode or import ZCode internals into another project.
- In ZCode, keep UI dependent on its service hooks and public contracts; route platform-specific behavior through `IPlatformService`; and keep SQLite/IPC details behind adapters.
- One component owns each mutable fact. A cache, event stream, task index, or UI projection must not become a second source of truth.
- For async or remote flows, define the owner, event order, idempotency key, cancellation/stale-result rule, and recovery boundary before implementation.
- Avoid broad rewrites, speculative extension points, and new dependency layers that do not make a concrete caller or test simpler.

## Completion evidence

Report the chosen owner and interface, alternatives rejected when material, files or contracts changed, and the checks actually run. Distinguish architecture-check results from end-to-end runtime evidence.
