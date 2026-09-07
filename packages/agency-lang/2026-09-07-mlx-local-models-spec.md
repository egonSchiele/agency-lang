# MLX local models in Agency: spec

Written 2026-09-07 on branch `adit/mlx-spike`. The smoltalk half is
`/Users/adityabhargava/smoltalk/packages/smoltalk/2026-09-07-mlx-provider-spec.md`.
The spike that this builds on is `2026-09-05-mlx-tool-calling-spike-spec.md`
and its results in `spikes/mlx-tool-calling/RESULTS.md`, both next to this file.

Part 1 explains how everything works today and what was learned, so that
Part 2 can be read without the code open.

---

## Part 1: Background

### 1.1 What `agency local` is today

Agency can run a language model on the user's own machine. The whole feature
is built on one file format, GGUF, and one engine, llama.cpp, reached through
the `smoltalk-llama-cpp` package. This section walks through the pieces,
because every one of them has to learn about a second format.

**The catalog.** `CURATED_LOCAL_MODELS` in `lib/stdlib/localModels.ts` is a
table of about twenty-five models keyed by short name. Each entry looks like
this:

```ts
"qwen3.5-2b": {
  uri: "hf:unsloth/Qwen3.5-2B-GGUF:Q4_K_M",
  params: "2B",
  sizeBytes: 1280000000,
  category: "general",
  contextWindow: 131072,
  license: "apache-2.0",
  description: "Most popular modern small general model. Runs on CPU comfortably.",
  sha256: "aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223",
},
```

The `uri` is an `hf:` URI in node-llama-cpp's own format: a Hugging Face
repo, a colon, and a quantization name, meaning one specific `.gguf` file in
that repo. The `sha256` is the hash of that one file. The same table is
published as `data/model-catalog.json` so `agency local refresh` can pull new
entries without a new Agency release.

**Aliases.** Users add their own names in `agency.json` under
`client.modelAliases`. A value is either a bare URI string or an object with
the same fields as a catalog entry. `agency local refresh` writes catalog
entries into this map with `source: "remote"`. `ModelAliasSchema` in
`lib/config.ts` is a second copy of that shape, and the two have drifted
before, which `lib/config.modelAliases.test.ts` now guards.

**Name resolution.** `_resolveModelName(value)` turns whatever the user typed
into a URI or path. A `.gguf` path or an `hf:` or `https:` URI passes
through. Otherwise it is an alias, then a curated name. Anything else is an
error listing the known names.

**Where files go.** `defaultCacheDir()` picks the models directory:
`AGENCY_MODELS_DIR` in the environment, then `client.modelsDir` in the nearest
`agency.json`, then `~/.agency-agent/models`. So a configurable download
location already exists. GGUF files sit flat in that directory, with the
filename node-llama-cpp chose.

**Downloading.** `_downloadModel(value)` resolves the name, asks
`smoltalk-llama-cpp`'s `resolveModel` to download the file (node-llama-cpp
does the network work, with its own resume and progress bar), then, if the
file is new and a `sha256` is pinned, hashes it with `fileSha256` and
quarantines a mismatch to `<file>.invalidSha`. Finally `recordDownload`
writes the URI-to-filename mapping into `downloads.json` in the models
directory. That manifest is display metadata only. `agency local list` reads
it to put a tick next to downloaded models. Nothing else does.

**The install gate.** `hasLocalModelSupport()` is true when
`smoltalk-llama-cpp` resolves from Agency's own `node_modules` or from a
global npm or pnpm root. `agency local download` and `remove` refuse to run
without it. `list` and `resolve` work without it, so a user can browse
before installing.

**Running.** `agency run --local <name>` calls `resolveLocalRunFlag` in
`lib/cli/localFlag.ts`, which downloads the model if needed, absolutizes the
path, and returns `{ model: <path>, explicitProvider: "llama-cpp" }`. That
folds into the same config slot `--model provider/model` uses.
`agency agent --local <name>` does the same through `configureLocalModel` in
`lib/agents/agency-agent/shared.agency`, and pins every model slot to it.
The agent's `PROVIDER_CAPABILITIES` table in `capabilities.agency` has a
`llama-cpp` entry that switches the agent to its small prompt, turns off
summarizing and memory, and caps output at 2000 tokens, because small GGUF
models under a JSON grammar can run until the context fills.

