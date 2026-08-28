## AG8016 — `&#123;file&#125;` contains a splice, and generator execution was declined for this check, so `&#123;name&#125;` was not run.

_Default severity: error._

This file contains a splice, and generator execution was declined for this compile.

Compiling a `$( ... )` runs its generator right then, during compilation. So compiling a file you have not read means running code you have not read. That is bounded — a generator may import only `std::` modules and other `.agency` files, and compilation installs no interrupt handlers, so anything dangerous cannot finish — but it is still execution, and you may prefer to decline it. Inspecting a repository you just cloned is the usual reason.

The generator did not run. The refusal happens before it is resolved, so it was never compiled or executed — though the file itself may already have been read, since building the symbol table and the compiled closure crawls imports before expansion.

**How to fix:** if you passed `--refuse-splices`, compile again without it (or turn `refuseSplices` off in your config) once you are satisfied the generator is one you want to run.

Two paths refuse regardless of the setting, and there is no flag to drop on either. Sandboxed compilation — `agency run --agency-only` and `std::agency compile` — refuses splices unconditionally through the closure validator. So do the `std::agency` inspection entry points `typecheck`, `typecheckFile`, `getEffects` and `describe`, because type checking runs generators and that path has no sandbox. To inspect a file with a splice, remove the splice or compile it yourself outside those APIs.
