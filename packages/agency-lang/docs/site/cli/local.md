---
title: local
description: Documents the `agency local` command, which downloads, lists, aliases, and removes local models. GGUF models run through the `llama-cpp` provider; MLX models run in a server through the `mlx` provider.
---

# local

Use this to manage and run local models. There are two kinds:

- **GGUF models** run inside the Agency process through llama.cpp. Install `smoltalk-llama-cpp` once with `npm i -g smoltalk-llama-cpp` before downloading or running one.
- **MLX models** run in a server on a Mac with Apple Silicon. You start the server yourself with `mlx_lm.server` from the Python `mlx-lm` package. Agency sends it requests. Nothing extra to install on the Agency side.

Every model has a **backend**, `llama-cpp` or `mlx`. The name you type says which it is:

| You type | Backend |
|---|---|
| a curated name such as `qwen3.5-2b` | from the catalog entry |
| `hf:org/repo:Q4_K_M` or a `.gguf` path | `llama-cpp` |
| `mlx:org/repo` or `mlx:org/repo@revision` | `mlx` |
| a directory holding `config.json` and `.safetensors` files | `mlx` |

```bash
agency local download                     # pick a model from the catalog interactively
agency local download qwen3.5-2b          # curated name, alias, hf: URI, or .gguf path
agency local list                         # the catalog, with backends and downloaded models marked
agency local list -l                      # ...and each model's description
agency local remove my7b                  # remove the alias, keep the files
agency local remove my7b -f               # remove the alias and delete the files
agency local resolve my7b                 # show the backend and what a name/alias maps to

agency local alias add my7b hf:Qwen/Qwen2.5-7B-Instruct-GGUF:Q4_K_M
agency local alias add coder /models/mlx-community--Qwen3-Coder-Next-4bit   # an MLX model directory
agency local alias list                   # curated + your aliases, with descriptions
agency local alias remove my7b
```

The agent and `agency run` have shortcuts for the common case:

```bash
agency agent --local qwen3.5-2b           # download (if needed) + run the agent locally
agency run --local qwen3.5-2b my.agency   # download (if needed) + run a program locally
agency run --local coder my.agency        # an MLX model: needs a running mlx_lm.server
```

The agent's `--local` runs the local model as both the fast and slow model, so the deep subagents stay local too; it ignores `--model`/`--fastmodel`/`--slowmodel`. On `agency run`, `--local` and `--model` are mutually exclusive. See the [local models guide](/guide/using-local-models) for a walkthrough.

### Running an MLX model

An MLX model is a Hugging Face repo of `.safetensors` files, such as `mlx-community/Qwen3-Coder-Next-4bit`. Agency does not run it itself. Start the server on the model directory, then run against it:

```bash
# Terminal 1. Python 3.11 or newer with mlx-lm installed.
python3 -m mlx_lm.server --model /models/mlx-community--Qwen3-Coder-Next-4bit --port 8080 --max-tokens 16384

# Terminal 2.
agency local alias add coder /models/mlx-community--Qwen3-Coder-Next-4bit
agency run --local coder my.agency
```

Agency sends the server the same string you gave `--model`: the directory path for a directory alias, or the repo id for an `mlx:` URI. The server serves whatever model a request names and loads it if it is not loaded, so start the server with the string `agency local resolve` prints.

The server listens on `http://127.0.0.1:8080/v1` by default. For another port, set `MLX_BASE_URL` or `client.baseUrl.mlx` in `agency.json`.

A Hugging Face cache snapshot directory (`hf/hub/models--<org>--<repo>/snapshots/<sha>`) works as is. Its entries are symlinks into `blobs/`, and Agency follows them for this one check.

Downloading an MLX model with `agency local download` is not supported yet.

### Subcommands

| command | purpose |
|---|---|
| `agency local list` | Show the full catalog with each model's backend, and a checkmark and on-disk size for downloaded models. The first line names the models directory. Files that match no catalog entry appear under `OTHER FILES`. Add `-l` / `--long` to print each model's description on its own line below its row. Works without `smoltalk-llama-cpp` installed. |
| `agency local download [value]` | Download a GGUF model if not already cached; prints the source it resolved to and the local path. `<value>` may be a curated short name, an alias, an `hf:` URI, or an existing `.gguf` path. With no value, opens an interactive picker (in scripts it prints the catalog and exits 1 instead). An `mlx:` URI is refused: MLX downloads are not supported yet. |
| `agency local serve <model>... [--port 8080] [--max-tokens 16384] [--python <path>]` | Serve one or more MLX models in this terminal. Starts one `mlx_lm.server` per model, waits until each has loaded, then listens on `--port`. A request for a model you did not name gets a 404 naming the command to start it. It never downloads. An `mlx:` model must be downloaded first, and a directory works as is. Ctrl-C stops everything. |
| `agency local remove <name> [-f]` | Remove the alias for a model and keep its files, printing where they are. With `-f`, delete the files too: the `.gguf` file, or the whole MLX model directory. Files outside the models directory are never deleted. |
| `agency local resolve <value>` | Show the backend and what a name/alias maps to, without downloading. |
| `agency local refresh [url]` | Fetch the remote model catalog and update the `source:"remote"` aliases in `agency.json`. Adds/updates models from the catalog, removes ones it dropped, and skips any name you've aliased yourself (printing what it would have set). |
| `agency local alias list` | List usable short names. Curated entries show params, category, size, context window, and license (with the description on the next line); your aliases show their target. |
| `agency local alias add <name> <target>` | Add a short-name alias. The target is an `hf:` URI, a `.gguf` path, an `mlx:` URI, or an MLX model directory. Prints the `agency.json` path that was edited. |
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

- **Cache dir**: `AGENCY_MODELS_DIR` env var, else `client.modelsDir` in the nearest `agency.json`, else `~/.agency-agent/models`. `agency local list` prints the resolved directory on its first line. The default is shared with `agency agent --local` and `agency run --local`, so a `local download` pre-populates what both reuse.
- **Aliases**: written to the nearest `agency.json` walking up from the current directory; if none is found, `~/agency.json` is used. The CLI prints which file it edited on every add/remove.
- **Curated catalog**: permissive licenses only (apache-2.0 / mit); restrictively-licensed weights (Gemma 1–3's custom terms, llama) are intentionally excluded. Gemma 4 ships under apache-2.0, so it is included.

### Config

Aliases, the models cache dir, and the catalog URL live under `client` and are
read at runtime, so edits take effect on the next call:

```jsonc
{
  "client": {
    "modelAliases": {
      "my7b": "hf:Qwen/Qwen2.5-7B-Instruct-GGUF:Q4_K_M",
      "coder": "mlx:mlx-community/Qwen3-Coder-Next-4bit",
      // The object form needs a "backend" that matches the uri.
      "big": { "backend": "mlx", "uri": "mlx:mlx-community/DeepSeek-V4-Flash-4bit", "params": "300B" }
    },
    "modelsDir": "/data/agency-models",
    // Override the URL `agency local refresh` fetches the model catalog from.
    // Defaults to the catalog committed in the agency repo.
    "modelCatalogUrl": "https://example.com/my-model-catalog.json"
  }
}
```

### See also

- [Using local models guide](../guide/using-local-models) — the walkthrough, from install to `llm()` calls in code.
- [`agency agent --local`](./agent) — the easy button that composes the local-model primitives.
- [Custom providers guide](../guide/custom-providers) — for using any other provider.