**The stdlib wrapper.** `stdlib/agency/local.agency` exports the same
operations as Agency functions: `downloadModel`, `listDownloadedModels`,
`aliasModel`, `registerLocalModel`, and so on. Its docstrings become the
generated reference page.

**The dev doc.** `docs/dev/llm/local-models.md` records all of the above.

### 1.2 What the spike proved, and what changed after it

The models on the owner's SSD are MLX models: Hugging Face repos of
safetensors shards in Apple's quantization layout. They cannot be converted
to GGUF (see the 2026-09-05 handoff). There is no Node engine for them. They
run in a Python process, `mlx_lm.server`, which speaks the OpenAI API.

The spike showed that Agency already works against that server through
smoltalk's `openai-compat` provider, tool calls included. The results also
fixed four facts the design below depends on:

- The server prints nothing while loading a model. The "listening" line
  appears before any weight is read. The only way to know the model is loaded
  is to send a completion request and wait for it to return.
- The server's `--max-tokens` defaults to 512 and applies to every request
  that omits `max_tokens`. Agency omits it. Without a larger value every long
  reply is cut off.
- The server swaps models on request. Any request whose `model` field names
  something other than the loaded model, or the literal `default_model`,
  makes the server unload and reload. There is no lock flag.
- `ps` reports about 3GB for a server holding a 42GB model, because MLX keeps
  weights in Metal buffers. Activity Monitor shows the real figure.

Two decisions were taken after the spike, and they shape everything below.

**No daemon.** The first design had Agency start a background server and
share it between runs. The owner rejected it: two large models cannot share
memory, so any policy a daemon applied to a second model (restart, queue,
refuse) would surprise someone, and background servers are where startup
failures and logs get lost. Instead the user starts the server themselves,
in a terminal, with an Agency command that hides the details. One server,
one model, logs on screen.

**No new dependency.** Downloading MLX models is done by Agency's own code
against Hugging Face's plain HTTP endpoints. Not the `hf` command, which
needs the Python environment and cannot both resume and use the fast path.
Not the `@huggingface/hub` npm package, which the owner refused as a
dependency.

### 1.3 What Hugging Face gives a plain HTTP client

Verified on 2026-09-07 against `mlx-community/Qwen3-Coder-Next-4bit`.

**The tree API** lists every file with its size and, for large files, its
SHA-256:

```
GET https://huggingface.co/api/models/<org>/<repo>/tree/<revision>?recursive=true
```

returns entries like

```json
{ "type": "file", "path": "model-00001-of-00009.safetensors", "size": 5132893190,
  "lfs": { "oid": "fb30a2722004cb42…", "size": 5132893190 }, "xetHash": "89b936be…" }
```

The `lfs.oid` is the SHA-256 of the whole file. Small files such as
`config.json` have no `lfs` block and only a size.

**The model API** gives the commit the tree was read from:

```
GET https://huggingface.co/api/models/<org>/<repo>
→ { "sha": "7b9321eabb85ce79625cac3f61ea691e4ea984b5", "gated": false, … }
```

**The download URL** for a file is

```
https://huggingface.co/<org>/<repo>/resolve/<revision>/<path>
```

It answers with a redirect to a CDN URL that is signed and lives for hours.
That CDN honors `Range`. A request for bytes 1000 to 1999 of a 5GB shard came
back `206 Partial Content` with `content-range: bytes 1000-1999/5132893190`.
So one file can be fetched as many independent byte ranges, in parallel, and
an interrupted download can be resumed at any byte.

**The token.** `HF_TOKEN` changes rate limits, not bandwidth. Anonymous
clients get 3,000 file requests per five minutes per IP address. A model with
fifteen files is nowhere near that. Gated repos need the token to download at
all. Nothing else does.

