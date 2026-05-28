# Co-located resources

Agency programs are usually shipped as the compiled `.js` file next to
the source `.agency`. That makes "the directory of the compiled module"
a natural place to keep resources that travel with an agent — system
prompts, schemas, fixtures, skill snippets, and so on.

This page documents the three APIs that let you reach those resources
from inside Agency code: `dirname()`, the new `dir`-resolution
semantics for `read` / `write` / `readImage` / `edit` / `multiedit`,
and the `std::skills::readSkill` helper.

## `std::system::dirname()`

`dirname()` returns the absolute path of the directory containing the
compiled `.js` module that initiated the current run. By convention
that is the same directory as the source `.agency` file.

```agency
import { dirname } from "std::system"
import { join } from "std::path"

node main() {
  const promptDir = join(dirname(), "prompts")
  const prompt = read("system.md", promptDir)
  // ...
}
```

`dirname()` is `safe` (no interrupts), so you can call it freely from
any scope. Outside an Agency execution frame (for example from
non-Agency host code calling a stdlib helper directly) it falls back
to `process.cwd()`.

## `read` / `write` / `readImage` / `edit` / `multiedit`

> **BREAKING (unreleased):** Relative `dir` arguments to these helpers
> now resolve against the directory of the compiled module instead of
> `process.cwd()`. Absolute `dir` arguments are unaffected.

This is the change that makes the canonical "co-located prompts"
pattern work:

```agency
node main() {
  // Resolves "./prompts/system.md" against the directory of this
  // .agency file, regardless of what cwd the program was started in.
  const prompt = read("system.md", "./prompts") with approve
}
```

If you need the old "resolve against process cwd" behaviour, pass
`cwd()` explicitly:

```agency
import { cwd } from "std::system"

const config = read("config.json", cwd()) with approve
```

The same applies to `write`, `readImage`, `edit`, and `multiedit`.

## `std::skills::readSkill(filepath)`

`readSkill` reads a single file colocated with the calling Agency
module. It used to be available without an import (every compiled
module had an implicit wrapper). It now lives in `std::skills` and
needs to be imported like any other stdlib helper:

```agency
import { readSkill } from "std::skills"

systemPrompt = readSkill("skills/debug-loop.md") with approve
```

Under the hood `readSkill` uses the same module-dir resolution as
`dirname()` and `read`, so you get the same "ship resources next to
the .agency" ergonomics with a slightly shorter call site.
