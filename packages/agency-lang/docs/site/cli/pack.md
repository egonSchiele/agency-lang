---
title: pack
description: Documents the `agency pack` command, which bundles an Agency file plus its runtime and dependencies into a single portable ESM executable that runs anywhere Node is available.
---

# pack

Use this when you want a portable, self-contained file, that runs anywhere without needing agency-lang installed.

```bash
agency pack hello.agency -o hello.mjs
# Packed hello.agency -> hello.mjs

./hello.mjs
# (or `node hello.mjs`)
```



The output is an ESM module bundled with esbuild. The agency runtime + its dependencies (like smoltalk) + any `.agency` imports + any stdlib imports are all inlined. The resulting file is executable (mode `0o755` with a `#!/usr/bin/env node` shebang).

This is useful when you want to:
- hand an agent to someone who doesn't have Node packages installed
- deploy an agent to a minimal container
- third useful thing because rule of threes is important

### Options

| flag | default | meaning |
|---|---|---|
| `-o, --output <file>` | `agent.mjs` | output file path |
| `--target <target>` | `node` | output target; currently only `node` is supported. `sea` (Node single-executable application) is a planned future target |

### Config

You can override the defaults from `agency.json`:

```jsonc
{
  "pack": {
    "format": "esm",        // or "cjs"
    "target": "node20",     // esbuild target string, e.g. "node22"
    "external": []          // extra bare specifiers to leave external
  },
  "verbose": true            // emit bundling progress and esbuild diagnostics during `agency pack`
}
```

### Limitations

- Programs that read `.agency` stdlib files at runtime (e.g. anything dynamic) will hit `Could not find package root`. Most user programs do not — the stdlib is consumed at compile time. If you need it inlined for runtime use, file an issue.
- Code that finds a file next to its own module can't find it once packed. Every module is inlined into the one output file, so "next to this module" now means "next to the packed file", and the file isn't there. Some examples:
  - `__dirname` in your own code, as in `loadTemplate(__dirname, "summarize.agency")`;
  - `run` and `runFile` from `std::agency`, which start a subprocess from a script that ships beside Agency's runtime;
  - stdlib functions that call a helper script, such as the OCR and image tools.

  If your program does any of these, ship the real files instead of packing: your compiled `.js` files and a `node_modules` folder, run with `node`.
- API keys (`OPENAI_API_KEY`, etc.) still need to be present in the environment of the machine running the packed script.

### See also

- You can easily pack up your agent as a web server with [serve](./serve).