**Speed** comes from parallel streams. Hugging Face's own fast client opens
up to 64 at once. How many the plain CDN URL sustains from the owner's
connection is not yet measured. The design below makes the number a setting.

### 1.4 Terms used below

- **Backend.** Which engine runs a model: `llama-cpp` for GGUF files, `mlx`
  for MLX repos. Every model Agency knows about has exactly one.
- **Model directory.** The folder holding one MLX model: `config.json`,
  `tokenizer.json`, the safetensors shards, and whatever else the repo has.
  It is what `mlx_lm.server --model` takes.
- **Repo id.** `org/name` on Hugging Face, such as
  `mlx-community/Qwen3-Coder-Next-4bit`.

---

## Part 2: Design

### 2.1 Naming a model: the `mlx:` scheme

Users name an MLX model with a new URI scheme, `mlx:`, alongside the existing
`hf:` scheme for GGUF:

| You type | It means | Backend |
|---|---|---|
| `hf:unsloth/Qwen3.5-2B-GGUF:Q4_K_M` | one GGUF file, as today | llama-cpp |
| `./models/x.gguf` | a GGUF file on disk, as today | llama-cpp |
| `mlx:mlx-community/Qwen3-Coder-Next-4bit` | the whole repo at its latest commit | mlx |
| `mlx:mlx-community/Qwen3-Coder-Next-4bit@7b9321e` | the repo pinned to a commit | mlx |
| `/Volumes/adit-agency-models-sept-2026/hf/hub/models--…/snapshots/7b93…` | a model directory already on disk | mlx |

A directory path is recognised as an MLX model when it exists and contains a
`config.json`. That is how the owner's 529GB of already-downloaded snapshots
become usable without moving them: one alias per model, pointing at the
snapshot directory. A path that is neither a `.gguf` file nor such a
directory is an error.

`isModelUri` gains `mlx:`. `isCatalogUri`, which validates URIs from a remote
catalog, gains it too and still refuses `http://`.

### 2.2 The `backend` field is required

Every catalog entry, in `CURATED_LOCAL_MODELS` and in `data/model-catalog.json`,
and every object-form alias in `agency.json` carries a `backend` field with
the value `"llama-cpp"` or `"mlx"`. It is required. An entry without one is
an error that names the file:

```
agency.json: alias "my-coder" has no "backend". Add "backend": "llama-cpp" or
"backend": "mlx" to the entry in /Users/me/project/agency.json.
```

For the built-in catalog the error names `lib/stdlib/localModels.ts`, and a
unit test asserts every curated entry has the field so the error can never
reach a user from there. A remote catalog entry without the field is skipped
with a warning, the same way an entry with a bad URI is skipped today.

The field must agree with the URI's scheme. `backend: "mlx"` with an `hf:`
URI is the same error, with a message saying the two disagree.

Why require it when the scheme already says? Because the scheme is a
convention inside a string and the field is a fact the reader can see and
tools can validate. The owner asked for it to be explicit and for absence to
be an error rather than a default.

The one place the field is not written is the string shorthand for an
alias, `"my7b": "hf:…"`. That form has nowhere to put it, and its scheme is
its backend. See "Decisions for the owner", item 1, if the shorthand should
go.

`ModelInfo`, `AliasObject`, `CatalogModel`, `ModelNameEntry`, the zod
`CatalogModelSchema`, and `ModelAliasSchema` in `lib/config.ts` all gain
`backend: "llama-cpp" | "mlx"`. `lib/config.modelAliases.test.ts` round-trips
it.

### 2.3 Where MLX models are stored

The models directory is the one that exists, `client.modelsDir`, with the
same precedence: `AGENCY_MODELS_DIR`, then the config key, then
`~/.agency-agent/models`. No new setting. The owner points it at the SSD:

```jsonc
// agency.json
{ "client": { "modelsDir": "/Volumes/adit-agency-models-sept-2026/agency-models" } }
```

Inside it, GGUF files stay flat as today, and MLX models get one directory
each under an `mlx` subdirectory, named after the repo with the slash
replaced by two dashes:

