---
title: Type checking
description: Documents the `agency typecheck` (alias `tc`) command for type-checking one or more Agency files without compiling, including the `--strict` mode.
---

# Type checking

To type check one or more Agency files without compiling them:

```
agency typecheck foo.agency
agency tc src/
```

`tc` is a shorter alias. Arguments may be files, directories (scanned recursively for `.agency` files), or a mix of both. If no input is given, the type checker reads from stdin.

You can also pass a literal `-` to read from stdin explicitly, and mix it with file and directory arguments (for example, `agency tc src/ extra.agency -`).

## Options

- `--strict` — enable strict mode. In strict mode, untyped variables are errors rather than being inferred. Use this if you want every variable to have an explicit type annotation.

## Imports must resolve

The type checker verifies that every Agency import names something real. Two mistakes are hard errors:

- `AG4008` — the target file exists but does not define the imported name (for example, `import { missingFn } from "./lib.agency"` when `lib.agency` has no `missingFn`).
- `AG4009` — the import path resolves to no file (for example, a typo in `import { x } from "./libb.agency"`).

Unlike a call to an undefined function (a warning that might be an uncatalogued JavaScript global), an unresolved Agency import is unambiguous, so it always errors.

Import checking needs a file path to resolve relative imports against, so it is skipped when input comes from stdin without a path (`agency tc -`). Pass files or a directory to have imports checked.
