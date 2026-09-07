# Review of MLX Plan 2: `agency local serve`

Reviewed 2026-09-07 against `main` at 97143b9de (plan 1 merged) and the
`mlx_lm.server` source on GitHub. Every name the plan consumes from plan 1
exists: `_resolveModel`, `_mlxServedName`, `mlxModelDir`, `readMlxModelRecord`,
`isMlxModelComplete`, `isModelDir`. `mlx_lm.server` accepts every flag
`serveArgs` builds, including `--log-level` and `--host`.

The plan is close. Two problems block it. One of them means the command as
planned loads the wrong model on every request.

## Blocking

### 1. The name in the request does not match the name the process was started with

`runServe` step 5 starts each process with `--model <dir>`, where `dir` is
`<modelsDir>/mlx/<org>--<repo>`. The route's model, the readiness request,
and every forwarded request use `_mlxServedName(resolved)`, which for an
`mlx:` URI is the repo id `org/repo` (`lib/stdlib/localModels.ts:562`).

`mlx_lm.server` keys its loaded model on the exact `model` string it is
asked for. From `ModelProvider.load` in `mlx_lm/server.py`:

```python
model_path = self._model_map.get(model_path, model_path)   # maps only "default_model"
model_key = (model_path, adapter_path, draft_model_path)
if self.model_key != model_key:
    self._load(*model_key)
```

The process holds key `<dir>`. A request naming `org/repo` has a different
key, so the server calls `_load("org/repo")`. With `HF_HUB_OFFLINE=1` in the
environment that either fails, or, if the repo happens to be in the user's
Hugging Face cache, loads a second 45 GB copy. Either way the first
`waitUntilLoaded` request never answers the way the plan expects. Task 6's
Studio check would catch this, but the unit tests would all pass, because the
fake servers answer any model name.

Fix. The front door already parses the body to read `model`. It should
rewrite `model` to the string the process was started with before
forwarding. `Route` becomes `{ model: string; upstreamModel: string; port: number }`,
and `waitUntilLoaded(port, upstreamModel)`. After the rewrite the body
length changes, so set `content-length` on the forwarded request from the
new buffer instead of copying it from `req.headers`. Add a test: the fake
server records the `model` field it received, and the test asserts it is the
upstream string, not the public one.

Do not use the `default_model` mapping for this. The owner rejected that for
`run --local`; here the front door is the thing that owns the public-name to
process mapping, and rewriting to the `--model` path keeps that mapping in
one place.

### 2. The Studio check points at a symlinked snapshot directory

Task 6 step 2 serves `/Volumes/.../snapshots/7b9321e...`. That is a Hugging
Face cache snapshot, whose entries are symlinks into `blobs/`. `isModelDir`
reads the directory through `list` in `contained.ts`, which drops symlinked
entries, so `_resolveModel` throws "is not a model" before `serve` starts.

Decided 2026-09-07 with the owner: follow links here, so an existing HF cache
works with no setup. The shape:

- One function in `lib/stdlib/modelBackend.ts`, `modelDirEntries(dir)`,
  built on `readdirSync` and `statSync`, which follows links and reports the
  blob's real size. It returns names and sizes only.
- `isModelDir` (`modelBackend.ts:32`) and the size sum in `_modelFilesOnDisk`
  (`localModels.ts:766`) both use it. Without the second, a snapshot alias
  reports 0 bytes, so `remove` prints "(0.0 GB)" and the memory warning in
  this plan never fires.
- `modelBackend.ts` goes on `FS_IMPORTERS` in `eslint.config.js` with the
  reason. Nothing else leaves `contained.ts`: `remove -f` still refuses to
  follow a link.
- Drop the "must hold real files" line at `docs/site/cli/local.md:64`.

This is a fix to plan 1's merged code, so it is best as its own small PR
before this one, or as a new task 1 here. Either way the Studio step can
then use the snapshot path as written. The `spikes/mlx-tool-calling/add.agency`
file the step runs is on `adit/mlx-spike` only, so the step needs a
`git checkout adit/mlx-spike --` for it too, or a two-line program written
in place.

## Should fix before executing

### 3. Internal ports are `port + 1 + index`

