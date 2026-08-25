## AG8016 — `&#123;file&#125;` contains a splice, and generator execution was declined for this check, so `&#123;name&#125;` was not run.

_Default severity: error._

This file contains a splice, and generator execution was declined for this compile.

Compiling a `$( ... )` runs its generator during compilation, so compiling a file means executing arbitrary code. If you're seeing this message, you probably used the `--refuse-splices` flag, which tells the compiler to refuse to run any generator code.

**How to fix:** if you passed `--refuse-splices`, compile again without it (or turn `refuseSplices` off in your config).