```
<modelsDir>/
  qwen3.5-2b-Q4_K_M.gguf                    # as today
  downloads.json                            # as today
  mlx/
    mlx-community--Qwen3-Coder-Next-4bit/
      .agency-model.json                    # revision, file list, progress
      config.json
      model-00001-of-00009.safetensors
      …
```

`.agency-model.json` is written by the downloader and read by `list`,
`serve`, and `remove`:

```json
{
  "repo": "mlx-community/Qwen3-Coder-Next-4bit",
  "revision": "7b9321eabb85ce79625cac3f61ea691e4ea984b5",
  "files": {
    "config.json": { "size": 22196, "complete": true },
    "model-00001-of-00009.safetensors": {
      "size": 5132893190,
      "sha256": "fb30a2722004cb42…",
      "complete": false,
      "chunks": [0, 1, 2, 5]
    }
  }
}
```

A model is **complete** when every file is complete. `serve` refuses an
incomplete directory and says to run `download` again. The file is rewritten
through `contained.ts`'s `writeText`, which renames a temp file over it, so
an interruption leaves the previous valid version.

An alias that points at a directory outside `modelsDir` (the owner's HF
snapshots) has no `.agency-model.json`. It counts as complete if it has a
`config.json` and at least one `.safetensors` file. `list` shows it with its
on-disk size and no revision.

### 2.4 The download command

`agency local download <value>` keeps its shape and learns the second
backend. It resolves the value, reads the backend, and dispatches:
`llama-cpp` goes to the existing node-llama-cpp path unchanged; `mlx` goes to
the new downloader. The no-argument picker lists both kinds and its custom
choice accepts an `mlx:` URI. The install gate applies only to the
`llama-cpp` branch. Downloading an MLX model needs no package and no Python.

#### The downloader

`lib/stdlib/hubDownload.ts`, a new file with one job: fetch every file of one
repo at one revision into one directory, resumably, in parallel, verified.

```ts
export type HubFile = { path: string; size: number; sha256?: string };

export type HubSnapshot = { repo: string; revision: string; files: HubFile[] };

/** Read the model API and the tree API. `revision` defaults to "main" and
 *  is returned as the commit sha it resolved to. */
export function fetchHubSnapshot(repo: string, revision?: string): Promise<HubSnapshot>;

export type DownloadProgress = (event:
  | { kind: "file-start"; path: string; size: number; resumedBytes: number }
  | { kind: "bytes"; path: string; done: number; size: number }
  | { kind: "file-done"; path: string }
  | { kind: "verify"; path: string; ok: boolean }) => void;

export type DownloadOptions = {
  concurrency: number;       // parallel range requests, default 8
  chunkBytes: number;        // default 64 MiB
  token?: string;            // HF_TOKEN, for gated repos only
  fetch?: typeof fetch;      // for tests
};

/** Download every file in `snapshot` into `dir`, resuming from
 *  .agency-model.json, and return the directory. Throws on a hash mismatch
 *  after quarantining the file. */
export function downloadHubSnapshot(
  snapshot: HubSnapshot, dir: string, onProgress: DownloadProgress, options: DownloadOptions,
): Promise<string>;
```

**Planning.** Each file is split into fixed chunks of `chunkBytes`. The plan
is a flat list of `(file, chunkIndex)` pairs across all files, minus the
chunks `.agency-model.json` already marks done. `concurrency` workers pull
from that list. Small files are one chunk. So eight workers on a nine-shard
model keep eight range requests open at all times, which is where the
speed comes from, and a shard that finishes early does not idle its workers.

**Fetching one chunk.** `GET` the resolve URL with `Range: bytes=start-end`
and, if a token was given, `Authorization: Bearer <token>`. Follow the
redirect to the CDN. The redirect target must be `https:`. Expect `206` and a
`content-range` whose total matches the file's size from the tree API; any
other status or a size disagreement fails the chunk, which is retried three
times with backoff and then fails the download. The body is written at
`start` into the target file with a positional write. When the chunk is
written, its index is added to `chunks` in `.agency-model.json`.

