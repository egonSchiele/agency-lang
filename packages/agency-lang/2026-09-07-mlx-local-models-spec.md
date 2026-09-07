# MLX local models in Agency

Written 2026-09-07 on branch `adit/mlx-spike`. The smoltalk half is
`/Users/adityabhargava/smoltalk/packages/smoltalk/2026-09-07-mlx-provider-spec.md`.

## What you will be able to do

```bash
# Download a model. Resumes if interrupted.
agency local download mlx:mlx-community/Qwen3-Coder-Next-4bit

# Serve it. Stays in this terminal. Ctrl-C stops it.
agency local serve mlx:mlx-community/Qwen3-Coder-Next-4bit

# Or serve two models at once, if they both fit in memory.
agency local serve mlx:mlx-community/Qwen3-Coder-Next-4bit mlx:mlx-community/Qwen3.8-27B-4bit

# In another terminal, use it.
agency run --local mlx:mlx-community/Qwen3-Coder-Next-4bit my.agency
agency agent --local mlx:mlx-community/Qwen3-Coder-Next-4bit
```

Today `agency local` works with one kind of model: GGUF files, run by
llama.cpp inside the Agency process. This spec adds a second kind: MLX
models, run by a Python server on a Mac. The rest of this document explains
how the current system works, then what changes.

## Part 1: How local models work today

### The catalog

`CURATED_LOCAL_MODELS` in `lib/stdlib/localModels.ts` is a table of about 25
models. Each entry looks like this:

```ts
"qwen3.5-2b": {
  uri: "hf:unsloth/Qwen3.5-2B-GGUF:Q4_K_M",
  params: "2B",
  sizeBytes: 1280000000,
  category: "general",
  contextWindow: 131072,
  license: "apache-2.0",
  description: "Most popular modern small general model.",
  sha256: "aaf42c8b…",
},
```

The `uri` names one GGUF file in a Hugging Face repo. The `sha256` is the
hash of that file. The same table is published as `data/model-catalog.json`,
and `agency local refresh` pulls new entries from there.

### Aliases

You can add your own names in `agency.json`:

```jsonc
{
  "client": {
    "modelAliases": {
      "my7b": "hf:Qwen/Qwen2.5-7B-Instruct-GGUF:Q4_K_M",
      "coder": { "uri": "hf:…", "params": "30B", "sha256": "…" }
    }
  }
}
```

A value is either a URI string or an object with the same fields as a catalog
entry. `ModelAliasSchema` in `lib/config.ts` validates the object form.

### Where files go

`defaultCacheDir()` picks the models directory. It checks, in order:

1. The `AGENCY_MODELS_DIR` environment variable.
2. `client.modelsDir` in the nearest `agency.json`.
3. `~/.agency-agent/models`.

GGUF files sit flat in that directory.

### Downloading

`_downloadModel(name)` resolves the name to a URI, then asks the
`smoltalk-llama-cpp` package to download it. After a fresh download it hashes
the file. A mismatch moves the file to `<file>.invalidSha` and fails. Finally
it records the download in `downloads.json`, which `agency local list` reads
to show a tick next to downloaded models.

### Running

`agency run --local qwen3.5-2b` downloads the model if needed and sets the
provider to `llama-cpp`. `agency agent --local qwen3.5-2b` does the same and
also switches the agent to a smaller prompt with output capped at 2000
tokens, because small GGUF models misbehave with long prompts. That table is
`PROVIDER_CAPABILITIES` in `lib/agents/agency-agent/lib/capabilities.agency`.

### The install check

Downloading and running need the `smoltalk-llama-cpp` package. `agency local
download` refuses to run without it. `agency local list` works without it.

## Part 2: What MLX needs that GGUF does not

### The server

An MLX model is a Hugging Face repo of safetensors files. It cannot run in
Node. It runs in a Python server that you start yourself:

```bash
mlx_lm.server --model mlx-community/Qwen3-Coder-Next-4bit --port 8080
```

The server loads the model once, keeps it in memory, and answers requests in
the OpenAI format. Agency reaches it through a new smoltalk provider named
`mlx`. That provider is specified in the smoltalk document linked above.

Agency will not start this server in the background for you, and it never
loads a model you did not name. You run `agency local serve` with the models
you want, in a terminal where you can see the logs. A request for any other
model is an error.

Four facts about the server shape the design:

1. It prints nothing while loading. The only way to know the model is ready
   is to send a request and wait.
2. Its `--max-tokens` flag defaults to 512. Agency does not set `max_tokens`
   on requests, so without a larger value every long reply is cut off.
3. It loads any model a request names, even if a different one is loaded,
   and there is no flag to stop it. Each process holds one model at a time.
   This is why `serve` puts its own small server in front of it. See 3.5.
