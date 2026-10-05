# Review of the local models from TypeScript plan

Plan reviewed: `docs/superpowers/plans/2026-10-05-local-models-from-typescript.md`

## Verdict

The plan is sound and I would build it, after fixing four things that
would break something as written. The split into five PRs is right, each
PR is based on main, and the eight facts under "What the code looks like
today" all still hold.

The four things to fix before starting:

1. The standard-input watcher in Task 17 stops or kills a server that a
   person starts by hand outside a plain foreground terminal.
2. The pool in Task 6 cannot stop a model while it is loading.
3. `cancel` in Task 14 crashes the front door with the code as it is
   today.
4. `agency local serve --lazy x` in Task 12 opens the model picker.

The rest are gaps: places where the plan leaves a decision to whoever
implements it, and the decision is easy to get wrong.

## What I read

- The plan and its spec.
- `lib/stdlib/mlxImage.ts`, `vision.ts`, `localImageInputs.ts`,
  `image.ts`, `approvedPath.ts`, `mlxServerModels.ts`, and the model
  resolving code in `localModels.ts`.
- `lib/cli/mlxServer.ts`, `localServerCommon.py`, and the serving half of
  `localServe.ts` (`groupServeArgv`, `planModel`, `runServe`,
  `localServe`).
- How the tests start the Python scripts, the `makefile` copy lines, and
  the CI workflow that runs Python tests.
- `src/backend/lib/agency/memory.ts` in Mark Cut Paste, to compare its
  memory formula with Task 10.

I ran no servers and no tests.

## 1. The standard-input watcher exits or freezes servers started by hand (Task 17)

The plan says a server started by hand has a terminal for standard input,
so the read blocks. That is true only for a foreground job in a terminal.
Two ordinary cases behave differently.

```
python visionServer.py --model ... &          # background job
nohup python visionServer.py --model ... &    # or stdin from /dev/null
```

- In the first, a background process that reads the terminal is sent
  SIGTTIN, and the whole server stops until it is brought to the
  foreground.
- In the second, the read returns end-of-file at once, and the server
  calls `os._exit(0)` before it has loaded anything. The same happens
  under launchd, in Docker without `-i`, and in any test that starts a
  script with `stdio: "pipe"` and no input.

Make the watcher something the parent asks for. `realSpawn` sets
`AGENCY_EXIT_WITH_PARENT=1` in the child's environment, and
`exit_when_parent_goes()` does nothing without it. A script run by hand
then behaves as it does today.

Three smaller points on the same task:

- `mlxChatServer.py` and `mlxEmbedServer.py` do not import
  `localServerCommon` today, and neither has the `sys.path.insert` line
  the other three scripts use. The plan says "check each imports". Say
  instead that these two need both lines added.
- The spec's test 7 starts the real image server script, closes its
  standard input, and checks that it exits. The plan replaces this with a
  unit test of the function. Keep the spec's test: it is the one that
  proves the call sits before the model load, which is when an orphan
  costs the most.
- Only `test_mlxChatServer.py` runs in CI, from
  `.github/workflows/mlx-server-tests.yml`, and that workflow has a path
  filter. A new Python test file runs nowhere until it is added there.
  Writing the test in TypeScript, the way `visionServer.test.ts` starts
  `python3`, avoids the workflow change.

## 2. The pool cannot stop a model that is loading (Task 6)

`start` is described as "pick a free port, spawn, and `waitUntilLoaded`",
and it returns `{ child, port }` when the model is ready. Until then the
pool holds no child for the record. So during a load:

- `unload`, `stopAll`, and `close` have nothing to kill.
- The pool cannot see the child exit, so it cannot mark the record
  `failed`.

Today this does not matter, because every load finishes before `runServe`
returns a handle. From PR 3 it does: a lazy load runs for minutes while
the server is live. Pressing Ctrl-C, or calling `server.close()`, during
that load would leave the Python process loading a 20 GB model with
nobody holding it.

Split `start` in two. The first half spawns and returns the child and
port at once, and the pool stores them on the record. The second half is
the wait. Then add a test: `unload` during a load kills the child, and
the request waiting on that load gets an error.

