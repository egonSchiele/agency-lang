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
`agency local serve` starts it (see "The serve command" below). By hand, it
is:

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

A Hugging Face cache snapshot, `hf/hub/models--org--repo/snapshots/<sha>/`,
holds no real files. Every entry is a symlink into `blobs/`, and
`contained.ts` drops symlinked entries. So `modelDirEntries` in
`lib/stdlib/modelBackend.ts` is the one place in the stdlib that follows
links: `readdirSync` plus `statSync`, reading names and sizes and nothing
else. `isModelDir` and the size sum in `_modelFilesOnDisk` both go through
it, so a snapshot alias works as is and reports its real size.
`modelBackend.ts` is on the `FS_IMPORTERS` allow-list in `eslint.config.js`
for this. Everything else, including `remove -f`, stays behind
`contained.ts` and refuses to follow a link.

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

## The serve command

```
agency local serve <model>... [--port 8080] [--max-tokens 16384] [--python <path>]
```

`runServe` in `lib/cli/localServe.ts` does, in order: resolve each name
(a GGUF model is an error), find the directory (an `mlx:` model needs a
complete record under `<modelsDir>/mlx/`; `serve` never downloads), print
the memory warning if the sizes exceed `os.totalmem()` and continue, choose
a Python and check it, start one process per model, then open the front door.

**One process per model.** `mlx_lm.server` holds one model per process and
loads whatever model a request names. From `ModelProvider.load` in
`mlx_lm/server.py`, the loaded model is keyed on the exact `model` string,
and only the literal `"default_model"` maps to the `--model` flag. So the
server is not exposed directly, because a typo in a model name would load a
second model. `serve` starts one process per model on a free internal port
and puts its own server in front.

**The front door** (`lib/cli/mlxServer.ts`) listens on `--port`, reads
the request body, and forwards to the process whose public name matches the
`model` field. It rewrites `model` to the string the process was started
with, the model directory, because that is the key the process holds. A
request for any other model gets a 404 and reaches no process:

```
This server is serving X and Y. It is not serving Z. Start it with: agency local serve mlx:Z
```

`GET /v1/models` answers with the served list. `mlxServerModels` and
`mlxServerRunning` in `std::agency/local` read it. Replies are piped
through, so streaming works. A client that disconnects mid-reply destroys
the upstream request, so the server stops generating.

**Readiness.** The server prints nothing when a model has loaded. After
each start, `waitUntilLoaded` posts a one-token completion to the internal
port, naming the model directory, and retries every 500 ms while the port
is closed. A 2xx reply means the model is loaded. Any other status is a
server that refuses the model, and the wait fails with the status and
body. If any process started so far exits during the wait, it fails with
the exit code and every process is killed.

**Python.** `--python`, then `client.mlx.python`, then `AGENCY_MLX_PYTHON`,
then `~/.agency-agent/mlx-env/bin/python`. `serve` runs
`<python> -c "import mlx_lm"` and, on failure, prints the venv commands for
the default environment and exits. Agency does not install Python.

**Stopping.** Ctrl-C reaches the children before `serve`, since they share
its process group, so a child's exit can arrive before the signal handler
runs. `runServe` waits a moment after an exit and reports it only if it is
not already stopping. A process that dies on its own after it was ready
makes the command print why, kill the rest, and exit 1. Closing the front
door closes its open connections too, or a reply still streaming from a
killed process would keep it from ever closing.

## `remove` and `-f`

`agency local remove <name>` removes the alias and keeps the files. It prints
where they are and says to run again with `-f` to delete them. `-f` removes
the alias and deletes the `.gguf` file or the whole MLX directory. A directory
outside the models directory is never deleted. An alias whose directory has
gone can still be removed. This holds for GGUF models too.

## Downloading

`agency local download mlx:<org>/<repo>[@<rev>]` is `lib/stdlib/hubDownload.ts`.
It needs no Python and no new dependency, because the Hub gives a plain
HTTP client everything:

- `GET /api/models/<repo>` (or `/revision/<rev>` for a pinned one, short
  shas accepted) returns the commit sha and whether the repo is gated.
- `GET /api/models/<repo>/tree/<sha>?recursive=true` lists every file with
  its size, and for LFS files `lfs.oid`, which is the file's SHA-256. Small
  text files are plain git blobs with no usable hash and are checked by
  size. A large repo pages this with a `Link: …; rel="next"` header, which
  is followed.
- `GET /<repo>/resolve/<sha>/<path>` redirects to a signed CDN URL. Small
  files take a relative hop through the hub first, so each location is
  resolved against the URL it came from, and the walk stops at the first
  URL off the hub host. Every hop must be https. The token, when there is
  one, goes to the hub host only.
- The CDN URL honours `Range` with 206 and a `content-range` whose total is
  checked against the tree's size. The signature expires, and a 403 on it
  means resolve again, once.

**Chunks and the record.** Each file is split into 64 MiB chunks. A pool
of `client.mlx.downloadConcurrency` workers (default 8) fetches them and
writes each at its offset. This is why the file is on `FS_IMPORTERS`:
`contained.ts` can overwrite or append but has no write-at-offset, and
every path still goes through `resolveUnder` first, so a tree entry like
`../x` is refused. After each chunk the index is added to the file's entry
in `.agency-model.json`. A second run plans only the chunks not recorded;
a record from another revision is refused with the message naming both
shas and the `@<rev>` pin. A directory with files but no record adopts
the ones whose size and hash match, so a copy made by hand is not fetched
again.

**Verification.** When a file's last chunk lands it is hashed. A mismatch
moves it to `<file>.invalidSha` through `verifyModelFile`, resets its
record entry to no chunks, and fails the run. The next run fetches that
file whole and nothing else. `fileSha256` and `verifyModelFile` live in
`modelVerify.ts` so this file and `localModels.ts` can both import them.

**Tests** run against `lib/stdlib/__tests__/fakeHub.ts`, a `node:http`
server with the four routes above, the same redirect shapes, byte ranges,
a per-range hit counter, a gated mode, and switches for an expired CDN URL
and a failing resolve. It answers as `127.0.0.1` for the hub and
`localhost` for the CDN so a test can see the token stop at the hub.
