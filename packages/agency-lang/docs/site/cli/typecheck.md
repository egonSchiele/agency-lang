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

`tc` is a shorter alias. If no input is given, the type checker reads from stdin.

## Options

- `--strict` — enable strict mode. In strict mode, untyped variables are errors rather than being inferred. Use this if you want every variable to have an explicit type annotation.