4. `ps` shows about 3GB for a server holding a 42GB model. Activity Monitor
   shows the real number.

### The download

Hugging Face gives a plain HTTP client everything needed. The tree API lists
every file with its size and hash:

```
GET https://huggingface.co/api/models/mlx-community/Qwen3-Coder-Next-4bit/tree/main?recursive=true

{ "path": "model-00001-of-00009.safetensors", "size": 5132893190,
  "lfs": { "oid": "fb30a272…" } }
```

`lfs.oid` is the file's SHA-256. The download URL for a file redirects to a
CDN that accepts byte ranges:

```
GET https://huggingface.co/mlx-community/Qwen3-Coder-Next-4bit/resolve/main/model-00001-of-00009.safetensors
Range: bytes=1000-1999

206 Partial Content
content-range: bytes 1000-1999/5132893190
```

So Agency can download each file as many parallel chunks, resume at any byte,
and verify the result. No Python and no new npm package are needed.

`HF_TOKEN` only raises rate limits. It does not make downloads faster. Gated
repos need it to download at all. Nothing else does.

## Part 3: Design

### 3.1 Naming a model

You name an MLX model with a new `mlx:` prefix:

```bash
agency local download mlx:mlx-community/Qwen3-Coder-Next-4bit          # latest commit
agency local download mlx:mlx-community/Qwen3-Coder-Next-4bit@7b9321e  # pinned commit
```

`hf:` URIs and `.gguf` paths still mean GGUF. A directory path means an MLX
model if the directory contains a `config.json`:

```bash
agency local alias add coder /Volumes/adit-agency-models-sept-2026/hf/hub/models--mlx-community--Qwen3-Coder-Next-4bit/snapshots/7b9321eabb85ce79625cac3f61ea691e4ea984b5
```

This is how models you already downloaded another way become usable without
moving them.

### 3.2 The `backend` field

Every catalog entry and every object-form alias has a `backend` field. The
value is `"llama-cpp"` or `"mlx"`:

```ts
"qwen3-coder-next": {
  backend: "mlx",
  uri: "mlx:mlx-community/Qwen3-Coder-Next-4bit",
  params: "80B (3B active)",
  sizeBytes: 44855709150,
  …
},
```

The field is required. An entry without it is an error:

```
agency.json: alias "coder" has no "backend". Add "backend": "llama-cpp" or
"backend": "mlx" to the entry in /Users/me/project/agency.json.
```

If the field disagrees with the URI, that is also an error. A unit test
checks every built-in entry has the field, so this error can only come from
a user's `agency.json` or a remote catalog. A remote catalog entry without
the field is skipped with a warning.

A string-form alias like `"my7b": "hf:…"` has no field. Its prefix says what
it is. See the decisions at the end.

### 3.3 Where MLX models are stored

MLX models go in the same models directory as GGUF files, under an `mlx`
subdirectory:

```
<modelsDir>/
  qwen3.5-2b-Q4_K_M.gguf
  downloads.json
  mlx/
    mlx-community--Qwen3-Coder-Next-4bit/
      .agency-model.json
      config.json
      model-00001-of-00009.safetensors
      …
```

To keep models on an external drive, set `client.modelsDir` in `agency.json`.
This setting already exists.

`.agency-model.json` records what has been downloaded:

```json
{
  "repo": "mlx-community/Qwen3-Coder-Next-4bit",
  "revision": "7b9321eabb85ce79625cac3f61ea691e4ea984b5",
  "files": {
    "config.json": { "size": 22196, "complete": true },
    "model-00001-of-00009.safetensors": {
      "size": 5132893190,
      "sha256": "fb30a272…",
      "complete": false,
      "chunks": [0, 1, 2, 5]
    }
  }
}
```

A model is complete when every file is complete. `serve` refuses an
incomplete model and tells you to run `download` again.

### 3.4 `agency local download`

For an `mlx:` model, `download` uses new code in `lib/stdlib/hubDownload.ts`.
The GGUF path is unchanged. The install check for `smoltalk-llama-cpp`
applies only to GGUF.

The downloader works like this:

1. Read the model API for the commit hash, and the tree API for the file
   list.
2. Split every file into 64MB chunks. Skip chunks that `.agency-model.json`
   says are done.
3. Run 8 workers. Each takes the next chunk, sends a `Range` request, and
   writes the bytes at the right offset in the file. When a chunk lands, it
   is recorded in `.agency-model.json`.
4. When a file's last chunk lands, hash the file. On mismatch, move it to
   `<file>.invalidSha` and fail. Small files with no hash are checked by
   size.

If you interrupt the download and run it again, only the missing chunks are
fetched. If the repo has moved to a new commit since, the download refuses:

```
<dir> holds revision 7b9321e, but mlx-community/Qwen3-Coder-Next-4bit is now
at 9c1f0a2. Remove it or pin the old revision with mlx:<repo>@7b9321e.
```

