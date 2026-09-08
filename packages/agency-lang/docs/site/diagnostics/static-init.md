---
name: "Static init, config, and imports"
---

# Static init, config, and imports

<a id="ag7001"></a>

## AG7001 — Only 'static const' declarations can be exported. Use 'export static const &#123;name&#125; = ...' instead.

*Default severity: error.*

Only `static const` declarations can be exported from a module. A plain `const`, `let`, or other declaration is per-run state and is not part of a module's public surface.

**How to fix:** declare the exported value as `static const`, or remove the `export`.

<a id="ag7002"></a>

## AG7002 — &#123;contextLabel&#125; cannot call `&#123;builtin&#125;(...)` — &#123;reason&#125;, but static initializers run once at process startup before any per-run state exists. Move this call into a node or a function called from a node.

*Default severity: error.*

Static initializers run once at process startup, before any per-run state exists — so they may not call built-ins that need a running agent (LLM calls, I/O, and similar). This static init calls one of those.

**How to fix:** move the call into a node, or into a function called from a node, where per-run state is available.

<a id="ag7003"></a>

## AG7003 — &#123;contextLabel&#125; cannot `interrupt(...)` — interrupts pause the per-run execution stack, but static initializers run once at process startup before any agent run has begun. Move this into a node body.

*Default severity: error.*

Interrupts pause the per-run execution stack, but static initializers run once at startup before any run has begun — there is no stack to pause. So `interrupt(...)` is not allowed in a static initializer.

**How to fix:** move the `interrupt` into a node body.

<a id="ag7004"></a>

## AG7004 — Cannot reassign static `&#123;name&#125;` at module top level — statics are immutable after initialization. Use a global (`const`/`let` without `static`) if you need a mutable value.

*Default severity: error.*

Statics are immutable after they initialize, so a static cannot be reassigned at module top level. Reassigning one would break the guarantee that its value is fixed for the whole process.

**How to fix:** use a global (`const` or `let` without `static`) if you need a value that changes.

<a id="ag7005"></a>

## AG7005 — Cannot mutate static `&#123;name&#125;` via `.&#123;method&#125;(...)` at module top level — statics are deep-frozen after initialization. Use a global (`const`/`let` without `static`) if you need a mutable value.

*Default severity: error.*

Statics are deep-frozen after initialization, so mutating one through a method (like `.push(...)`) at module top level is not allowed — the frozen value rejects the change.

**How to fix:** use a global (`const` or `let` without `static`) if you need a mutable value.

<a id="ag7006"></a>

## AG7006 — Function '&#123;name&#125;' cannot be both destructive and idempotent — those markers are contradictory. Pick one.

*Default severity: error.*

A function was marked both `destructive` and `idempotent`, but those markers contradict each other: destructive means a retry can cause additional effects, while idempotent means a retry is safe to repeat. A function cannot be both.

**How to fix:** keep the one marker that describes the function and remove the other.

<a id="ag7007"></a>

## AG7007 — Type '&#123;alias&#125;' takes value argument '&#123;name&#125;', which is &#123;what&#125;. A value argument must be a literal, a 'static const', an imported name, or a value parameter of the enclosing type alias.

*Default severity: error.*

A value-parameterized type was instantiated with a plain top-level variable, a parameter, or a local. The validator the compiler generates for a type is module-level JavaScript, and it names a value argument as a bare identifier. A `static const` and an imported name are identifiers there. A plain top-level variable lives in the global store and a parameter or local lives on the stack frame, so the generated code cannot reach them and the program would crash at validation time. What works is a literal, a `static const`, an imported name, or a value parameter of the enclosing type alias (`type Above(floor: number) = GreaterThan(floor)`). A value parameter's default follows the same rule, and may also name an earlier parameter of the same alias.

Mark the variable `static const`, or pass a literal:

```agency
static const minAge: number = 5
type Adult = GreaterThan(minAge)
```
