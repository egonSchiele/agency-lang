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
| `agency local download <value>` | Download a model if not already cached; prints the source it resolved to and the local path. `<value>` may be a curated short name, an alias, an `hf:` URI, or an existing `.gguf` path. |
| `agency local remove <name>` | Delete a downloaded `.gguf` from the cache. |
| `agency local resolve <value>` | Show what a name/alias maps to, without downloading. |
| `agency local refresh [url]` | Fetch the remote model catalog and update the `source:"remote"` aliases in `agency.json`. Adds/updates models from the catalog, removes ones it dropped, and skips any name you've aliased yourself (printing what it would have set). |
| `agency local alias list` | List usable short names. Curated entries show params, category, size, context window, and license (with the description on the next line); your aliases show their target. |
| `agency local alias add <name> <uri>` | Add a short-name alias. Prints the `agency.json` path that was edited. |
| `agency local alias remove <name>` | Remove a short-name alias. Prints the `agency.json` path that was inspected (the file is left untouched if the alias wasn't present). |

### Refreshing the catalog

`agency local refresh` pulls a JSON catalog of recommended models and writes them
into `client.modelAliases` as rich, `source:"remote"`-tagged entries, so new model
recommendations arrive without upgrading agency. Your own hand-added aliases are
never overwritten — on a name clash the command keeps yours and prints the remote
value it skipped.

URL resolution (first wins): the `[url]` argument, `AGENCY_MODEL_CATALOG_URL`,
`client.modelCatalogUrl` in `agency.json`, then the built-in default
(`raw.githubusercontent.com/egonSchiele/agency-lang/main/packages/agency-lang/data/model-catalog.json`).
A remote URL must be `https://` (an `http://` source is rejected). The source
may also be a **local file path** or `file://` URL — e.g.
`agency local refresh ./my-catalog.json` — which reads the catalog from disk
without any network call.

> **Heads-up:** the first refresh writes one tagged entry per catalog model
> into `client.modelAliases`, so a freshly-refreshed `agency.json` will be
> noticeably larger than before. The entries are tagged with `"source": "remote"`
> — anything *without* that tag (your own aliases) is never touched. Re-running
> `agency local refresh` overwrites only the `source:"remote"` entries.

### Where things live

- **Cache dir**: `AGENCY_MODELS_DIR` env var, else `client.modelsDir` in the nearest `agency.json`, else `~/.agency-agent/models`. The default is shared with `agency agent --local-model`, so a `local download` pre-populates what the agent reuses.
- **Aliases**: written to the nearest `agency.json` walking up from the current directory; if none is found, `~/agency.json` is used. The CLI prints which file it edited on every add/remove.
- **Curated catalog**: permissive licenses only (apache-2.0 / mit); restrictively-licensed weights (gemma, llama) are intentionally excluded.

### Config

Aliases, the models cache dir, and the catalog URL live under `client` and are
read at runtime, so edits take effect on the next call:

```jsonc
{
  "client": {
    "modelAliases": {
      "my7b": "hf:Qwen/Qwen2.5-7B-Instruct-GGUF:Q4_K_M"
    },
    "modelsDir": "/data/agency-models",
    // Override the URL `agency local refresh` fetches the model catalog from.
    // Defaults to the catalog committed in the agency repo.
    "modelCatalogUrl": "https://example.com/my-model-catalog.json"
  }
}
```

### See also

- [`agency agent --local-model`](./agent) — the easy button that composes the local-model primitives.
- [Custom providers guide](../guide/custom-providers) — for using any non-llama provider.