Two problems. First, the `runServe` test passes `{ port: 0 }`, so the
internal ports are 1 and 2. The test passes only because `spawn` and `fetch`
are faked. Second, in real use a taken port makes `mlx_lm.server` fail to
bind and exit, and the user sees "exited before it was ready" with no port in
the message.

Pick free ports instead: a small `freePort()` that listens on 0, reads the
port, and closes. It is testable and removes the `+1` rule from the docs.
If the rule stays, put the port in the exit message.

### 4. `waitUntilLoaded` retries forever and cannot be cancelled

Task 3 says it retries every 500 ms "forever". Task 4 step 5 says to throw
if the process exits first, but nothing connects the two. Race the readiness
promise against an exit promise from the child's `exit` event, and make
`waitUntilLoaded` take a signal or an abort promise so the retry loop stops.
Add the test: the fake `spawn` fires `exit` before the fake `fetch` ever
succeeds, and `runServe` rejects with the exit message.

### 5. Ctrl-C reaches the children first

The children are spawned with `stdio: "inherit"` in the same process group,
so Ctrl-C delivers SIGINT to them as well as to `serve`. Their `exit`
handlers fire, and step 7's rule "exit non-zero if any process died" turns a
clean Ctrl-C into a failure exit. Set a `stopping` flag in the SIGINT handler
and ignore child exits after it.

### 6. `_mlxServerModels` duplicates smoltalk's default base URL

Task 5 hardcodes `process.env.MLX_BASE_URL || "http://127.0.0.1:8080/v1"`.
That is a copy of `resolveBaseUrl("mlx", …)` in smoltalk's
`lib/util/provider.ts:112`, which smoltalk does not export. Either export it
from smoltalk (one line, and it is our package) or put one `MLX_DEFAULT_BASE_URL`
constant in Agency that `_mlxServerModels`, the `Serving … on` line, and the
`notServedMessage` all read. Two copies of a default port drift.

### 7. `readJson` is not exported

Task 4 step 2 reads `client.mlx.python` "through the same
`readJson(resolveAliasConfigPath())` path `defaultCacheDir` uses". `readJson`
is a module-private function (`localModels.ts:425`). Export a small
`readClientConfig()` from `localModels.ts` that returns the `client` object,
and use it for `modelsDir`, `mlx.python`, and plan 3's `downloadConcurrency`.

### 8. Small mismatches between tests and spec

- `memoryWarning` test expects `64.0 GB`; spec 3.5 step 2 shows `64 GB`.
  Pick one. One decimal everywhere is fine.
- `notServedMessage` takes a `baseUrl` argument that never appears in the
  expected string. Drop the parameter.
- `serveArgs` is typed `(modelDir, internalPort, maxTokens)` in the interface
  block, and the spec's 3.5 says `serveArgs(dir, port, opts)`. The plan's
  form is fine; update the spec line when the dev doc is written.
- Task 4 adds `client.mlx.downloadConcurrency` to the config schema. That key
  belongs to plan 3. Adding it here is harmless, but then plan 3 must not
  add it again, and plan 3 as written assumes it exists. Say which plan owns
  it.

## Altitude

I looked for existing code these tasks could reuse.

- A forwarding HTTP server: `lib/serve/http/adapter.ts` and
  `lib/serve/mcp/httpTransport.ts` are request handlers for Agency's own
  routes, not proxies. Nothing to reuse. The 60-line front door is the right
  size.
- Spawning a long-lived child and waiting on it: `lib/cli/watch.ts` and
  `lib/cli/runBundledAgent.ts` spawn children, but each has its own shape.
  No shared helper to reach for.
- Readiness by polling: nothing existing. Fine as a new function.

The plan does not duplicate anything in the repo. The one duplication is
item 6, against smoltalk.

## Things that would make a test fail

The tests in tasks 1 to 3 have teeth. Task 4's `runServe` test does not test
the thing that goes wrong in practice (item 1), because the fake `fetch`
answers everything. After the fix for item 1, the front-door test that
asserts the received `model` string is the one that would have caught it.

## Not in scope, but unowned

Spec 3.6 promises the error "Could not reach the MLX server at … Start one
with: agency local serve <model>" when nothing listens. Plan 1 did not add
it (grep finds no such string in `lib/` or in smoltalk), and neither plan 2
nor 3 does. Today a run against a dead server gets the OpenAI SDK's
`ECONNREFUSED`. Decide which PR owns that message; it fits this one.
