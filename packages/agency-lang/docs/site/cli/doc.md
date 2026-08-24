---
title: Generating documentation
description: Documents the `agency doc` command for auto-generating reference documentation from `.agency` source files, including docstring and doc-comment conventions.
---

# Generating documentation
Agency provides a command for auto-generating documentation:

```
agency doc lib -o docs
```

- `lib` is the name of the directory containing your library's source code
- `docs` is the name of the directory to output the generated documentation to

You can also set these options in the Agency config file:

```json
{
  "doc": {
    "outDir": "docs",
    "baseUrl": "http://github.com/your-repo/tree/main/"
  }
}
```

`baseUrl` is used to generate links to the source code in the documentation. It should point to the directory containing your library's source code.

## What gets documented
Agency documents the exported nodes, functions, types, and constants defined at the top level of each file, plus every effect it declares. Anything you do not export is not part of what a caller can reach, so it is left out. Names starting with an underscore are left out too, whatever kind they are: they are compiler plumbing rather than something anyone calls.

If you want to leave out something you *did* export, see [hiding a declaration](#hiding-a-declaration) below.

## Doc comments
Agency uses the docstring as the description for nodes and functions. You can additionally give more documentation by providing a doc comment above types, functions, or nodes:

```ts
/** This is a doc comment for the Person type */
type Person = {
  name: string
  age: number
}

/** This is a doc comment for the greet function */
def greet(name: string): string {
  return `Hello, ${name}!`
}
```

## Module-level doc comments

To document the file itself — for example, to provide an overview, usage examples, or setup instructions — use the `@module` tag:

```ts
/** @module
  ## Date Utilities

  Helpers for constructing timezone-aware ISO 8601 date strings.

  ### Usage

  ```ts
  import { now, tomorrow, addMinutes } from "std::date"

  node main() {
    const start = tomorrow("America/New_York")
    print(start)
  }
  ```
*/

def now(timezone: string = ""): string {
  // ...
}
```

The `@module` doc comment must appear at the top of the file, or right after the imports. If it appears after any other code (type aliases, functions, nodes), the compiler will throw an error.

In the generated documentation, the module doc comment appears at the top of the page, before the types and functions sections.

## Hiding a declaration

Write `@hidden` above a declaration to keep it out of the generated pages:

```ts
/** What an eval hands the reviewer. */
@hidden
export type ReviewEvalInput = {
  assignment: string
  sourceFile: string
}
```

This is for something you have to export for a tool to reach, but that is not
part of what you are asking people to use. The example above is real: the review
agent in the standard library exports a type that only its eval suite passes in.
Exporting it is necessary; putting it in the reference next to the agent itself
would just be confusing.

A few things worth knowing:

- `@hidden` works on types, functions, nodes, constants, and effect
  declarations. If you write it somewhere it cannot apply — at the end of a
  file, say — `agency doc` warns rather than quietly ignoring it.
- Nothing links to a hidden declaration. If another page has a function that
  takes a hidden type, that type name renders as plain text instead of a link,
  because there is no longer a section to link to.
- `std::agency`'s `describe()` hides it too, so a generator reading your module
  sees the same surface a reader does.
- Hiding is about documentation only. The declaration still compiles, still
  exports, and anyone who knows its name can still import it.

## Interrupts

For each function and node, the generated docs include a `Throws:` line listing the kinds of structured interrupts the function may raise. This list is computed by static analysis: it includes interrupts the function raises directly as well as interrupts raised transitively through any functions or nodes it calls. Interrupts raised by `llm()` tools are also included.

For example:

```ts
def deploy() {
  interrupt myapp::deploy("Deploy?")
}

def helper() {
  return deploy()
}
```

Both `deploy` and `helper` will be documented as throwing `myapp::deploy`.

## Options

- `-o, --output <dir>` — output directory for the generated docs.
- `--ignore <dirs...>` — directory names to ignore when scanning recursively. Useful for skipping things like `node_modules` or `dist`.
- `--base-url <url>` — base URL for source links in the generated docs. Equivalent to setting `doc.baseUrl` in the config file.