Related: the plan queues loads but not unloads. `unload("a")` while `a`
is loading, and `cancel`'s unload-then-load, both change a record the
queue is working on. Put every change of state through the one queue.
`makeRoom` runs inside a queued load, so it needs an inner stop function
that does not join the queue, or it waits for itself.

## 3. `cancel` crashes the front door (Task 14)

Step 3 says: if the reply has not started, write a 499, then destroy
`upstream`. Destroying a request that has no reply yet makes Node emit
`error` on it. The handler in `forward` then runs:

```ts
upstream.on("error", (err) => {
  const message = `${route.label}: ${err.message}`;
  error(res, 502, message);   // writeHead after the 499 was sent
  ...
```

`writeHead` throws when headers were already sent, and the throw is
inside an event handler, so the server process dies. This does not happen
today when a client leaves, because nothing has been written to `res`.

The plan should say that a cancelled request is marked first, and the
error handler does nothing for a marked request. The log line for it
should show 499, not 502. Add to test 1: the server answers another
request after the cancel.

Two more cases `cancel` needs an answer for:

- **A request waiting for a lazy load.** It has no `upstream` yet, so it
  is not in the `InProgress` list as typed. The caller sees it as work on
  that model. I would answer it with the 499 and let the load finish.
- **The spec's unload path is not reachable from `serve()`.** See
  finding 6.

## 4. `--lazy x` alone opens the picker (Task 12)

`localServe` decides whether to show the picker like this:

```ts
const wantsPicker =
  values.length === 0 && NAMING_FLAGS.every((flag) => (flags[flag.key] ?? []).length === 0);
```

The plan keeps `--lazy` out of `NAMING_FLAGS` and treats it like one only
inside `groupServeArgv`. So this command names no model as far as the
check can tell, and the picker opens:

```
agency local serve --lazy z-image-turbo --lazy flux2-klein-9b
```

That is the exact command in the "Checks against real models" section.
Add the lazy list to the check, and a test for it.

Step 4 also needs one word made exact. "Unless a kind flag also names it"
should compare the planned names, not the text typed. Otherwise
`--vlm qwen3.5-9b --lazy mlx:mlx-community/Qwen3.5-9B-4bit` is planned
twice and fails as "named twice", though it is the pairing the spec
allows.

## 5. Who owns the request counter, and the gap before it rises (Tasks 7 and 11)

Task 6 says the pool is the only code that starts or stops a model. Task
7 then has `forward`, in the front door, write `requestsInProgress` and
`lastUsedAt` on the pool's record. Eviction reads those two fields, so
two modules share the state the eviction rule depends on.

There is also a gap. The door awaits `pool.ready(model)` and only then
calls `forward`, which raises the counter. Between the two, the record is
`ready` with a count of 0. If a load for another model is next in the
queue, `makeRoom` can pick this record and stop it, and the request is
forwarded to a dead port. Whether that happens depends on the order two
promises resolve in.

A freshly loaded model also has `lastUsedAt: null`. The plan does not say
whether null sorts as oldest or newest. As oldest, a model warmed with
`server.load()` is the first one stopped.

One change fixes all three. Replace `ready` with a call that hands back
the record with the count already raised, and a function to lower it:

```ts
const held = await pool.acquire(model);   // loads if needed, count is now +1
try { ... forward to held.port ... } finally { held.release(); }
```

The pool sets `lastUsedAt` in `acquire`, in `release`, and when a load
finishes. The door never writes to a record. The existing `finish`
callback in `forward` is already called once per request on every ending,
so `release` belongs next to it.

## 6. `serve()` cannot say what kind a model is (Task 8)

`serve` turns each `ServedModel` into a plain value for `runServe`, which
plans it with `planModel` and no flag. Two things follow.

- A vision-language model cannot be served. `planModel` always gives a
  chat model the `mlx-lm` runtime; only `--vlm` gives `mlx-vlm`. The spec
  says such a model "served this way answers the OpenAI chat API", and
  the whole unload path of `cancel` exists for it.
- A model whose files do not say its kind cannot be served either. The
  CLI's answer is `--embedding`, `--speech`, or `--image`.

This is a gap in the spec that the plan inherits. Either add
`kind?: ModelKind` and `vlm?: boolean` to the public `ServedModel`, or
say in the spec that both cases are CLI-only for now. I would add the
fields, since `serve` already maps objects onto flags.

