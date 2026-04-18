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