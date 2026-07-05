---
name: Developer Tools
description: A quick tour of the typecheck, doc, and format commands — static tools that check, document, and tidy your Agency code without running it.
---

# Developer Tools

Alongside compiling and running, Agency ships a few commands that work on your source statically — no execution required. They check your code, generate reference docs from it, and keep it neatly formatted.

## Type checking

To type check one or more files without compiling them, use `typecheck` (or its shorter alias `tc`):

```bash
agency typecheck foo.agency
agency tc src/
```

With no input, it reads from stdin. Pass `--strict` to treat untyped variables as errors instead of inferring them — handy if you want every variable to carry an explicit type annotation.

You can also turn type checking on during compilation, and tune how strict each check is, via the `typechecker` block in [`agency.json`](/guide/agency-config-file#type-checking). See the [typecheck CLI reference](/cli/typecheck) for more.

## Generating docs

`agency doc` auto-generates reference documentation from your source:

```bash
agency doc lib -o docs
```

It documents every top-level type, function, and node, using their docstrings as descriptions. Add a `/** ... */` doc comment above a declaration for more detail:

```ts
/** Greets a person by name. */
def greet(name: string): string {
  return `Hello, ${name}!`
}
```

The generated docs also include a `Throws:` line for each function and node, listing the interrupts it may raise (computed by static analysis, including interrupts raised transitively through called functions and `llm()` tools). You can configure the output directory and source-link `baseUrl` in `agency.json`, or pass `-o` and `--base-url` on the command line. Full details are in the [doc CLI reference](/cli/doc).

## Formatting

Agency has a built-in formatter. Run `format` (alias `fmt`) on a file, a list of files, or whole directories:

```bash
agency format foo.agency
agency fmt src/
```

By default the formatted result prints to stdout, and with no input it reads from stdin — easy to wire into an editor or pipeline:

```bash
cat foo.agency | agency fmt
```

Pass `-i` / `--in-place` to overwrite the files instead of printing. See the [format CLI reference](/cli/format) for more.
