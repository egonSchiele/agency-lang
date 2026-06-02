---
title: What runs when
description: A reference for the two-phase initialization model in Agency — what runs once per process (Phase A) vs. what runs on every agent run (Phase B), the rules for static initializers, and how to diagnose cross-module init errors.
---

# What runs when

Agency initializes module-level code in two phases:

- **Phase A — once per process.** All `static const` declarations and bare top-level statements prefixed with `static`. Runs the first time any node in the module's closure is invoked.
- **Phase B — every run.** All other top-level `const` / `let` declarations and bare top-level statements. Re-runs at the start of every agent invocation, giving each run fresh per-run state.

Use the [`agency explain-init`](/cli/explain-init) command to see exactly which decls and statements fall into each phase for a given entry file.

## A worked example

```ts
// config.agency
static const apiUrl = env("API_URL")
static loadCacheFromDisk()

const requestLog = []
log("agent starting")
```

Output of `agency explain-init config.agency`:

```
Phase A (once per process):
  config.agency:1   apiUrl
  config.agency:2   <bare statement>

Phase B (every run):
  config.agency:4   requestLog
  config.agency:5   <bare statement>
```

The bare `loadCacheFromDisk()` on line 2 runs once for the lifetime of the process. The `log("agent starting")` on line 5 runs every time the agent is invoked.

## Restrictions on Phase A

A `static const` or bare `static` statement initializer **cannot**:

- Read a non-static global variable (directly or through a function call). Globals don't exist yet in Phase A — they live in Phase B.
- Mutate per-run state from another module (same reason).

A `static const` initializer **can**:

- Read other `static const` values (the dep graph orders them topologically).
- Call any function, as long as that function's body doesn't read a non-static global.

`static let` is **not supported**. Statics are deeply immutable by design. Use `static const <name> = ...` for a once-per-process binding, or `static <expr>` for a once-per-process side effect with no binding.

## Cross-module dependencies

When a static in module A reads a static from module B, the compiler builds a dependency edge and inserts a topsort step so B's `__initializeStatic` completes before A's runs. You don't need to do anything special — just import normally:

```ts
// b.agency
export static const greeting = "hello"

// a.agency
import { greeting } from "./b.agency"
static const banner = greeting + " world"
```

`b.greeting` initializes first, every time, automatically.

## Cycles

Agency allows **file-level cycles** but rejects **variable-level cycles**.

- **File-level cycle (allowed):** Two files import functions from each other. Functions are not part of the variable dep graph — only their *values* are, and a `def` doesn't have an init-order dependency.
- **Variable-level cycle (rejected):** Two static initializers reference each other. The compiler reports a `Circular static dependency` error naming both decls. Fix it by extracting one of the values into a third file, or by computing it from a literal.

```
Error: Circular static dependency
  a.fooStatic (a.agency:2) depends on b.barStatic
  b.barStatic (b.agency:2) depends on a.fooStatic
Static vars cannot depend on each other in a cycle. ...
```

## Indirect reads through function calls

The dep graph is built from references in initializer expressions only. If a `static const` initializer reads an imported value indirectly — through a function or node body — the compiler can't always see that edge. To catch this case, Agency runs a closure-wide init bootstrap at the start of every agent run that guarantees every module in the import closure has both phases complete before user code starts.

If for any reason a static read does fire before its source is initialized, the runtime trap is the safety net:

```
Error: Read of uninitialized static 'greeting' (from b.agency).
```

When you see this, run `agency explain-init <entry>` to see what the compiler thinks the init order is, and look for the imported module in the dep-graph section. Most often the fix is a missing import in the file that performs the read, or a typo in the imported name.