Also, `lib/cli/localServe.ts` already exports types named `ServedModel`
(a banner entry) and `ServeOptions` (reply limits). The public types have
the same two names and different shapes, and `lib/local/serve.ts` imports
from that file. Rename the existing ones in PR 2, for example to
`BannerModel` and `ChatServeOptions`.

## 7. A lazy load uses up the caller's timeout (Tasks 7 and 11)

The first request for a lazy model waits for the load inside the request.
The callers' timeouts were set for generation alone:

- `localImageTimeoutMs` gives an 8-step, 1024x1024 request about 168
  seconds. A cold load of a large image model from the external volume
  can take a good part of that.
- A vision request gets 5 minutes, which is probably enough.

When the caller's timeout fires during a load, the caller sees a timeout
and the plan does not say what the door does. It should check that the
client is still connected after the load, and not forward if it has gone.
Otherwise the model generates an image nobody is waiting for, which is
the problem `cancel` exists to solve.

For the timeout itself, the cheapest fix is a line in the guide: call
`server.load(model)` before the first request when the caller has a
deadline. If that is not enough after the real-model check, add a load
allowance to the two timeouts.

## 8. A stopped model that is not lazy (Tasks 6 and 7)

`unload` on a model that is not lazy leaves it `stopped` until `load`.
Task 6 says `ready` rejects for that state. Task 7 does not say what the
client receives. Give it a status and a message, for example a 503 with
`florence-2 is not loaded. Load it with POST ... or server.load("florence-2").`
Note there is no HTTP route for `load` or `unload` in the spec, so over
HTTP a stopped model that is not lazy can only be brought back by
restarting the server. If that is intended, the message should say so.

Keep the 250 ms wait before a child's exit counts as a failure. A
terminal Ctrl-C reaches the children before Node, and the test "does not
report a child that exits just before close(), as on Ctrl-C" depends on
it. The plan's sentence "a child the pool stopped does neither" does not
cover that case, because the pool did not stop that child.

## 9. PR 1: decisions the plan leaves open

Each of these is small. Together they decide whether "the same request
its stdlib twin sends" is true.

1. **What `localImageMode` returns.** The plan gives its arguments and no
   return type. `generateImage` needs three things from it: which fields
   are in play, the mode's settings, and how many images the model reads
   at every step. The last one feeds `localImageTimeoutMs`. Today
   `referenceCount` takes a `LocalImageInputs` with `files`, which a call
   with bytes does not have.
2. **One function builds the body.** `mlxImage` builds the body from an
   `ImageConfig`. Step 4 of `generateImage` builds it again from options.
   The twin test would catch a difference, but one `localImageBody`
   function called from both places cannot have one. Mind `size`: the
   stdlib sends `""` when no size is given, and `megapixelsOf` treats
   `""` and `undefined` differently.
3. **Messages name the wrong function.** `CALLER` in
   `localImageInputs.ts` is `"generateImageLocal"`, and `refusal` starts
   every message with it. The public function is `generateImage`. Pass
   the caller's name in, or accept the old name and say so.
4. **The vision "twin" of `encodedImageInput`.** Make it one function
   that takes the byte cap. It cannot live in `localImageInputs.ts` and
   be imported by `vision.ts`: `localImageInputs.ts` imports
   `MAX_IMAGE_BYTES` from `vision.ts`, and a comment in `vision.ts`
   records that this already blocked one import. Put it in its own file.
   It should also keep the `isRemoteSource` refusal, since a string input
   could be a URL.
5. **Order of checks in `visionRequest`.** Today the model is checked
   before the file is read. With `checkVisionModel` moved into
   `postVisionRequest`, the stdlib path reads up to 50 MB and then learns
   the model is not a vision model. Have the callers run
   `checkVisionModel` first and pass the served name in.
6. **The "no server" message for images.** Task 2 keeps it for vision.
   For images it lives in `_generateImageLocal`, after smoltalk, so
   `postLocalImage` will not have it unless the plan moves it.
7. **An abort while the body is being read.** In `mlxImage` the `catch`
   wraps `fetch` only. An abort during `res.json()` falls into "answered
   200 with a body that is not JSON". `postLocalImage` should check
   `options.signal?.aborted` in both places. Test an abort before the
   call starts too.
