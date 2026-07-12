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