The CDN URL is cached per file for the life of the download so that only the
first chunk of a file pays the redirect. A `403` on a cached URL, which is
what an expired signature returns, evicts it and re-resolves once.

**Finishing a file.** When the last chunk lands, the file is hashed with the
existing `fileSha256` if the tree API gave a `sha256`, and quarantined to
`<file>.invalidSha` on mismatch exactly as `verifyModelFile` does for GGUF.
Files with no hash (the small ones) are checked by size. Then `complete` is
set and `chunks` cleared.

**Resuming.** On start the downloader reads `.agency-model.json`. If its
`revision` differs from the snapshot's, the directory is from another commit:
the download refuses with a message naming both commits and the directory,
rather than mixing files from two revisions. Otherwise complete files are
skipped, and partial files keep their done chunks. A file on disk whose size
disagrees with the record is treated as having no chunks. Nothing is ever
re-downloaded because a metadata file went missing; a missing
`.agency-model.json` with files present makes the downloader hash each
present file against the tree and mark the matches complete before it
starts. That is a slow start, minutes for 45GB, and it is printed as such.

**Progress.** One line per file when it starts, with how much was resumed,
a total-bytes counter updated at most twice a second, and one line per file
when it verifies. No progress bar library. The same style as the rest of the
CLI.

**Positional writes and `contained.ts`.** Every other file operation under
`lib/stdlib` goes through `contained.ts`, and a lint rule enforces it.
`contained.ts` has no "write these bytes at this offset" primitive, and its
`writeBytes` replaces the whole file through a temp file, which does not fit
a 5GB file assembled from 80 chunks. The downloader therefore
opens the target once with `fs` and writes chunks with `fs.write(fd, buf,
0, len, position)`. `hubDownload.ts` is added to `FS_IMPORTERS` in
`eslint.config.js` with the reason: "assembles downloaded chunks at byte
offsets into one file; the directory is the configured models dir, the
program's own spelling, and no interrupt names it." The directory itself is
still resolved with `root()` so a symlinked models dir is followed once and
the target path is checked to sit under it. See "Decisions for the owner",
item 2, for the alternative.

**What the token is and is not.** `HF_TOKEN` is read from the environment
at download time, sent as a header, and never written to any file or config.
A `401` or `403` from the model API on a repo the API reports as `gated` gets
the message: "This repo is gated. Set HF_TOKEN to a Hugging Face token that
has accepted its terms." No other path mentions the token.

**Concurrency setting.** `client.mlx.downloadConcurrency` in `agency.json`,
default 8. The right number is unmeasured; the first real download on the
Studio should try 8 and 16 on one shard and the default can move.

#### After the download

`recordDownload` in the manifest is not used for MLX models. The
`.agency-model.json` in the model directory is the record. `list` reads
those directly.

### 2.5 The serve command

```
agency local serve <model> [--port <n>] [--max-tokens <n>] [--venv <dir>]
```

runs `mlx_lm.server` in the foreground, in the user's terminal, on one model.
It exists to hide the five things the spike tripped over: which Python, where
the weights are, the 512-token default, the port, and how to tell the model
has loaded. It does not go into the background, does not write a pid file,
and dies when the terminal does.

**Steps, in order, with what the user sees.**

1. Resolve `<model>` to a backend and a target. A `llama-cpp` model is an
   error: "`qwen3.5-2b` is a GGUF model. `agency local serve` is for MLX
   models; run it with `agency run --local qwen3.5-2b` instead."
2. Find the model directory. A catalog name or `mlx:` URI maps to
   `<modelsDir>/mlx/<org>--<repo>`. If that directory is missing or
   incomplete, download it first, exactly as `agency run --local` downloads a
   GGUF before running. Progress prints here, before the server starts. A
   directory alias is used as is.
