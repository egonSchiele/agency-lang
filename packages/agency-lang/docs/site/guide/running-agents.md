# Running Agents

This page covers how to execute a `.agency` program once you have written one.

## `agency run` — the default workflow

The simplest way to run an agent is:

```bash
agency run hello.agency
```

This compiles the file to JavaScript and immediately executes it under the same Node binary that's running the CLI. You can also pass `--resume <statefile>` to resume a previously saved execution, or `--trace [file]` to write an execution trace.

## `agency compile` — emit JavaScript

If you want to inspect or ship the generated JavaScript:

```bash
agency compile hello.agency
# writes hello.js next to hello.agency
```

The generated `.js` imports from `agency-lang` (the runtime). You can run it directly with `node hello.js` **as long as `agency-lang` is reachable from Node's module resolver** — i.e. there's an `agency-lang` package in a `node_modules` directory at or above the file's location.

### The global-install gotcha

If you installed agency-lang globally (`npm install -g agency-lang`), running the generated file directly will fail:

```
$ node hello.js
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'agency-lang' imported from /path/to/hello.js
```

Node does **not** look in the global `node_modules` for bare imports. This is a Node limitation, not an agency issue. You have three options:

1. **Use `agency run`** — it knows where the CLI lives and arranges for the compiled file's imports to resolve.
2. **Install agency-lang locally** in the directory next to your `.agency` file: `npm install agency-lang`.
3. **Use `agency pack`** (below) to produce a single-file script that needs no install at all.

When you compile from a global install, agency will print a one-line note steering you to options 1 and 3.

## `agency pack` — portable single-file scripts

`agency pack` produces a self-contained `.mjs` file that runs anywhere Node is installed, with no need for `agency-lang` (or any other package) to be installed at runtime:

```bash
agency pack hello.agency -o hello.mjs
# Packed hello.agency -> hello.mjs

./hello.mjs
# (or `node hello.mjs`)
```

The output is an ESM module bundled with esbuild. Only Node built-ins are kept external; the agency runtime, smoltalk, zod, and any user `.agency` imports are inlined. Files are produced executable (mode `0o755`) with a `#!/usr/bin/env node` shebang.

The default extension is `.mjs` so the output is unambiguously ESM regardless of any surrounding `package.json`'s `"type"`. You can pass `-o foo.js` instead, but inside a project where `package.json` has `"type": "commonjs"` (or no `"type"` at all in newer Node) you may see `MODULE_TYPELESS_PACKAGE_JSON` warnings.

This is useful when you want to:
- hand an agent to someone who doesn't have Node packages installed
- deploy an agent to a minimal container
- ship an agent inside another tool

### Options

| flag | default | meaning |
|---|---|---|
| `-o, --output <file>` | `agent.mjs` | output file path |
| `--target <target>` | `node` | output target; currently only `node` is supported. `sea` (Node single-executable application) is a planned future target |

### Limitations

- Programs that read `.agency` stdlib files at runtime (e.g. anything dynamic) will hit `Could not find package root`. Most user programs do not — the stdlib is consumed at compile time. If you need it inlined for runtime use, file an issue.
- API keys (`OPENAI_API_KEY`, etc.) still need to be present in the environment of the machine running the packed script.
