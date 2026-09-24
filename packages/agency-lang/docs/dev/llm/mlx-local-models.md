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

The server is `mlx_lm.server`, a Python program from the `mlx-lm` package,
wrapped in a script of ours that adds structured output (see "Structured
output" below). `agency local serve` starts it (see "The serve command"
below). By hand, it is:

```bash
~/mlx-env/bin/python lib/cli/mlxChatServer.py --model /Volumes/models/hf/hub/models--mlx-community--Qwen3-Coder-Next-4bit/snapshots/7b93 --port 8080 --max-tokens 16384
```

The script takes `mlx_lm.server`'s own options. Plain `python -m
mlx_lm.server` works too, but then a typed `llm()` call gets prose back.

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

## Hugging Face caches, and what `mlx:` names

Agency reads three shapes of downloaded model, all through
`_listDownloadedModels`, and each entry says which by its `layout`:

| layout | where | written by |
|---|---|---|
| `gguf` | `<modelsDir>/*.gguf` | `agency local download` |
| `agency` | `<modelsDir>/mlx/<org>--<repo>/` with `.agency-model.json` | `agency local download` |
| `hub` | `<modelsDir>/models--<org>--<repo>/snapshots/<sha>/`, and the same under `<modelsDir>/hub/` | anything that uses the Hub cache |

`hubSnapshotDir` in `lib/stdlib/modelBackend.ts` turns a cache folder into the
snapshot to load: `refs/main` if it names one, else a lone snapshot, else an
error listing them, because guessing a revision is worse than asking. A
`refs/main` that names a snapshot which is missing or incomplete is an error
too, for the same reason. The ref is read through `contained.ts`, not the raw
`fs` this file is allowed to use for names and sizes, so a ref that is a
symlink is refused instead of pointing Agency at a file outside the cache.
`_resolveModel` runs every value and every alias target through it, so a repo
folder and the snapshot inside it are the same model to every caller.

`mlx:<org>/<repo>` names a model by its repo id, not by a place. Callers that
need its files ask `_findDownloadedMlxModel`, which searches every layout, so
the same URI serves a model we downloaded and one already in a Hub cache. Pass
it the revision from an `mlx:` pin and only a copy at that commit counts. A
cache keeps every revision it has fetched and lists only the one `refs/main`
names, so the pinned lookup checks the other snapshots in the folder as well.
`serve` starts the process on whichever directory holds it but keeps naming it
by the repo id, which is also what `run --local mlx:<repo>` sends — the front
door's `Route` has held those two strings apart since it was written.

Because the lookup is by repo id, a bare `org/repo` resolves too, whenever a
model with that id is on disk. `_resolveModel` tries it last, after aliases and
the catalog, and only for a value shaped like a repo id, so it can never
shadow a name or swallow a mistyped path. Messages still print the `mlx:`
form, since that is the spelling that also works for a model you have not
downloaded.

`agency local --model-dir <path>` sets `AGENCY_MODELS_DIR` for the process from
a `preSubcommand` hook, which is precedence #1 in `defaultCacheDir()`, so every
subcommand and the pickers follow it without threading a parameter through.
`remove -f` refuses a `hub` model: its files are symlinks into a shared
`blobs/`, so deleting the snapshot would leave the bytes behind.

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
agency local serve [model]... [--port 8080] [--max-tokens 16384] [--python <path>] [--log-prompts]
```

**With no model named**, `localServe` asks. `serveChoices` in
`lib/cli/localServe.ts` keeps the `mlx` entries of `_listDownloadedModels`
that are complete, and offers them as `mlx:<repo>` in a multiselect, the way
`agency local download` offers the catalog. What "complete" means depends on
the layout: an `agency` model has a record saying every file arrived, while a
`hub` model is complete because the snapshot it points at is a model
directory. The same repo can sit in both layouts, so the choices are keyed by
repo id and only the first is offered; two rows with the same value would let
you pick one model twice, which `runServe` refuses. A GGUF model is never a choice, since it runs in the Agency process
instead. Cancelling, or ticking nothing, exits 0 without serving. Off a
terminal — either end not a TTY — it lists the same models and exits 1, so a
script gets an answer rather than a prompt nobody can see. Only models under the models directory are offered. An alias pointing
somewhere else still has to be named.

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

**Structured output.** `mlx_lm.server` never reads `response_format`, so
a typed `llm()` call used to get prose back. `lib/cli/mlxChatServer.py`,
shipped next to `localServe.js`, is `mlx_lm.server` with that field
honoured: a request naming a JSON schema gets an `llguidance` logits
processor that masks every token which would break the schema. A thinking
model is left free inside its `<think>` block and held to the schema after
it. A request with tools keeps its schema but is not constrained, because a
tool call is not the JSON the schema describes; `smoltalk-llama-cpp` makes
the same choice. The script's docstring explains the phases and the seams
it patches in `mlx_lm.server`. Those seams are why `MLX_LM_VERSION` in
`localServe.ts` pins mlx-lm, the way `MLX_AUDIO_VERSION` pins mlx-audio,
and why `checkPython` asks for `llguidance` before serving a chat model.

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

**The request log.** The door takes a `DoorLogging` — where to print, whether
to include prompts, and a color function — and writes one entry per request as
it ends:

```
POST /v1/chat/completions  mlx-community/Qwen3.5-4B-MLX-4bit  200  2.6s  16→129 tok
```

`lib/cli/serveLog.ts` holds the formatting, so it is all pure functions over a
`LogEntry`. Verbose adds the whole request body (`→`) and the whole reply
(`←`) under that line — indented JSON, or a stream left frame for frame,
since the framing is often what you are debugging. The vendored commander
refuses a subcommand option that shadows the CLI's own `--verbose`, so serve
declares `--log-prompts` and the action reads the global flag as well; both
spellings mean the same thing, and `--verbose` is the one to reach for. Color
comes from `lib/utils/termcolors.ts` and is chosen once by `autoUseColor()`,
which honors `NO_COLOR` and `FORCE_COLOR`.

Reading the reply means the door can no longer only `pipe` it. `createCapture`
keeps a copy of up to 1 MiB as the bytes go past; the client's stream is
untouched, and a longer reply is logged with `… (truncated)`. `describeReply`
then keeps that body whole and reads the token counts out of it: from `usage`
in a JSON reply, or from whichever frame of a stream carries `usage`, which is
the last one. An entry is written once,
whether the reply ended, the client went away, or the door itself answered 400,
404 or 502.

**Readiness.** The server prints nothing when a model has loaded. After
each start, `waitUntilLoaded` sends one request to the internal port and
retries every 500 ms while the port is closed. A 2xx reply means the model
is loaded. Any other status is a server that refuses the model, and the
wait fails with the status and body. If any process started so far exits
during the wait, it fails with the exit code and every process is killed.

Which request it sends depends on the kind of process. A chat process gets
a one-token completion naming the model directory, an embedding process an
embeddings request, and a speech process `GET /health`.

**Python.** `--python`, then `client.mlx.python`, then `AGENCY_MLX_PYTHON`,
then `~/.agency-agent/mlx-env/bin/python`. `serve` imports the module each
planned kind needs: `mlx_lm` for a chat or embedding model, `mlx_audio` for
a speech model. On failure it prints the venv commands for the default
environment, installing what those kinds need, and exits. Agency does not
install Python.

**Stopping.** Ctrl-C reaches the children before `serve`, since they share
its process group, so a child's exit can arrive before the signal handler
runs. `runServe` waits a moment after an exit and reports it only if it is
not already stopping. A process that dies on its own after it was ready
makes the command print why, kill the rest, and exit 1. Closing the front
door closes its open connections too, or a reply still streaming from a
killed process would keep it from ever closing.

## Embeddings

`mlx_lm.server` has no embeddings route, so `serve` starts a different
program for an embedding model:

    agency local serve qwen3-coder-next-mlx --embedding qwen3-embedding-4b-mlx

The program is `lib/cli/mlxEmbedServer.py`, shipped next to
`localServe.js`. It loads the model with `mlx_lm.load` and, for each
input, runs the inner transformer (`model.model(tokens)`, the final hidden
states) and takes the last token's vector, L2-normalized: the Qwen3
Embedding recipe. It answers `POST /v1/embeddings` in the OpenAI shape,
plus `/v1/models` and `/health`, one request at a time. It binds its port
only after the model has loaded, because readiness treats a refused
connection as "still loading" and any reply as "ready". The script uses
mlx-lm alone; `mlx-embeddings`, the library other MLX servers use, is GPL
v3, which Agency cannot ship.

`--embedding` is the one way to say a model is an embedding model. The
catalog category is a guard: a catalog embedding model without the flag,
or a chat model with it, is refused before anything loads, and the picker
leaves embedding models out. The front door needs no change, since it
forwards by the `model` field at whatever path the request used.
Readiness probes an embedding process with an embeddings request.

Memory never derives an embedding model for a local provider. It needs
`memory.embeddings` in `agency.json` with the served name and
`"provider": "mlx"`, or in `agency agent`, `--model embedding=mlx/<name>`
(on the command line or in `/model`). A catalog name resolves to the
served name; a repo id passes through. Naming an embedding model turns
memory on even though the `mlx` capability profile has it off: in
`memoryEnablePlan`, a provider-level off yields to a ready embedding
override, and a user-level off wins. The resolved capability then reads
`memory: true` from the source `embedding-override`, which `/settings`
shows.

## Speech

`--speech` starts a speech model with `lib/cli/mlxSpeechServer.py`, which
answers `POST /v1/audio/speech`:

    agency local serve --speech qwen3-tts-mlx

The catalog guard and the picker treat the `speech` category the way they
treat `embedding`. A speech process needs `mlx_audio` rather than `mlx_lm`,
and it speaks once before opening its port, so readiness only probes
`GET /health`. See `local-speech.md` for the script and its request rules.

## `remove` and `-f`

`agency local remove <name>` removes the alias and keeps the files. It prints
where they are and says to run again with `-f` to delete them. `-f` removes
the alias and deletes the `.gguf` file or the whole MLX directory. A directory
outside the models directory is never deleted. An alias whose directory has
gone can still be removed. This holds for GGUF models too.

## Downloading

`agency local download mlx:<org>/<repo>[@<rev>]` fetches the repo with
direct HTTPS requests into `<modelsDir>/mlx/<org>--<repo>/`. The files land under
their own names, so the directory is a normal model directory that
`mlx_lm.load` and `agency local serve` take as it is. Beside them,
`.agency-model.json` records the commit sha and, per file, its size, its
sha256 when the Hub publishes one, and which chunks are on disk.

Two files split the work:

- `lib/stdlib/hubClient.ts` talks to the Hub: the model API for the
  commit sha and the gated flag, the tree API for the file list (paged
  through a `Link` header), `resolve/` for the URL a file's bytes come
  from, and one byte range of a file. Every request goes through one
  method that refuses http and sends `HF_TOKEN` to the hub host only. A range that delivers no bytes for a minute is
  abandoned so a dead connection cannot hang a download.
- `lib/stdlib/hubDownload.ts` plans the chunks (64 MiB each), runs a pool
  of `client.mlx.downloadConcurrency` workers over them, writes each
  piece at its offset through `openForWrite` from `contained.ts`, and
  keeps the record current. A chunk gets several attempts with growing
  waits. An expired CDN URL is resolved again and does not count as an
  attempt.

**Resume.** A second run reads the record and plans only the chunks it
does not list. A record from another revision is refused with a message
naming both shas and the `@<rev>` pin. A directory with files but no
record adopts the ones whose size and hash match. A file with no chunks
recorded is truncated before its first chunk, so a stale copy cannot
leave bytes behind. An empty file is created without a request.

**Verification.** When a file's last chunk lands, an LFS file is hashed
and a plain one is checked by size. A bad LFS file goes to
`<file>.invalidSha` through `verifyModelFile`; either kind resets the
file's record entry, fails the run, and is fetched whole next time.

The tests run against `lib/stdlib/__tests__/fakeHub.ts`, a `node:http`
server that answers the same routes and redirect shapes as the Hub.

## Catalog entries

The built-in catalog lives in `lib/stdlib/modelCatalog.ts` (moved out of
`localModels.ts` for the line limit) and is mirrored in
`data/model-catalog.json`. MLX entries use an `mlx:` URI, carry no
`sha256` because the downloader verifies each file from the Hub's own
hashes, and end in `-mlx` when a GGUF entry of the same model exists.
Sizes are the whole repo, read from the Hub API. Three categories were
added with them: `writing`, `science`, and `uncensored`.