The number of workers is `client.mlx.downloadConcurrency` in `agency.json`,
default 8. The right number has not been measured.

If `HF_TOKEN` is set, it is sent as a header. It is never written anywhere.
A gated repo without it fails with:

```
This repo is gated. Set HF_TOKEN to a Hugging Face token that has accepted its terms.
```

Progress is one line when a file starts, a byte counter, and one line when a
file verifies.

**One rule bent.** Every file operation under `lib/stdlib` goes through
`contained.ts`, and a lint rule enforces it. `contained.ts` has no way to
write bytes at an offset inside an existing file. So `hubDownload.ts` uses
`fs` directly for that one operation and is added to the lint allow-list,
`FS_IMPORTERS` in `eslint.config.js`. See the decisions at the end.

### 3.5 `agency local serve`

```
agency local serve <model> [<model> ...] [--port 8080] [--max-tokens 16384] [--venv <dir>]
```

This serves the models you name, in your terminal, and nothing else. It
exists so you do not have to know five things: which Python to use, where
the weights are, the 512-token default, the port, and how to tell a model
has loaded.

Here is what you see:

```
$ agency local serve mlx:mlx-community/Qwen3-Coder-Next-4bit mlx:mlx-community/Qwen3.8-27B-4bit
Loading mlx-community/Qwen3-Coder-Next-4bit (44.9 GB)… ready in 2m 14s
Loading mlx-community/Qwen3.8-27B-4bit (15.0 GB)… ready in 48s
Serving 2 models on http://127.0.0.1:8080/v1:
  mlx-community/Qwen3-Coder-Next-4bit
  mlx-community/Qwen3.8-27B-4bit

  agency run --local mlx:mlx-community/Qwen3-Coder-Next-4bit your.agency
  agency agent --local mlx:mlx-community/Qwen3-Coder-Next-4bit
```

**How it works.** `mlx_lm.server` holds one model per process and loads any
model a request names. So `serve` does not expose it directly. It starts one
`mlx_lm.server` process per model on internal ports, and listens on port
8080 itself. Each request's `model` field picks the process to forward to.
Responses stream back unchanged. A request for a model you did not name
never reaches any process. It gets this reply:

```
HTTP 404
{ "error": { "message": "This server is serving mlx-community/Qwen3-Coder-Next-4bit and mlx-community/Qwen3.8-27B-4bit. It is not serving mlx-community/DeepSeek-V4-Flash-4bit. Start it with: agency local serve mlx:mlx-community/DeepSeek-V4-Flash-4bit" } }
```

The smoltalk provider shows that message as the error. Nothing in Agency or
smoltalk ever loads a model on its own.

To serve models on two ports, run `serve` twice in two terminals with
different `--port` values, and set `MLX_BASE_URL` for the run that should
use the second one.

**Steps, in order:**

1. Each name is resolved. A GGUF model is an error:

   ```
   "qwen3.5-2b" is a GGUF model. agency local serve is for MLX models;
   run it with agency run --local qwen3.5-2b instead.
   ```

2. The sizes are added up and compared to the machine's memory. If they do
   not fit, `serve` warns and continues:

   ```
   Warning: these models total 196.4 GB and this machine has 64 GB of memory.
   ```

3. A missing or incomplete model is downloaded first. Progress prints before
   any server starts.

4. The Python environment is found: `--venv`, then `client.mlx.venv` in
   `agency.json`, then `AGENCY_MLX_VENV`, then `~/.agency-agent/mlx-env`. If
   there is no `bin/mlx_lm.server` in it, the command prints this and exits:

   ```
   No MLX environment at /Users/me/.agency-agent/mlx-env.
   Agency does not install Python. Create the environment once:

     python3.12 -m venv /Users/me/.agency-agent/mlx-env
     /Users/me/.agency-agent/mlx-env/bin/pip install mlx-lm

   Python 3.11 or newer is required. Then run this command again.
   ```

5. One `mlx_lm.server` starts per model, one at a time, with its output in
   your terminal:

   ```
   <venv>/bin/mlx_lm.server --model <dir> --host 127.0.0.1 --port <internal> --max-tokens 16384
   ```

   The server prints nothing when a model finishes loading. So after each
   start, `serve` sends one request with `max_tokens: 1` and waits. The
   reply means the model is loaded. Then it prints `ready in 2m 14s`.

6. The front door starts on `--port` and prints the model list.

7. Ctrl-C stops everything. The command exits non-zero if any process died.

The front door and the argument builder are in `lib/cli/localServe.ts`.
`serveArgs(dir, port, opts)` is a pure function. The forwarder is a plain
`http.createServer` that reads the `model` field from the request body,
picks the matching internal port, and pipes the request and response
through.

