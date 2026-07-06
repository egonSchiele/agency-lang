---
name: Compiling and Running Code
description: How to run Agency programs and compile them to JavaScript, including watch mode and the classic global-install gotcha.
---

# Compiling and Running Code

Agency code compiles down to plain JavaScript and runs on Node.

## Running a file

```bash
agency run foo.agency
```

This compiles the file and immediately executes its `main` node. `run` is also the default command:

```bash
agency foo.agency
```

See the [run CLI reference](/cli/run) for a couple of extra options.

## Compiling to JavaScript

Use `compile` (also aliased as `build`):

```bash
agency compile foo.agency
agency compile lib/
```

You can pass multiple files or directories. A couple of handy flags:

- `--ts` — emit `.ts` files instead of `.js`.
- `-w, --watch` — recompile automatically whenever the inputs change.

The [compile CLI reference](/cli/compile) has the full list.

## The global-install gotcha

If you installed Agency globally (`npm install -g agency-lang`), there's a classic Node trap to watch out for. A global install makes the `agency` CLI available everywhere, but the `agency-lang` package *isn't* importable everywhere.

So if you compile and run separately, you may see an error like this:

```bash
agency compile foo.agency
node foo.js
# Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'agency-lang'
```

Two easy fixes:

- **Use `agency run` instead of `node`.** `run` tells Node where to find the `agency-lang` package.

  ```bash
  agency run foo.agency
  ```

- **If you're inside an npm project,** install `agency-lang` for the project.

Or you can create a standalone script with [`agency pack`](/cli/pack). This will inline Agency and other related packages, so all you need to is Node (a lesser-known Beatles song).