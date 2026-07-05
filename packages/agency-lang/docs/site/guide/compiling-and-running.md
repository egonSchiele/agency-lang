---
name: Compiling and Running Code
description: How to run Agency programs and compile them to JavaScript, including watch mode and the classic global-install gotcha.
---

# Compiling and Running Code

Agency code compiles down to plain JavaScript and runs on Node. Most of the time you don't have to think about that — you just run your file — but it's worth knowing what's happening under the hood.

## Running a file

The quickest way to run a program is the `run` command:

```bash
agency run foo.agency
```

This compiles the file and immediately executes its `main` node. `run` is also the default, so you can drop it entirely:

```bash
agency foo.agency
```

Behind the scenes, this compiles your file to JavaScript and runs it under the same Node binary that's running the CLI. See the [run CLI reference](/cli/run) for a couple of extra options, like `--resume` to continue a paused run and `--trace` to record an execution trace.

## Compiling to JavaScript

Sometimes you want the compiled output itself — to inspect it, bundle it, or wire it into a larger project. Use `compile` (also aliased as `build`):

```bash
agency compile foo.agency
agency compile lib/
```

You can pass multiple files or directories; directories are scanned recursively for `.agency` files. A couple of handy flags:

- `--ts` — emit `.ts` files instead of `.js`, so you can read the generated TypeScript.
- `-w, --watch` — recompile automatically whenever the inputs change.

The [compile CLI reference](/cli/compile) has the full list.

## The global-install gotcha

If you installed Agency globally (`npm install -g agency-lang`), there's a classic Node trap to watch out for. A global install makes the `agency` CLI available everywhere, but the `agency-lang` package *isn't* importable everywhere — and your compiled JavaScript imports it.

So compiling works fine:

```bash
agency compile foo.agency
```

...but running the output directly can fail:

```bash
node foo.js
# Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'agency-lang'
```

Two easy fixes:

- **Use `agency run` instead of `node`.** The `run` command knows where the globally installed `agency-lang` package lives, so it just works:

  ```bash
  agency run foo.agency
  ```

- **If you're inside an npm project,** install `agency-lang` locally and the error goes away.

For a truly portable artifact, [`agency pack`](/cli/pack) produces a standalone script that inlines the Agency package — no dependencies, runs anywhere with just Node.
