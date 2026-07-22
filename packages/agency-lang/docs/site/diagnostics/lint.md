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