8. **Which `Result`.** `mlxImage.ts` uses smoltalk's `success` and
   `failure`. `vision.ts` uses the runtime's, which is untyped
   (`ResultValue`). The spec's public signatures say `Result<T>`. Define
   one plain type in `lib/local`, export it, and convert at the edge.
9. **`tagImage` has no `limit`, and the defaults live in Agency source.**
   The stdlib `tagImage` sends `threshold` (default 0.35) and `limit`
   (default 30). Both defaults are in `stdlib/vision.agency`, not in
   TypeScript. The spec's public `tagImage` has no `limit` at all. The
   twin test in Task 4 passes explicit values to `_tagImage`, so it
   cannot see a default that differs. List each public function's
   defaults in the plan, taken from the five `.agency` signatures.
10. **`listModels` names that `serve` refuses.** The spec says `name` is
    what `serve` accepts. `_listDownloadedModels` also returns GGUF
    files, ControlNets, and incomplete downloads. `_resolveModel` reads a
    GGUF file name as a path relative to the working directory, refuses
    to serve a ControlNet, and skips an incomplete repo. Add a test that
    every listed, complete, served model resolves by its `name`, and say
    in the doc comment which entries are listed but not servable.

`checkLocalImageArgs` and `localImageSettings` are in `image.ts`, which
imports smoltalk and the runtime's metering. Exporting them from there
makes `agency-lang/local` load all of that. Moving the two functions to
`mlxImage.ts` keeps the public entry light.

## 10. Docs and checks

- The spec lists `docs/dev/llm/local-images.md` and `local-vision.md`
  among the docs to update. No task touches them, and Tasks 1 to 3 split
  the functions those two docs describe.
- The check after PR 1 serves one model and then calls two:

  ```
  agency local serve --image z-image-turbo
  node scripts/checks/local-api-generate.mjs    # calls generateImage and tagImage
  ```

  Serve `wd14-tagger` as well, or the `tagImage` half fails.
- Task 8 pipes the children's output to `log`. Python buffers its output
  in blocks when it is not writing to a terminal, so lines would arrive
  late and in bursts. Set `PYTHONUNBUFFERED=1` in the piped spawn. Split
  on `\r` as well as `\n`, because model loading prints progress bars.
- Add `mlxVlmServer.py` to the "ship next to localServe and are valid
  Python 3" test list.
- Task 16 step 5 says what the shutdown route does for the CLI. Say what
  it does under `serve()`: I assume it runs `close()` and leaves the host
  program running.

## 11. Two suggestions

**Ship Task 17 earlier.** Processes that exit with the server fix a
problem that exists today, need nothing from PRs 2 to 4, and remove the
cleanup code Mark Cut Paste carries. It also covers the case in finding 2
for a server that is killed outright. I would make it PR 2, or fold it
into PR 1.

**Check the `Host` header on the admin routes.** Requiring
`content-type: application/json` stops a plain cross-site form post. It
does not stop a page that reaches `127.0.0.1` under its own hostname,
since the browser then treats the request as same-origin. Refusing any
request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>`
closes that, in a few lines. The generating routes have the same
exposure today, but `shutdown` and `cancel` are the first routes that
destroy work. This is a change to the spec.

## What I checked and found right

- The memory formula in Task 10 (free, inactive, and speculative pages on
  macOS, `MemAvailable` on Linux, `os.freemem()` as the fallback) is the
  one Mark Cut Paste already runs, with tests. Copy its parser and its
  saved `vm_stat` sample.
- `mlxBaseUrl`, `_resolveModel`, `checkedImageFile`, and
  `approvedFileBytes` need no run, so the public functions can call them
  from a plain TypeScript program.
- None of the Python server scripts reads standard input or starts a
  subprocess, so the watcher thread and `os._exit` do not conflict with
  anything in them.
- The CLI's default port is set in `scripts/agency.ts`
  (`parsePositiveInt, 8080`), so removing `?? 8080` inside `runServe`
  does not change the command.
- Every planned model, lazy or not, goes through `planModel` and
  `checkPython` at startup, so a missing model or Python module is still
  reported before the port opens.
