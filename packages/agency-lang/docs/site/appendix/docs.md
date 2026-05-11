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

## Doc comments
Agency will generate documentation for all nodes, functions, and types defined at the top level of each file. It will use the docstring as the description for nodes and functions. You can additionally give more documentation by providing a doc comment above types, functions, or nodes:

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