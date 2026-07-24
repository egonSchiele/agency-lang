---
name: "Lint"
---

# Lint

Findings from `agency lint` and the editor (grayed-out code, quick
fixes). Lint findings are style and hygiene notices, not errors: the
program still compiles and runs, and `agency lint` exits 0 on
hint-level findings so they never fail CI.

<a id="al0001"></a>

## AL0001 — '&#123;name&#125;' is imported but never used.

*Default severity: hint.*

An import brings in a name the file never references. Unused
imports add noise and can hide a mistake (an import you meant to use). This is a
hint, not an error — the program still compiles and runs. The editor grays the
name out and offers "Remove unused import"; `agency lint` reports it. Names
imported from `std::index` and `import test { … }` imports are not reported.

<a id="al0002"></a>

## AL0002 — '&#123;name&#125;' is exported but has no docstring.

*Default severity: hint.*

In Agency, functions are tools: an exported function's
docstring becomes the tool description the LLM reads when deciding whether
and how to call it. An exported function without one gives every agent that
imports it a tool with no description. Add a docstring — terse and
user-facing, describing what the tool does. A comment above the function
does not count: comments never reach the LLM.

<a id="al0003"></a>

## AL0003 — '&#123;name&#125;' is already available without an import.

*Default severity: hint.*

Every Agency file gets the prelude (print, map,
filter, range, and the rest) without importing anything, so importing one of
those names from `std::index` is redundant. Not everything in std::index is
prelude, though: types like `WriteMode` must be imported, and an aliased
import (`map as arrMap`) or one carrying a `destructive`/`idempotent`
marker does real work — none of those are reported.