### 3.6 Running against the server

`agency run --local <mlx model>` sets the provider to `mlx` and the model to
the string the server will report. It downloads nothing and registers
nothing. `agency agent --local <mlx model>` does the same for every model
slot. The agent's `PROVIDER_CAPABILITIES` table gets an `mlx` entry with
`memory: false` and nothing else. MLX models are large enough for the full
prompt.

The model string must match what `serve` used, or the front door refuses
the request. A test checks that `serve` and `run --local` produce the same
string for the same name.

If no server is running, the error is:

```
Could not reach the MLX server at http://127.0.0.1:8080/v1. Start one with:
  agency local serve <model>
```

If the server is running but not serving that model, the error is the front
door's message from 3.5.

### 3.7 `list`, `resolve`, `remove`

`agency local list` gains a BACKEND column. An MLX model gets its tick from a
complete `.agency-model.json`. Unclaimed directories under `mlx/` appear
under OTHER FILES.

`agency local resolve coder` prints the backend and the target:

```
mlx  mlx:mlx-community/Qwen3-Coder-Next-4bit
```

`agency local remove` accepts an MLX model's repo id or directory name and
removes the directory. It refuses a directory outside the models directory.

### 3.8 The stdlib wrapper

`stdlib/agency/local.agency` keeps every function. `downloadModel` returns a
`.gguf` path or a model directory. `listDownloadedModels` entries gain
`backend`. `registerLocalModel` returns the directory for an MLX model and
registers nothing. One new function:

```ts
// The models the server on baseUrl is serving, or null if it is not running.
export def mlxServerModels(baseUrl: string = ""): string[] | null
```

The front door answers `GET /v1/models` with the list it serves, which is
what this function reads.

### 3.9 Not in this spec

- Starting the server in the background.
- Vision models. `mlx_lm.server` cannot load them.
- MLX entries in the built-in catalog. A follow-up once download is proven.
- Changes under `docs/site`. The `local.md` page needs the new command; that
  is the owner's call.

### 3.10 Tests

No test downloads a real model or starts a real server.

Pure unit tests:

1. Each row of the naming table in 3.1 resolves to the right backend.
2. Missing, wrong, and correct `backend` values give the messages in 3.2.
3. Every built-in catalog entry has `backend`.
4. Chunk planning skips done chunks and complete files.
5. `serveArgs` builds the right argv for each flag.
6. `serve` and `run --local` produce the same model string.
7. The memory warning appears when the sizes exceed a given total, and
   not otherwise.
8. `formatLocalList` renders the BACKEND column and the MLX tick.

Against a fake Hugging Face, a local `http.createServer` that implements the
model API, the tree API, and `resolve/` with redirects and `Range`:

9. A clean download produces byte-identical files.
10. An interrupted download resumes without re-requesting done chunks. The
    fake counts requests per range.
11. A corrupted file is quarantined, and the next run re-downloads only it.
12. A `403` on a cached CDN URL causes one re-resolve.
13. A changed revision refuses with the message in 3.4.
14. A gated `401` gives the token message. With a token, the header is sent.

Against fake chat servers standing in for `mlx_lm.server`, with `spawn`
stubbed:

15. `serve` prints `ready` for each model after its fake answers the
    one-token request.
16. The front door forwards a request to the fake whose model matches, and
    streams the reply through unchanged.
17. A request for a model not on the list gets the 404 message and reaches
    no fake.
18. `mlxServerModels` returns the list the front door serves.

### 3.11 Documentation

- New dev doc `docs/dev/llm/mlx-local-models.md`, indexed in `CLAUDE.md` and
  the `agency-llm-docs` skill.
- One paragraph at the top of `docs/dev/llm/local-models.md` saying it
  covers GGUF only.
- Docstrings in `local.agency`. `make` regenerates the reference page.

### 3.12 Delivery order

Four PRs. `serve` comes before `download` because the owner's models are
already on disk.

1. The smoltalk `mlx` provider. Release 0.13.0.
2. The `backend` field, the `mlx:` prefix, directory aliases, `list` and
   `resolve` and `remove`, `run --local` and `agent --local`. After this you
   can alias a snapshot directory, start the server by hand, and run against
   it.
3. `agency local serve`.
4. The downloader.

## Decisions for the owner

1. **String-form aliases.** `"my7b": "hf:…"` has no `backend` field. Keep
   the shorthand, or retire it so every entry has the field?
2. **Offset writes.** Add `hubDownload.ts` to the `fs` allow-list, or add a
   `writeAt` primitive to `contained.ts` with its symlink tests? The
   primitive costs about a day.
3. **`serve` downloads on demand.** Download a missing model first, like
   `run --local` does, or refuse and tell you to run `download`?
4. **Built-in provider or separate package.** Raised in the smoltalk spec.
