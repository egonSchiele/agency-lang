# Intra-file use-before-def fixtures

Each subdirectory is an Agency program that should fail compilation with
a use-before-def error because a same-file decl references another
same-file decl that appears later in source order.

The Agency test framework (`agency test`) cannot express "expected
compile error", so these fixtures are exercised by the vitest test in
[lib/runtime/topsortCycleErrors.test.ts](../../../lib/runtime/topsortCycleErrors.test.ts).

The companion cross-module case (`tests/agency/topsort/cross-file-main`)
still compiles cleanly — cross-module topsort reorder is genuine work
the user can't do by hand, and the use-before-def rule deliberately
applies only within a single source file.
