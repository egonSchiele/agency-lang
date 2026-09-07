# MLX local models

How Agency runs MLX models. The GGUF path, which runs a model inside the
Agency process through llama.cpp, is in `local-models.md`. This page covers
the second backend, which runs a model in a server on a Mac.

The user-facing shape:

```bash
agency local alias add coder /Volumes/models/hf/hub/models--mlx-community--Qwen3-Coder-Next-4bit/snapshots/7b93
agency local resolve coder            # mlx  /Volumes/models/...
agency run --local coder my.agency    # provider mlx, model = that directory
agency agent --local coder
```

The server is `mlx_lm.server`, a Python program from the `mlx-lm` package.
The user starts it on a model:

```bash
~/mlx-env/bin/python -m mlx_lm.server --model /Volumes/models/hf/hub/models--mlx-community--Qwen3-Coder-Next-4bit/snapshots/7b93 --port 8080 --max-tokens 16384
```

Agency reaches it through smoltalk's built-in `mlx` provider, which speaks
the OpenAI chat format to `http://127.0.0.1:8080/v1` by default, or to
`MLX_BASE_URL`. The spec for the whole feature is
`2026-09-07-mlx-local-models-spec.md` in the package root.

## Two backends

`Backend` in `lib/stdlib/localModels.ts` is `"llama-cpp" | "mlx"`. Every
model Agency knows about has exactly one. `backendOfTarget(target)` decides:

| Target | Backend |
|---|---|
| `hf:org/repo:Q4_K_M`, `https://…/x.gguf`, `x.gguf` | `llama-cpp` |
| `mlx:org/repo`, `mlx:org/repo@rev` | `mlx` |
| A directory with `config.json` and a `.safetensors` file | `mlx` |
| Anything else | throws "is not a model" |

The directory rule is what makes models downloaded by other tools usable.
Every model in Hugging Face's standard layout has a `config.json` and its
weights in `.safetensors` files. That is what `mlx_lm.server` loads. A GGUF
model is one file with that information inside it, so it never matches.

`_resolveModel(value)` turns a name, alias, URI, or path into
`{ backend, target }`. `_resolveModelName` returns only the target and stays
for the callers that need a string.

## The `backend` field

Every entry in `CURATED_LOCAL_MODELS`, in `data/model-catalog.json`, and every
object-form alias in `agency.json` carries `backend`. It is required, and it
must agree with the URI. `readModelAliases` throws for a bad alias:

```
agency.json: alias "coder" has no "backend". Add "backend": "llama-cpp" or
"backend": "mlx" to the entry in /Users/me/project/agency.json.

agency.json: alias "coder" says backend "mlx" but its uri "hf:org/repo:Q4_K_M"
is a GGUF file. Change one of them in /Users/me/project/agency.json.
```

`CatalogModelSchema` refuses a remote catalog entry without the field or with
a disagreeing one, and the refresh skips it with a warning, the same way it
skips a bad URI. A test walks the built-in table, so those errors can only
come from a user's file or a remote catalog.

A string-form alias, `"my7b": "hf:…"`, has nowhere to put the field. Its
prefix is its backend.

## Running against the server

`agency run --local <name>` and `agency agent --local <name>` branch on the
backend. For `mlx` they download nothing and register nothing. They set the
provider to `mlx` and the model to `_mlxServedName(resolved)`:

- a repo id for an `mlx:` URI, so `mlx:org/repo@rev` sends `org/repo`;
- the absolute directory path for a model directory.

The server serves whatever model a request names, and loads it if it is not
loaded. So the string Agency sends must be the string the server was started
with, or a run can trigger a load of another model. Start the server with
the repo id or the absolute directory path, whichever `resolve` prints.

The agent's `PROVIDER_CAPABILITIES` table has an `mlx` entry with
`memory: false` only. The server has no embeddings endpoint, so the agent's
memory stays off. The models are large enough for the full prompt.

## The record file and the directory layout

MLX models under the models directory sit one folder per repo:

```
<modelsDir>/
  qwen3.5-2b-Q4_K_M.gguf
  downloads.json
  mlx/
    mlx-community--Qwen3-Coder-Next-4bit/
      .agency-model.json
      config.json
      model-00001-of-00009.safetensors
```

`lib/stdlib/mlxModelRecord.ts` owns `.agency-model.json`: the repo, the commit
it came from, and per-file size, hash, and progress. A directory under `mlx/`
without a valid record is not a model. `list` reads the record to mark a
model downloaded, and to show an incomplete one under OTHER FILES. A pinned
revision in an `mlx:` URI must match the record's commit, by prefix, to get
the tick. `_listDownloadedModels` returns GGUF files and recorded MLX
directories together, each tagged with its backend.

## `remove` and `-f`

`agency local remove <name>` removes the alias and keeps the files. It prints
where they are and says to run again with `-f` to delete them. `-f` removes
the alias and deletes the `.gguf` file or the whole MLX directory. A directory
outside the models directory is never deleted. An alias whose directory has
gone can still be removed. This holds for GGUF models too.

## Downloading

`agency local download` of an `mlx:` URI is refused with a message that
points at `alias add`. A model directory passed to it is returned as is.