3. Find the Python environment. `--venv`, then `client.mlx.venv` in
   `agency.json`, then `AGENCY_MLX_VENV`, then `~/.agency-agent/mlx-env`. It
   must contain `bin/mlx_lm.server`. If not, print exactly this and exit 1:

   ```
   No MLX environment at /Users/me/.agency-agent/mlx-env.
   Agency does not install Python. Create the environment once:

     python3.12 -m venv /Users/me/.agency-agent/mlx-env
     /Users/me/.agency-agent/mlx-env/bin/pip install mlx-lm

   Python 3.11 or newer is required. Then run this command again.
   ```

4. Spawn `<venv>/bin/mlx_lm.server --model <dir> --host 127.0.0.1 --port
   <port> --max-tokens <n> --log-level INFO` with stdio inherited, so the
   server's own log lines appear in the terminal. `--port` defaults to 8080
   and `--max-tokens` to 16384. `HF_HUB_OFFLINE=1` is set in the child's
   environment so the server never tries to fetch anything itself.
5. Print one line: `Loading mlx-community/Qwen3-Coder-Next-4bit from <dir>
   (44.9 GB)…`. Then send one chat completion with `max_tokens: 1` to the
   server and wait for it, with no timeout. That request returns when the
   model has loaded, because the server blocks requests until then. When it
   returns, print `Ready in 2m 14s. Serving on http://127.0.0.1:8080/v1.`
   and the two ways to use it:

   ```
     agency run --local mlx-community/Qwen3-Coder-Next-4bit your.agency
     agency agent --local mlx-community/Qwen3-Coder-Next-4bit
   ```

   If the readiness request fails with a connection error the server died
   on startup; its own error is already on screen, so print `mlx_lm.server
   exited before it was ready.` and exit with its code.
6. Forward SIGINT and SIGTERM to the child and exit with its exit code.

**What serve does not do.** It does not check whether another server holds
the port; the child's own "address in use" error is clear and comes with the
port number. It does not check free memory. It does not accept a second
model.

**Where it lives.** `lib/cli/localServe.ts`, registered under the `local`
command in `scripts/agency.ts`. The argument building is a pure function,
`serveArgs(dir, opts)`, so it can be unit tested without spawning anything.

### 2.6 Running against the server

Once a server is up, three commands reach it. All go through the `mlx`
provider in smoltalk, which sends `default_model` on every request so it can
never trigger a model swap, and fails the first call with a clear message if
the server reports a different model than the one named. See the smoltalk
spec for that.

**`agency run --local <name>`.** `resolveLocalRunFlag` branches on backend.
For `mlx` it returns `{ model: <what the server will report>,
explicitProvider: "mlx" }` and does nothing else: no download, no provider
package, no registration. The model string is the directory path when the
name resolves to a directory Agency manages or an alias to one, because that
is what `serve` passed to the server and what the server echoes back. This
is the one place the two halves have to agree, and a test covers it: the
string `serve` puts in `--model` and the string `resolveLocalRunFlag`
returns for the same name are equal.

**`agency run --model mlx/<name>`.** Works already through the generic
`provider/model` flag once the provider exists. `<name>` is passed to the
provider as typed. It is the raw form for users who started the server by
hand with a repo id.

**`agency agent --local <name>`.** `configureLocalModel` branches the same
way. For `mlx` it sets every slot to `{ model, provider: "mlx", via: "local"
}` and skips `registerLocalModel`. `PROVIDER_CAPABILITIES` gains an `mlx`
entry with `memory: false` and nothing else. The `llama-cpp` profile's small
prompt, no summarizing, and 2000-token cap exist because small GGUF models
misbehave under a grammar. The MLX models in scope are 27B and up and ran
the full agent prompt in the spike, so they get the default profile.

**When the server is down.** The SDK's connection-refused error is wrapped
once, in the provider-loading path Agency already owns, with:

```
Could not reach the MLX server at http://127.0.0.1:8080/v1. Start one with:
  agency local serve <model>
```

### 2.7 list, resolve, remove

**`agency local list`** gains a BACKEND column between NAME and PARAMS. MLX
rows get their tick from `.agency-model.json` being present and complete,
and show the on-disk size of the directory. Directories under `mlx/` that no
catalog row or alias claims appear under `OTHER FILES` with their repo name
from the metadata file. The "Models directory" line is unchanged.

