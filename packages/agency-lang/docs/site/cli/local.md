---
title: local
description: Documents the `agency local` command, which downloads, lists, aliases, and removes local GGUF models used by the `llama-cpp` provider.
---

# local

Use this to manage and run local models. Backed by `smoltalk-llama-cpp` + `node-llama-cpp`; install once with `npm i -g smoltalk-llama-cpp` before any subcommand that downloads/inspects models.

```bash
agency local download qwen3.5-2b          # curated name, alias, hf: URI, or .gguf path
agency local list                         # downloaded models + sizes
agency local remove qwen3.5-2b            # delete a downloaded model
agency local resolve my7b                 # show what a name/alias maps to

agency local alias add my7b hf:Qwen/Qwen2.5-7B-Instruct-GGUF:Q4_K_M
agency local alias list                   # curated + your aliases
agency local alias remove my7b
```

The agent has a shortcut for the common case:

```bash
agency agent --local-model qwen3.5-2b     # download (if needed) + run locally
```

`--local-model` runs the local model as both the fast and slow model, so the deep subagents stay local too; it ignores `--model`/`--provider`/`--fastmodel`/`--slowmodel`.

### Subcommands

| command | purpose |
|---|---|
| `agency local list` | List downloaded `.gguf` files with sizes and a total. |
| `agency local download <value>` | Download a model if not already cached; prints the resolved local path. `<value>` may be a curated short name, an alias, an `hf:` URI, or an existing `.gguf` path. |
| `agency local remove <name>` | Delete a downloaded `.gguf` from the cache. |
| `agency local resolve <value>` | Show what a name/alias maps to, without downloading. |
| `agency local alias list` | List usable short names: curated built-ins and your aliases. |
| `agency local alias add <name> <uri>` | Add a short-name alias. Prints the `agency.json` path that was edited. |
| `agency local alias remove <name>` | Remove a short-name alias. Prints the `agency.json` path that was inspected (the file is left untouched if the alias wasn't present). |

### Where things live

- **Cache dir**: `~/.agency-agent/models` by default; override with `AGENCY_MODELS_DIR`.
- **Aliases**: written to the nearest `agency.json` walking up from the current directory; if none is found, `~/agency.json` is used. The CLI prints which file it edited on every add/remove.

### Config

Aliases are stored under `client.modelAliases`:

```jsonc
{
  "client": {
    "modelAliases": {
      "my7b": "hf:Qwen/Qwen2.5-7B-Instruct-GGUF:Q4_K_M"
    }
  }
}
```

Read at runtime, so `agency local alias add/remove` edits take effect on the next call.

### See also

- [`agency agent --local-model`](./agent) — the easy button that composes the local-model primitives.
- [Custom providers guide](../guide/custom-providers) — for using any non-llama provider.
