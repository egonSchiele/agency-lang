---
name: "Static init, config, and imports"
---

# Static init, config, and imports

## AG7001 — Only 'static const' declarations can be exported. Use 'export static const {name} = ...' instead.

*Default severity: error.*

Only `static const` declarations can be exported from a module. A plain `const`, `let`, or other declaration is per-run state and is not part of a module's public surface.

**How to fix:** declare the exported value as `static const`, or remove the `export`.

## AG7002 — {contextLabel} cannot call `{builtin}(...)` — {reason}, but static initializers run once at process startup before any per-run state exists. Move this call into a node or a function called from a node.

*Default severity: error.*

Static initializers run once at process startup, before any per-run state exists — so they may not call built-ins that need a running agent (LLM calls, I/O, and similar). This static init calls one of those.

**How to fix:** move the call into a node, or into a function called from a node, where per-run state is available.

## AG7003 — {contextLabel} cannot `interrupt(...)` — interrupts pause the per-run execution stack, but static initializers run once at process startup before any agent run has begun. Move this into a node body.

*Default severity: error.*

Interrupts pause the per-run execution stack, but static initializers run once at startup before any run has begun — there is no stack to pause. So `interrupt(...)` is not allowed in a static initializer.

**How to fix:** move the `interrupt` into a node body.

## AG7004 — Cannot reassign static `{name}` at module top level — statics are immutable after initialization. Use a global (`const`/`let` without `static`) if you need a mutable value.

*Default severity: error.*

Statics are immutable after they initialize, so a static cannot be reassigned at module top level. Reassigning one would break the guarantee that its value is fixed for the whole process.

**How to fix:** use a global (`const` or `let` without `static`) if you need a value that changes.

## AG7005 — Cannot mutate static `{name}` via `.{method}(...)` at module top level — statics are deep-frozen after initialization. Use a global (`const`/`let` without `static`) if you need a mutable value.

*Default severity: error.*

Statics are deep-frozen after initialization, so mutating one through a method (like `.push(...)`) at module top level is not allowed — the frozen value rejects the change.

**How to fix:** use a global (`const` or `let` without `static`) if you need a mutable value.

## AG7006 — Function '{name}' cannot be both destructive and idempotent — those markers are contradictory. Pick one.

*Default severity: error.*

A function was marked both `destructive` and `idempotent`, but those markers contradict each other: destructive means a retry can cause additional effects, while idempotent means a retry is safe to repeat. A function cannot be both.

**How to fix:** keep the one marker that describes the function and remove the other.