**`agency local resolve <value>`** prints the backend and the target on one
line: `mlx  mlx:mlx-community/Qwen3-Coder-Next-4bit` or
`llama-cpp  hf:unsloth/Qwen3.5-2B-GGUF:Q4_K_M`.

**`agency local remove <name>`** accepts an MLX model's repo id or its
directory name and removes the whole directory. It refuses a directory
outside `modelsDir` (an alias to the owner's HF snapshots) with: "That model
is not in the models directory; remove it yourself." Removal goes through
`contained.ts`'s `remove` with `modelsDir` as root, which refuses symlinks.

### 2.8 The stdlib wrapper

`stdlib/agency/local.agency` keeps every function and its docstring gains one
sentence where the behaviour now depends on backend. `downloadModel` returns
a `.gguf` path or a model directory. `listDownloadedModels` entries gain a
`backend` field. `registerLocalModel` for an MLX model returns the directory
and registers nothing, with a docstring line saying the model must be served
with `agency local serve`. One new function, `mlxServerModel(baseUrl: string
= "")`, sends the one-token request and returns the model the server reports
or `null`, so an Agency program can check before it starts work. It raises no
interrupt: it is a read of a local port the user started.

### 2.9 What is not in this spec

- No daemon, pid file, or auto-start. See 1.2.
- No vision models. `mlx_lm.server` cannot load them; `mlx-openai-server` can,
  and adding a second server flavour is a later decision.
- No MLX entries in the curated catalog yet. The owner's five models are
  candidates; three are permissively licensed. Adding them is a small
  follow-up once the download path is proven on them.
- No changes to `docs/site`. The CLI reference page `docs/site/cli/local.md`
  is hand-written and will need the new command and flags; that is the
  owner's call per the repo's convention.
- No measurement of chunk concurrency. Default 8, setting exposed.

### 2.10 Errors, collected

Every message a user can hit, so the wording is reviewed once:

| Situation | Message |
|---|---|
| Alias object with no backend | `agency.json: alias "X" has no "backend". Add "backend": "llama-cpp" or "backend": "mlx" to the entry in <path>.` |
| Backend disagrees with URI | `agency.json: alias "X" says backend "mlx" but its uri "hf:…" is a GGUF file. Change one of them in <path>.` |
| Path is neither `.gguf` nor a model dir | `"<path>" is not a model: expected a .gguf file or a directory containing config.json.` |
| serve on a GGUF model | `"X" is a GGUF model. agency local serve is for MLX models; run it with agency run --local X instead.` |
| No Python env | the block in 2.5 step 3 |
| Server died before ready | `mlx_lm.server exited before it was ready.` |
| Incomplete directory at serve time | `<dir> is incomplete (3 of 15 files). Run: agency local download mlx:<repo>` |
| Directory from another revision | `<dir> holds revision <a>, but <repo> is now at <b>. Remove it or pin the old revision with mlx:<repo>@<a>.` |
| Hash mismatch | same shape as the GGUF message, naming the quarantined file |
| Gated repo without token | `This repo is gated. Set HF_TOKEN to a Hugging Face token that has accepted its terms.` |
| Server unreachable at run time | the block in 2.6 |
| Server serving another model | from the smoltalk provider, see its spec |

### 2.11 Tests

No test downloads a real model or starts a real server. Every network
interaction is against a local `http.createServer` in the test.

**Unit, pure.**
- URI classification: each row of the table in 2.1 resolves to the right
  backend and target; the error rows produce the messages in 2.10.
- `backend` validation: missing, disagreeing, and correct entries for
  curated, remote catalog, and alias forms. A test that walks
  `CURATED_LOCAL_MODELS` and asserts every entry has `backend`.
- Chunk planning: a three-file snapshot with one complete file and one
  half-done file yields exactly the expected `(file, chunk)` list.
- `serveArgs`: the argv for a directory and each flag.
- The `serve`/`resolveLocalRunFlag` agreement test from 2.6.
- `formatLocalList` with a mixed catalog: the BACKEND column, the MLX tick,
  and an unclaimed `mlx/` directory under OTHER FILES.

**Against a fake Hub.** A test server that implements the model API, the
tree API, and `resolve/` with a redirect to itself and `Range` support, over
a temp directory of generated files.
- A clean download produces byte-identical files and a complete
  `.agency-model.json`.
- Killing the download (abort the fetch) after some chunks, then rerunning,
  finishes without re-requesting the done chunks. The fake server counts
  requests per range.
- A corrupted shard fails verification, is quarantined, and the next run
  re-downloads only that shard.
- A `403` on a cached CDN URL triggers one re-resolve and then succeeds.
- A revision change refuses with the message in 2.10.
- A gated `401` produces the token message; with a token the header is sent.
- A missing metadata file with correct files on disk is recovered by hashing.

**Against a fake server.** A test `http.createServer` that speaks
chat-completions.
- `agency local serve` (run via `serveArgs` and a stubbed spawn) prints the
  Ready line after the fake answers the readiness request, and the exit
  code follows the child.
- `mlxServerModel` returns the fake's model name.

**Integration, gated on `AGENCY_LLM_INTEGRATION=1`, Apple Silicon only.**
Not added in this arc. The existing suite downloads a 100MB GGUF; the
smallest useful MLX model is 15GB and CI has no Metal GPU. The owner's
Studio is the integration test for now, and `RESULTS.md` is where it is
recorded.

### 2.12 Documentation

- New dev doc `docs/dev/llm/mlx-local-models.md`, the counterpart of
  `local-models.md`: the two backends, the `mlx:` scheme, the storage
  layout, the downloader's resume and verify rules, the serve command's
  readiness trick, the `default_model` rule, and the four server facts from
  1.2. Indexed in `CLAUDE.md` and the `agency-llm-docs` skill.
- `docs/dev/llm/local-models.md` gets one paragraph at the top saying it
  covers the `llama-cpp` backend and pointing at the new doc.
- Docstrings in `stdlib/agency/local.agency` as in 2.8; `make` regenerates
  the reference page.

### 2.13 Delivery order

Four PRs, each usable on its own. The owner's models are already on disk, so
serve comes before download.

1. **smoltalk `mlx` provider** (smoltalk repo, its own spec). Release 0.13.0.
2. **Backend and naming.** The `backend` field everywhere, the `mlx:` scheme,
   directory aliases, `list`/`resolve`/`remove` changes, `run --local` and
   `agent --local` branching, the `mlx` capabilities entry, smoltalk bumped
   to `^0.13.0`. After this PR the owner can alias a snapshot directory,
   start `mlx_lm.server` by hand, and run `agency agent --local` against it.
3. **`agency local serve`.** After this PR the by-hand step is gone.
4. **The downloader** and `download` for MLX. After this PR a new machine
   needs only `agency local download mlx:<repo>` and `agency local serve`.
   This is the largest PR and the only one with a network component.

Each PR carries its share of 2.11 and 2.12.

---

## Decisions for the owner

1. **String-form aliases.** `"my7b": "hf:…"` has no `backend` field. This
   spec keeps the shorthand and reads the backend from the scheme. The strict
   reading of "every entry requires a backend" would retire the shorthand
   and make `agency local alias add` write the object form. Which?
2. **Positional writes.** This spec adds `hubDownload.ts` to the `fs`
   allow-list. The alternative is a new primitive in `contained.ts`,
   `writeAt(root, target, offset, bytes)`, which would need an entry in the
   symlink battery and its six refusal cases. That keeps the fence intact at
   the cost of a day. Which?
3. **serve downloads on demand.** This spec has `serve` download a missing
   model first, matching `run --local`. The alternative is to refuse and tell
   the user to run `download`. On-demand means one command from nothing to a
   running server; refuse means a 45GB download never starts by surprise.
4. **Built-in provider or `smoltalk-mlx` package.** Raised in the smoltalk
   spec. It changes PR 2's install gate and nothing else on this side.
