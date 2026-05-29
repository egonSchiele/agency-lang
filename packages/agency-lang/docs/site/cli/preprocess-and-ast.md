---
title: Preprocessing and AST inspection
description: Documents the `agency ast` (alias `parse`) and `agency preprocess` debugging commands for printing the parsed and preprocessed AST of an Agency source file.
---

# Preprocessing and AST inspection

These are debugging commands. If you're working on the compiler, writing a plan that involves syntax, or just trying to confirm that a piece of code parses, two related commands are useful:

```
agency ast foo.agency
agency parse foo.agency
```

`ast` (also aliased as `parse`) prints the parsed AST as JSON. Like `format`, it reads from stdin if no input is given.

```
agency preprocess foo.agency
```

`preprocess` is similar to `ast`, but it runs the AST through the preprocessor first. This is what you want when you need to see the program in the shape that the TypeScript builder will actually consume.
