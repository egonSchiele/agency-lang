# Cycle + runtime-trap fixtures

Each subdirectory is a multi-file Agency program that should NOT compile
or whose runtime should fire PR 1's read-before-init trap.

The Agency test framework (`agency test`) has no "expected compile
error" assertion, so these fixtures are exercised by the vitest test in
[lib/runtime/topsortCycleErrors.test.ts](../../../lib/runtime/topsortCycleErrors.test.ts).
That test runs each fixture's entry through `compileSource()` (compile
errors) or compiles + runs it (runtime trap), and asserts on the
emitted diagnostic.

The fixtures live under `tests/agency/topsort/` instead of `lib/` so
every PR-2 topsort behavior — success and failure — is browsable from
one directory.
