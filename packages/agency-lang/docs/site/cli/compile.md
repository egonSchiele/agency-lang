# Compiling Agency code

Agency code compiles down to plain JavaScript. To compile a file or directory, use the `compile` command (also aliased as `build`):

```
agency compile foo.agency
agency compile lib/
agency build src/ lib/
```

You can pass multiple files or directories. Directories are scanned recursively for `.agency` files.

## Options

- `--ts` — output `.ts` files (with a `// @no-check` header at the top) instead of `.js`. Useful if you want to inspect the generated TypeScript, or feed it into a TypeScript-aware tool.
- `-w, --watch` — watch the inputs for changes and recompile automatically.
