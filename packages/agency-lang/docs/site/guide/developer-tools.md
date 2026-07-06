---
name: Developer Tools
description: A quick tour of the typecheck, doc, and format commands — static tools that check, document, and tidy your Agency code without running it.
---

# Developer Tools

Alongside compiling and running, here are some other useful commands.

## Type checking

Use `typecheck` (or `tc`):

```bash
agency typecheck foo.agency
agency tc foo.agency
```

You can give it
- a file
- a list of files
- input on stdin.

Directories are not supported yet.

Pass `--strict` to treat variables without types as errors.

You can also set options in `agency.json`.

### References
- [`typecheck` CLI reference](/cli/typecheck)
- [Agency config file](/guide/agency-config-file#type-checking)

## Generating docs

Use `agency doc`:

```bash
agency doc lib -o docs
```

Give it a source file or a directory, and it will generate markdown files as docs. You can then feed the markdown files into your favorite documentation generator, such as [VitePress](https://vitepress.dev).

`agency doc` documents:
- types (if exported)
- functions (if exported)
- nodes
- effects
- effect sets (if exported)

For functions, `agency doc` uses their docstrings as descriptions. You can also add a `/** ... */` doc comment above any of these for more detail:

```ts
/** Greets a person by name. */
def greet(name: string): string {
  return `Hello, ${name}!`
}
```

Each generated entry links back to its source code. Options:

| Flag | Description |
| --- | --- |
| `-o`, `--output <dir>` | Output directory for the generated markdown. Default `docs`. |
| `--base-url <url>` | Base URL that each entry's source link points to. |
| `--ignore <dirs...>` | Directory names to skip when scanning a directory recursively. |

### References
- [`doc` CLI reference](/cli/doc)
- [Agency config file](/guide/agency-config-file#type-checking)

## Formatting

Agency has a built-in formatter. Run `format` (alias `fmt`) on a file, a list of files, or whole directories:

```bash
agency format foo.agency
agency fmt src/
```

By default, the formatted result prints to stdout. Pass `-i` / `--in-place` to overwrite the files instead of printing.

`agency fmt` can also read from stdin:

```bash
cat foo.agency | agency fmt
```

### References
- [`format` CLI reference](/cli/format)