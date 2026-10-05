# Local models from TypeScript: implementation plan

**Spec:** `docs/superpowers/specs/2026-10-05-local-models-from-typescript.md`.
Read it first. Then read `docs/dev/llm/mlx-local-models.md`,
`docs/dev/llm/local-images.md`, `docs/dev/llm/local-vision.md`,
`docs/dev/contributing/coding-standards.md`, and
`docs/dev/contributing/anti-patterns.md`.

**Review:** `docs/superpowers/plans/2026-10-05-local-models-from-typescript-review.md`.
This plan has been revised to answer it. Where the plan now departs from
the spec, see "Departures from the spec" at the end.

**Branches:** six PRs, each based on main. Start a PR after the one
before it has merged. All paths are relative to `packages/agency-lang`.

| PR | What it ships | Tasks |
|---|---|---|
| 1 | `agency-lang/local`: `listModels`, the call functions, signals (built) | 1 to 6 |
| 2 | Model processes that exit when the server dies | 7 to 8 |
| 3 | One description per served model, the model pool, `serve`, `status`, `load`, `unload` | 9 to 13 |
| 4 | `--lazy`: on-demand loading and eviction | 14 to 17 |
| 5 | `cancel` | 18 to 19 |
| 6 | Shutting down | 20 to 21 |

Every PR ends with the steps under "Finishing a PR".

**Goal:** this program runs with no `.agency` file, no interrupt, and one
server address:

```ts
import { listModels, serve, generateImage, tagImage } from "agency-lang/local";

const server = await serve(
  [
    { model: "z-image-turbo", lazy: true },
    { model: "wd14-tagger", lazy: true },
  ],
  { port: 0 },
);
const generated = await generateImage({
  baseUrl: server.url,
  model: "z-image-turbo",
  prompt: "a lighthouse in a storm",
});
if (generated.success) {
  const tags = await tagImage({
    baseUrl: server.url,
    model: "wd14-tagger",
    image: generated.value.bytes,
  });
}
await server.close();
```

## What the code looks like today

These facts shape the tasks. Check each one still holds before starting.

1. **A local image request goes through smoltalk.**
   `_generateImageLocal` in `lib/stdlib/image.ts` builds an `ImageConfig`
   and calls `generateOne`, which needs a run. smoltalk then calls
   `mlxImage` in `lib/stdlib/mlxImage.ts`, which builds the body and
   posts it. The public function must skip smoltalk, because a plain
   TypeScript caller has no run.
2. **A vision request does not.** `visionRequest` in
   `lib/stdlib/vision.ts` resolves the model, reads the approved file,
   and posts the body in one function.
3. **Both read the server address inside the request.** Each calls
   `mlxBaseUrl()` with no argument. `mlxBaseUrl(explicit)` already
   accepts an address.
4. **The two post the same way, in two copies.** Each has its own
   `fetch`, its own "body that is not JSON" message, and its own reading
   of `error.message`. Only the word "image" or "vision" differs.
5. **Input image checks are tied to paths.** `_localImageInputs` in
   `lib/stdlib/localImageInputs.ts` checks which inputs go together and
   checks each file, in one pass. Its messages start with
   `generateImageLocal failed:`, from the constant `CALLER`.
6. **`localImageInputs.ts` imports from `vision.ts`.** It takes
   `MAX_IMAGE_BYTES` from there, so `vision.ts` cannot import anything
   from `localImageInputs.ts`.
7. **`runServe` already returns a handle.** `ServeHandle` in
   `lib/cli/localServe.ts` has `port`, `models`, `failure`, and `close`.
   `runServe` takes its dependencies as `ServeDeps`, and
   `lib/cli/localServe.test.ts` drives it with fake processes.
8. **The front door holds a fixed list.** `startFrontDoor` in
   `lib/cli/mlxServer.ts` takes `Route[]`, built once after every model
   has loaded.
9. **Model processes inherit the terminal.** `realSpawn` uses
   `stdio: "inherit"`. `close` calls `child.kill()` and does not wait.
10. **The command line already has one description per model.**
    `groupServeArgv` returns `ServeTarget[]`, where a `ServeTarget` is
    `{ model } & ModelOptions`. `localServe` then flattens it into
    `flags.options`, keyed by the name as typed, and `runServe` looks
    each model up again.
11. **Three tables describe the kinds and runtimes.** `NAMING_FLAGS` has
    one row per flag that names a model. `CHAT_RUNTIMES` has one row per
    chat runtime. `BANNER_SUFFIX` and `FLAG_FOR_KIND` have one entry per
    kind. `localServe` shows the model picker when no value and no
    `NAMING_FLAGS` flag was given.
12. **Two exported types already use the public names.**
    `lib/cli/localServe.ts` exports `ServedModel` (a banner entry) and
    `ServeOptions` (reply limits).

## Rules for the whole plan

These come from `docs/dev/contributing/anti-patterns.md`. They apply to
every task.

1. **Add a row, not a branch.** When a behavior differs by flag, by
   kind, or by runtime, it goes in the table that already has a row for
   it. No function in this plan tests `runtime === "mlx-vlm"` or
   `kind === "image"`.
2. **A decision is a pure function.** Which model to stop, whether a
   load fits, and which mode a call is in are functions from data to
   data, tested without a process or a server. The code that acts on the
   answer is separate.
3. **A model's state is one value.** A record never holds a `state`
   field next to a `child` that may be null. Each state is its own shape
   with the fields that state has.
4. **Name every number.** Memory sizes, the grace period, and each HTTP
   status the door writes for its own reasons are named constants.
5. **A `catch` logs.** A fallback that hides an error prints the error
   first.

## PR 1: the public entry

### Task 1: one function that posts to the local server

**Files:** create `lib/stdlib/localRequest.ts` and its test. Modify
`lib/stdlib/mlxImage.ts`, `lib/stdlib/vision.ts`, `lib/stdlib/image.ts`.

```ts
export type LocalRequestOptions = { baseUrl?: string; signal?: AbortSignal };

export type LocalReply = { reply: Record<string, unknown> } | { error: string };

/** `serverNoun` is "image" or "vision", for the messages. */
export async function postLocalJson(
  route: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  serverNoun: string,
  options: LocalRequestOptions = {},
): Promise<LocalReply>

export const CANCELLED = "Cancelled";

/** The message for a server that is not running, or `error` unchanged. */
export function explainNoServer(error: string, baseUrl: string, serveCommand: string): string
```

`postLocalJson` posts `body` to `${mlxBaseUrl(options.baseUrl)}${route}`
and returns the parsed reply. It holds the one copy of what `mlxImage`
and `visionRequest` each do today:

- The signal is `AbortSignal.timeout(timeoutMs)`, combined with
  `options.signal` through `AbortSignal.any` when one is given.
- A failed `fetch` returns its message with the cause code, as today.
- A body that is not JSON returns
  `The ${serverNoun} server answered ${status} with a body that is not JSON.`
- A reply that is not `ok` returns `error.message`, or
  `The ${serverNoun} server answered ${status}.`

A caller that aborts gets `{ error: CANCELLED }`. Check
`options.signal?.aborted` in both `catch` blocks: the one around `fetch`
and the one around `res.json()`. An abort can land in either, and without
the second check an abort during the body reads as "not JSON". A timeout
keeps the message it has today.

`explainNoServer` returns
`no local model server answered at ${baseUrl}. Start one with:\n  ${serveCommand}`
when `isNoServerError(error)`, and `error` otherwise. Use it in
`_generateImageLocal` and in Task 3, in place of the two copies of that
message.

**Tests:**

1. A `baseUrl` is honored.
2. A signal aborted before the call returns `Cancelled` and sends
   nothing.
3. Aborting while the fake server holds the request returns `Cancelled`.
4. Aborting after the fake server sent its headers and half its body
   returns `Cancelled`.
5. A timeout returns the timeout message, not `Cancelled`.

### Task 2: the image request

**Files:** `lib/stdlib/mlxImage.ts`, `lib/stdlib/mlxImage.test.ts`,
`lib/stdlib/image.ts`.

1. Add the one function that builds a request body:

   ```ts
   export type LocalImageRequest = {
     model: string;
     prompt: string;
     size: string | undefined;
     format: string | undefined;
     settings: Record<string, unknown>;
   };

   export function localImageBody(request: LocalImageRequest): Record<string, unknown>
   ```

   It is the first half of `mlxImage` today: `model`, `prompt`, `n: 1`,
   `response_format: "b64_json"`, `size` and `output_format` when
   defined, and each key of `SETTINGS` found in `settings`. `mlxImage`
   calls it with `config.metadata` as the settings.

2. Add the function that posts a body and reads the image back:

   ```ts
   export async function postLocalImage(
     body: Record<string, unknown>,
     timeoutMs: number,
     options: LocalRequestOptions = {},
   ): Promise<{ images: LocalGeneratedImage[] } | { error: string }>
   ```

   It calls `postLocalJson` and returns the reply's images, each with
   its seed. Every body asks for one image, so the list has one.
   `mlxImage` calls it, then wraps the list in smoltalk's `success` or
   `failure` with an `ImageGenResult`. `generateImage` takes the first.

3. Move `checkLocalImageArgs` and `localImageSettings` from `image.ts`
   to `mlxImage.ts`, and export them. `image.ts` imports the runtime's
   metering and statelog; the public entry should not load them.

**Tests:**

1. The existing `mlxImage` and `_generateImageLocal` tests pass
   unchanged.
2. `postLocalImage` with a `baseUrl` posts to that address.

### Task 3: the vision request

**Files:** `lib/stdlib/vision.ts`, `lib/stdlib/vision.test.ts`.

Split `visionRequest` in two. Export `checkVisionModel` and the
`VisionTask` type.

```ts
export async function postVisionRequest(
  task: VisionTask,
  model: string,
  servedName: string,
  imageBase64: string,
  fields: Record<string, unknown>,
  options: LocalRequestOptions = {},
): Promise<LocalReply>
```

`postVisionRequest` calls `postLocalJson` and passes any error through
`explainNoServer` with `agency local serve ${model}`.

`visionRequest` keeps today's order: `checkVisionModel` first, then
`approvedBase64`, then `postVisionRequest`. The model is checked before
a file of up to 50 MB is read.

Move the reply shaping out of `visionCall` into
`visionAnswer(task, reply)`, so the public functions number their items
the same way.

**Tests:** the existing tests pass unchanged, and a `baseUrl` is
honored.

### Task 4: input images as bytes

**Files:** `lib/stdlib/localImageInputs.ts`,
`lib/stdlib/localImageInputs.test.ts`.

The public `generateImage` takes each input image as a path or as bytes.
The pairing rules must be the same as the stdlib's, with the same
messages.

1. Split the checks that need no file out of `_localImageInputs`:

   ```ts
   /** How many images a call gave for each request field. */
   export type ImageCounts = Record<string, number>;

   export type ModeControls = {
     controlnet: string;
     controlScale: number | null;
     invertControlImage: boolean;
     strength: number | null;
   };

   export type LocalImageMode = {
     /** The request fields in play, the one that sets the size first. */
     fields: string[];
     /** The other request fields of the mode, such as `controlnet`. */
     settings: Record<string, unknown>;
     /** How many images the model reads at every step, for the timeout. */
     references: number;
   };

   export function localImageMode(
     counts: ImageCounts,
     controls: ModeControls,
     caller: string,
   ): LocalImageMode
   ```

   It holds every check in `_localImageInputs` that comes before the
   first file is touched: `controlnet` goes with `controlImage`, `mask`
   and `strength` go with `startImage`, the strength range, one mode per
   call, and the count cap per field. It throws with the message to fail
   with. A call with no input image returns
   `{ fields: [], settings: {}, references: 0 }`.

2. `caller` replaces the constant `CALLER`. Every refusal starts with
   `${caller} failed:`. The stdlib passes `"generateImageLocal"`, so its
   messages do not change. The public function passes `"generateImage"`.

3. `_localImageInputs` calls `localImageMode`, then checks each path
   with `localImageFile` as it does today. `referenceCount` and
   `localImageMode` count through one shared helper over field names.

4. Add the one function that turns an input into base64:

   ```ts
   export function encodedImageInput(
     input: string | Uint8Array,
     maxBytes: number,
     caller: string,
   ): string
   ```

   Given a path, it refuses a URL or a data URI with `isRemoteSource`,
   then calls `checkedImageFile` and `approvedFileBytes`, which keeps
   the read inside the contained-files module. Given bytes, it checks
   the length against `maxBytes` and names the cap in the message. Both
   image and vision callers use it, each with its own cap. There is no
   second copy for vision. It lives in this file and only
   `lib/local/calls.ts` imports it, so `vision.ts` still imports nothing
   from here.

**Tests:**

1. Every existing `_localImageInputs` test passes unchanged.
2. `localImageMode` returns `references: 2` for two reference images and
   `0` for a start image.
3. `localImageMode` with the caller `"generateImage"` starts its
   refusals with `generateImage failed:`.
4. Bytes over the cap are refused with the cap in the message.
5. A path that is a symlink is refused, as it is for the stdlib.
6. A string that is an `https://` address is refused.

### Task 5: `lib/local/`

**Files:** create `lib/local/public.ts`, `lib/local/result.ts`,
`lib/local/models.ts`, `lib/local/calls.ts`, and a test beside
`models.ts` and `calls.ts`. Modify `package.json`.

**`lib/local/result.ts`** has the one result type the entry point
returns:

```ts
export type Result<T> = { success: true; value: T } | { success: false; error: string };
```

`mlxImage.ts` uses smoltalk's result and `vision.ts` uses the runtime's
untyped `ResultValue`. Neither is exported from `agency-lang/local`. The
request functions from Tasks 2 and 3 return `{ error }` or a value, and
`calls.ts` turns that into a `Result`.

**`lib/local/models.ts`** has `listModels()` and the `LocalModel` type
from the spec. Build each entry from `_listDownloadedModels()`:

- `directory` is `hubSnapshotDir(model.path) ?? model.path`.
- `aliases` comes from `readModelAliases()`. An alias matches when its
  served URI names this model's backend and repo, or its path resolves
  to `model.path` or `directory`. An alias that cannot be read is
  skipped, after `console.error` prints its name and the reason.
- `family` is `_class_name` in `model_index.json`, else the first entry
  of `architectures` in `config.json`, else `null`. Read both with
  `readModelJson`.
- `kind` is `model.kind ?? null`. `DownloadedModel.kind` already comes
  from the record, the catalog, or the files.

The doc comment on `listModels` says which entries are listed but not
served: GGUF files, ControlNets, and downloads that are not complete.
`serve` and the call functions take the `name` of every other entry.

**`lib/local/calls.ts`** has `generateImage`, `detectObjects`,
`tagImage`, `captionImage`, `embedImage`, and `findRegions`.

`generateImage` does this:

1. Check the prompt, format, and model with `checkLocalImageArgs`.
2. Run `localImageMode` on the count of each input, with the caller
   `"generateImage"`.
3. Encode each input of `mode.fields` with `encodedImageInput` and the
   field's `maxBytes` from `LOCAL_IMAGE_FIELDS`.
4. Build the body with `localImageBody`. The settings are
   `localImageSettings(...)`, `mode.settings`, and the encoded images.
   Pass `size ?? ""`, which is what the stdlib sends when no size is
   given.
5. Call `postLocalImage` with
   `localImageTimeoutMs(steps, size, mode.references)`.
6. Pass an error through `explainNoServer` with
   `agency local serve --image ${model}`, and prefix it
   `generateImage failed:`.
7. Return `{ bytes, mimeType, seed }`.

The five vision functions share one helper, so each is a single call:

```ts
async function visionCallWith(
  name: string,
  task: VisionTask,
  options: CallOptions & { model: string; image: ImageInput },
  fields: Record<string, unknown>,
): Promise<Result<unknown>>
```

It runs `checkVisionModel`, then `encodedImageInput` with
`MAX_IMAGE_BYTES`, then `postVisionRequest`, then `visionAnswer`.

The stdlib's defaults live in `stdlib/vision.agency`, not in TypeScript,
so the public functions state them again. They are:

| Function | Option | Default |
|---|---|---|
| `detectObjects` | `threshold` | `null` |
| `tagImage` | `threshold` | `0.35` |
| `tagImage` | `limit` | `30` |
| `captionImage` | `detail` | `"short"` |
| `embedImage` | `boxes` | `null` |
| `findRegions` | `limit` | `50` |
| `findRegions` | `threshold` | `null` |

Put them in one exported object, `VISION_DEFAULTS`, in `calls.ts`.
`tagImage` takes a `limit` option, which the spec's signature leaves out.

**`lib/local/public.ts`** re-exports the functions and types, and
`Result`. It exports nothing else.

Add to `exports` in `package.json`, after `./serve`:

```json
"./local": {
  "types": "./dist/lib/local/public.d.ts",
  "import": "./dist/lib/local/public.js",
  "require": "./dist/lib/local/public.js"
},
```

**Tests:**

1. `listModels` over a temporary models folder returns the directory,
   kind, family, and aliases for one MLX model and one diffusers model.
2. Every entry `listModels` returns that is complete and has the backend
   `mlx` or `diffusers`, and is not a ControlNet, resolves by its `name`
   with `_resolveModel`.
3. For each call function, start a fake server that records the body.
   Call the public function and its stdlib twin with the same inputs.
   The two bodies are equal. The image twin needs a run; use `withRun`
   as `lib/stdlib/image.test.ts` does.
4. `generateImage` with bytes for `startImage` sends the same body as
   the same picture given by path.
5. A test reads `stdlib/vision.agency` and checks each default in
   `VISION_DEFAULTS` against the text of the matching signature, so a
   default changed in one place fails here.
6. With no server running, `generateImage` and `tagImage` each fail with
   the "no local model server answered" message.

### Task 6: docs for PR 1

1. Create `docs/dev/llm/local-typescript-api.md`. Cover the entry point,
   why the call functions raise no interrupt, the two halves of each
   stdlib helper, `postLocalJson`, why the stdlib functions take no
   server address, and the defaults that are stated twice with the test
   that ties them together.
2. Update `docs/dev/llm/local-images.md` for `localImageMode`,
   `localImageBody`, `postLocalImage`, and where `checkLocalImageArgs`
   now lives. Update `docs/dev/llm/local-vision.md` for
   `postVisionRequest` and `visionAnswer`.
3. Add a "From TypeScript" section to
   `docs/site/guide/using-local-models.md`, with the goal program above
   minus `serve`. Say that `agency-lang/stdlib-lib` is internal.
4. List the new dev doc in `CLAUDE.md` and in the `agency-llm-docs`
   skill.

## PR 2: processes that exit with the server

This PR fixes a problem that exists today and needs nothing from the
later PRs. If the Node process is killed with SIGKILL, each Python
process keeps its model in memory.

### Task 7: the watcher

**Files:** `lib/cli/localServerCommon.py`, each server script, create
`lib/cli/mlxVlmServer.py`, `lib/cli/vlmChat.ts`, `lib/cli/localServe.ts`,
`makefile`, a test file `lib/cli/exitWithParent.test.ts`.

1. Add to `localServerCommon.py`:

   ```python
   EXIT_WITH_PARENT = "AGENCY_EXIT_WITH_PARENT"


   def exit_when_parent_goes():
       """When the process that started this server asked for it, exit
       as soon as standard input closes, which happens when that process
       exits for any reason. Does nothing otherwise, so a server started
       by hand is left alone."""
       if os.environ.get(EXIT_WITH_PARENT) != "1":
           return

       def wait():
           sys.stdin.buffer.read()
           os._exit(0)

       threading.Thread(target=wait, daemon=True).start()
   ```

   The environment check matters. Without it, a script started as a
   background job is stopped by SIGTTIN the moment the thread reads the
   terminal. One started with `nohup`, under launchd, or with standard
   input from `/dev/null` reads end-of-file at once and exits before it
   has loaded anything.

2. Call it first thing at startup in `mlxSpeechServer.py`,
   `diffusersImageServer.py`, and `visionServer.py`, which already
   import `localServerCommon`.

3. `mlxChatServer.py` and `mlxEmbedServer.py` do not import
   `localServerCommon` today. Add the two lines the other scripts have,
   then the call:

   ```python
   sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
   from localServerCommon import exit_when_parent_goes  # noqa: E402
   ```

   Update the docstring of `localServerCommon.py`, which names only the
   speech, image, and vision servers.

4. Create `mlxVlmServer.py`. It calls `exit_when_parent_goes()` and then
   `runpy.run_module("mlx_vlm.server", run_name="__main__")`. Add
   `vlmServerScript()` next to the other `...ServerScript()` functions.
   `vlmServeArgs` takes the script path and returns it in place of
   `"-m", "mlx_vlm.server"`. The arguments after it stay the same.

5. Copy `mlxVlmServer.py` in the `makefile`, next to the other scripts.

6. `realSpawn` uses `stdio: ["pipe", "inherit", "inherit"]`, sets
   `AGENCY_EXIT_WITH_PARENT: "1"` in the child's environment, and never
   writes to the pipe.

**Tests**, in TypeScript, started the way `visionServer.test.ts` starts
`python3`, and skipped without it:

1. Start `python3 -c` with a program that imports `localServerCommon`,
   calls `exit_when_parent_goes()`, and sleeps for 30 seconds. Set the
   environment variable. Close the child's standard input. It exits with
   status 0 within two seconds.
2. The same program without the variable, with standard input closed, is
   still running after one second. Kill it.
3. Each of the six server scripts contains a call to
   `exit_when_parent_goes()`.
4. `vlmServeArgs` starts with the path of `mlxVlmServer.py`, and that
   file is valid Python 3. Add it to the "valid Python 3" test beside
   the others.
5. `realSpawn`'s options set the variable and a pipe for standard input.
   Export a small `spawnOptions()` function so the test reads the
   options without starting a process.

The spec asks for a test that starts the real image server script. That
script fails on its first model import in CI, which has no model
libraries, so the test would pass for the wrong reason. The check
against a real model at the end of this plan covers it.

### Task 8: docs for PR 2

Add "When the server dies first" to `docs/dev/llm/mlx-local-models.md`:
the pipe, the environment variable and why the watcher is not always on,
and the `mlx-vlm` script. Update that doc's line in `CLAUDE.md` and in
the `agency-llm-docs` skill.

## PR 3: one description per model, and the pool

This PR changes no behavior of `agency local serve`. It makes
`ServeTarget` the one description of a model to serve, puts the model
processes behind a pool, and adds the first handle methods.

### Task 9: `ServeTarget` becomes the input

**Files:** `lib/cli/localServe.ts`, `lib/cli/localServe.test.ts`.

Today a model's description is spread over three places: the positional
values, one list per naming flag, and `flags.options`. Put it in one.

1. Rename the two existing exported types whose names the public API
   needs: `ServedModel` becomes `BannerModel`, and `ServeOptions` becomes
   `ChatServeOptions`.

2. Widen `ServeTarget`:

   ```ts
   export type ServeTarget = {
     model: string;
     /** The kind a flag gave it. Absent: read it from the model. */
     kind?: ServeKind;
     /** The chat runtime a flag gave it. Absent: the kind's default. */
     runtime?: ChatRuntime;
     /** The flag that named it, for messages. Absent for a plain argument. */
     flag?: string;
   } & ModelOptions;
   ```

3. Add `targetsFromFlags(values, flags): ServeTarget[]`. It returns one
   target per value, then one per entry of each `NAMING_FLAGS` list,
   each with the row's `kind`, `runtime`, and `flag`, and each with
   `flags.options[model]` spread in. This is the only reader of
   `flags.options` and of the per-flag lists.

4. Add `planTarget(target, cacheDir): Planned`. It is today's choice
   between `planModel` and `planFlag`, then `withDraft`, made from the
   target's fields.

5. Move the body of `runServe` into a new exported function:

   ```ts
   export type ServeSettings = ReplyLimits & {
     port?: number;
     maxTokens?: number;
     prefillStep?: number;
     python?: string;
     logPrompts?: boolean;
   };

   export async function serveTargets(
     targets: ServeTarget[],
     settings: ServeSettings,
     deps: ServeDeps = realDeps(),
   ): Promise<ServeHandle>
   ```

   `runServe(values, flags, deps)` keeps its signature and becomes
   `serveTargets(targetsFromFlags(values, flags), flags, deps)`.

**Tests:** every existing `runServe` test passes unchanged. Add tests
for `targetsFromFlags`: a plain value, a `--vlm` value, and a value with
a draft.

### Task 10: `lib/cli/modelPool.ts`

**Files:** create `lib/cli/modelPool.ts` and its test.

The pool owns one record per served model. It is the only code that
starts or stops a model process, and the only code that writes a record.

```ts
/** What is fixed about a served model once it is planned. */
export type ModelPlan = {
  model: string;
  upstreamModel: string;
  label: string;
  kind: ServeKind;
  rules: RequestRules | null;
  /** Whether closing the connection stops this request. See Task 18. */
  stopsOnClose: (body: Record<string, unknown>) => boolean;
  /** Estimated memory to load it. See Task 14. */
  needBytes: number;
  lazy: boolean;
};

export type Running = { child: Child; port: number };

/** One shape per state, each with the fields that state has. */
export type ModelState =
  | { state: "stopped" }
  | { state: "loading"; running: Running | null; loaded: Promise<void> }
  | { state: "ready"; running: Running }
  | { state: "failed"; error: string };

export type ModelRecord = {
  plan: ModelPlan;
  current: ModelState;
  requestsInProgress: number;
  lastUsedAt: number | null;
};

/** A model held for one request. The pool will not stop it until
 *  `release` is called. */
export type Held = { plan: ModelPlan; port: number; release: () => void };

export type RefusalReason = "not-loaded" | "not-enough-memory" | "load-failed" | "stopping";

export class PoolRefusal extends Error {
  constructor(
    public reason: RefusalReason,
    message: string,
  ) {
    super(message);
  }
}

export type PoolDeps = {
  spawn: (plan: ModelPlan) => Promise<Running>;
  waitUntilLoaded: (plan: ModelPlan, running: Running) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
};

export type ModelPool = {
  models: () => string[];
  status: () => ModelStatus[];
  plan: (model: string) => ModelPlan | undefined;
  acquire: (model: string) => Promise<Held>;
  load: (model: string) => Promise<void>;
  unload: (model: string) => Promise<void>;
  stopAll: () => Promise<void>;
  failure: Promise<string>;
};

export function createModelPool(plans: ModelPlan[], deps: PoolDeps): ModelPool
```

Import the types it needs from `localServe.ts` with `import type`.

**Starting is two steps.** `deps.spawn` picks a free port and starts the
process, and returns at once. The pool stores the `Running` on the
record, and only then calls `deps.waitUntilLoaded`. A model that is
loading therefore has a child the pool can kill and can watch. `running`
is null only in the moment before `spawn` returns.

**One queue.** Every change of state goes through one promise queue:
`load`, `unload`, and `stopAll`. An `unload` called during a load waits
for its turn, then kills the child. Inside the queue, a private
`stopRecord(record)` kills the child, waits for its exit, and sets
`stopped`. It does not join the queue. `unload` is `stopRecord` run on
the queue. Code already on the queue calls `stopRecord` directly.

**`acquire` replaces a `ready` check.** It returns a `Held` with the
count already raised:

- On a `ready` record: raise `requestsInProgress`, set `lastUsedAt`,
  return.
- On a `loading` record: await `loaded`, then as above.
- On any other state, in this PR: throw `PoolRefusal("not-loaded", ...)`
  with the message
  `<model> was unloaded. Load it again with server.load("<model>"), or restart the server.`

`release` lowers the count and sets `lastUsedAt`. It does nothing on a
second call. There is no moment where a record is `ready`, has a request
on its way, and shows a count of 0.

**`lastUsedAt` is never null for a model that is loaded.** The pool sets
it when a load finishes.

**A child that exits on its own.** The pool sets `failed` with the exit
description and resolves `failure`. A child that `stopRecord` killed
does neither. Keep the 250 ms wait from `runServe`: a terminal Ctrl-C
reaches the children before Node, so an exit that arrives just before
`stopAll` is not a failure. Name the constant `EXIT_GRACE_MS`. The
existing test "does not report a child that exits just before close(),
as on Ctrl-C" covers it.

Keep records in a plain object keyed by model name.

**Tests**, with fake children:

1. `load` moves a record from `stopped` through `loading` to `ready`.
2. The record has its child while it is `loading`.
3. Two `load` calls for one model spawn one process.
4. `unload` during a load kills the child. A call to `acquire` that was
   waiting on that load rejects.
5. `unload` then `load` spawns a second process on a new port.
6. `acquire` raises the count, and `release` lowers it once however many
   times it is called.
7. `acquire` on an unloaded model rejects with the `not-loaded` reason.
8. A child that dies on its own sets `failed` and resolves `failure`.
9. `unload` does not resolve `failure`.

### Task 11: the front door reads the pool

**Files:** `lib/cli/mlxServer.ts`, `lib/cli/mlxServer.test.ts`,
`lib/cli/localServe.ts`.

1. `startFrontDoor` takes a `ModelPool` in place of `Route[]`. Delete
   the `Route` type.

2. A request does this:
   1. Look up `pool.plan(model)`. An unknown model gets the 404 it gets
      today. `default_model` names the one model when `pool.models()`
      has one entry.
   2. Apply the plan's request rules. A refused request never loads a
      model.
   3. `await pool.acquire(model)`.
   4. If the client has gone (`res.destroyed`), call `release` and stop.
   5. Forward to `held.port`.

3. `forward` already calls `finish` once on every ending: the reply
   closed, the upstream connection failed, or the client left. Call
   `held.release()` in the same place. The door writes nothing on a
   record.

4. A `PoolRefusal` becomes a reply through one table:

   ```ts
   const STATUS_FOR_REFUSAL: Record<RefusalReason, number> = {
     "not-loaded": 503,
     "not-enough-memory": 503,
     "load-failed": 502,
     stopping: 503,
   };
   ```

5. Add the admin routes as a table, checked before the body is read as a
   model request:

   ```ts
   type AdminReply = { status: number; body: unknown };
   type AdminRoute = {
     method: "GET" | "POST";
     path: string;
     handle: (body: Record<string, unknown>) => Promise<AdminReply>;
   };
   ```

   One function, `adminRefusal(req)`, holds the rules every admin route
   shares, so no handler repeats them:

   - The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`.
     Otherwise 403.
   - A POST must have `content-type: application/json`. Otherwise 415.

   Name the statuses: `FORBIDDEN_HOST = 403`,
   `UNSUPPORTED_MEDIA_TYPE = 415`.

   This PR adds one row: `GET /v1/agency/status`, which returns
   `{ models: pool.status() }`. `GET /v1/models` stays as it is and
   lists `pool.models()`.

6. `serveTargets` builds a `ModelPlan` from each `Planned`, creates the
   pool, calls `pool.load` for each model in order, and then opens the
   door. A failed load calls `pool.stopAll()` and throws, as today.

**Tests:** the existing front door tests pass with a pool whose records
are ready. Add:

1. The status route returns each model's state.
2. The count is back to zero after a client disconnects mid-reply.
3. The count is back to zero after a client disconnects before the reply
   starts.
4. The count is back to zero when the upstream port refuses the
   connection.
5. A request for an unloaded model gets a 503 with the message.
6. A request the rules refuse never calls `acquire`.
7. The status route with `Host: evil.example` gets a 403.

### Task 12: the handle and `serve`

**Files:** `lib/cli/localServe.ts`, create `lib/local/serve.ts`,
`lib/local/public.ts`, tests beside each.

1. Add `url`, `status`, `load`, and `unload` to `ServeHandle`. Each
   method calls the pool. `url` is `http://127.0.0.1:${port}/v1`.

2. Accept `port: 0`. Remove `?? 8080` inside `serveTargets`; the CLI
   keeps its default of 8080 in `scripts/agency.ts`.

3. `lib/local/serve.ts` exports `serve(models, options)` and the public
   types. The public `ServedModel` is:

   ```ts
   export type ServedModel = {
     model: string;
     lazy?: boolean;
     /** Serve it as this kind, as `--embedding`, `--speech`, and `--image` do. */
     kind?: ModelKind;
     /** Serve a chat model with mlx-vlm, as `--vlm` does. */
     vlm?: boolean;
     draft?: string;
     draftTokens?: number;
   };
   ```

   `serve` maps each entry straight to a `ServeTarget` and calls
   `serveTargets`. A string is `{ model }`. `vlm: true` is
   `kind: "chat", runtime: "mlx-vlm", flag: "--vlm"`. Nothing is turned
   into flags and parsed back.

   `lazy` is accepted by the type and refused at run time until PR 4,
   with the message `lazy is not supported by this version`.

4. `serve` passes dependencies whose `spawn` pipes the child's output:
   `stdio: ["pipe", "pipe", "pipe"]`. It splits stdout and stderr into
   lines on `\n` and `\r`, because model loading prints progress bars,
   and hands each line to `options.log`. The default `log` discards, but
   the pipes are always read, or the child blocks when one fills. Set
   `PYTHONUNBUFFERED: "1"` in the child's environment. Python buffers in
   blocks when it is not writing to a terminal, and lines would arrive
   late. Build both spawn variants from the `spawnOptions()` function of
   Task 7, so both keep the standard-input pipe and the watcher
   variable. Add `realDeps(overrides)` for this.

**Tests:**

1. `serve(["a"], { port: 0 })` with fake dependencies resolves with a
   port above 0 and a matching `url`.
2. A `ServedModel` with `draft` reaches the pool with the draft in its
   plan.
3. `{ model: "a", vlm: true }` is planned with the `mlx-vlm` runtime.
4. `{ model: "a", kind: "embedding" }` is planned as an embedding model.
5. `unload` then `status` reports `stopped`.
6. A line the fake child writes to stderr reaches `log`.

### Task 13: docs for PR 3

Update the "front door" section of `docs/dev/llm/mlx-local-models.md` to
describe `ServeTarget` as the one input, the pool, `acquire` and
`release`, the state shapes, the one queue, the admin route table, and
the status route. Add `serve` and the handle to
`docs/dev/llm/local-typescript-api.md` and to the guide section. Update
both docs' lines in `CLAUDE.md` and the `agency-llm-docs` skill.

## PR 4: `--lazy`

### Task 14: available memory

**Files:** create `lib/cli/availableMemory.ts` and its test. Modify
`ServeDeps`.

```ts
export type MemorySnapshot = { available: number; total: number };

const GIB = 1024 ** 3;
export const MEMORY_RESERVE_MAX_BYTES = 2 * GIB;
export const MEMORY_RESERVE_FRACTION = 0.05;

/** Memory a model needs beyond its size on disk, by kind. */
export const LOAD_HEADROOM_BYTES: Record<ServeKind, number> = {
  chat: 1 * GIB,
  embedding: 1 * GIB,
  speech: 1 * GIB,
  image: 4 * GIB,
  vision: 1 * GIB,
  controlnet: 1 * GIB,
};

export function parseVmStat(text: string): number
export function parseMeminfo(text: string): number
export async function availableMemory(log: (line: string) => void): Promise<MemorySnapshot>
export function memoryReserve(memory: MemorySnapshot): number
export function estimatedNeed(model: Planned): number
export function fits(needBytes: number, memory: MemorySnapshot): boolean
```

- `parseVmStat` adds the free, inactive, and speculative pages and
  multiplies by the page size in the first line.
- `parseMeminfo` reads `MemAvailable`, in kB.
- Mark Cut Paste already has both parsers, with tests and a saved
  `vm_stat` sample, in `src/backend/lib/agency/memory.ts`. Port them.
- `availableMemory` picks by `os.platform()`. On an error it logs the
  error through `log` and then returns `os.freemem()`.
- `memoryReserve` is the smaller of `MEMORY_RESERVE_MAX_BYTES` and
  `MEMORY_RESERVE_FRACTION` of total.
- `estimatedNeed` is the size on disk, plus the draft's size, plus the
  kind's entry in `LOAD_HEADROOM_BYTES`. `serveTargets` puts it in
  `ModelPlan.needBytes`.
- `fits` is `available >= needBytes + memoryReserve(memory)`.

Add `availableMemory` to `ServeDeps`, `PoolDeps`, and `realDeps`.

**Tests:** parse a saved `vm_stat` output and a saved `/proc/meminfo`.
Check `estimatedNeed` for an image model, a chat model, and a chat model
with a draft. Check `fits` on each side of the line. Check that a failed
read logs before it falls back.

### Task 15: lazy loading and eviction in the pool

**Files:** `lib/cli/modelPool.ts` and its test.

1. `acquire` on a `stopped` or `failed` record whose plan is lazy puts a
   load on the queue and waits for it. On a `loading` record it waits
   for the load in progress. On a record that is not lazy and not
   loaded, it throws `not-loaded` as in PR 3.

2. Which model to stop is a pure function, tested on plain records:

   ```ts
   /** The loaded lazy model that has been idle longest, or undefined
    *  when every loaded model is busy or not lazy. */
   export function evictionCandidate(records: ModelRecord[]): ModelRecord | undefined
   ```

   Candidates are lazy, are `ready`, and have `requestsInProgress === 0`.
   It returns the one with the smallest `lastUsedAt`.

3. Before `spawn`, the load of a lazy model runs `makeRoom(record)`,
   which only acts on those two answers:

   ```ts
   async function makeRoom(record: ModelRecord): Promise<void>
   ```

   It loops. Read `deps.availableMemory()`. Return if `fits`. Otherwise
   take `evictionCandidate`. With one, call `stopRecord` on it and loop.
   With none, throw `PoolRefusal("not-enough-memory", ...)` with the
   message in the spec. `makeRoom` runs on the queue, so it calls
   `stopRecord`, not `unload`.

4. `deps.env.AGENCY_ALLOW_MEMORY_OVERCOMMIT === "1"` makes `makeRoom`
   return instead of throwing.

5. A lazy child that dies on its own sets `failed` with the error. It
   does not resolve `failure`. The next `acquire` tries again.

6. A load that fails for any reason other than memory throws
   `PoolRefusal("load-failed", ...)` with the record's error. The table
   from Task 11 already gives it a 502 and gives `not-enough-memory` a 503.

**Tests.** For `evictionCandidate`, on plain records with no process:

1. It returns the lazy, ready, idle record with the oldest `lastUsedAt`.
2. It skips a record with a request in progress.
3. It skips a record that is not lazy.
4. It skips a record that is loading, stopped, or failed.
5. It returns undefined when nothing qualifies.

For the pool, with a fake `availableMemory` that returns a scripted
list:

1. No process is spawned for a lazy model until `acquire` is called.
2. Two `acquire` calls during a load spawn one process, and both
   resolve.
3. With memory short, the load stops the candidate, then starts.
4. A model held by `acquire` and not yet released is never stopped, even
   when it was acquired in the same tick its load finished.
5. With nothing to stop, `acquire` rejects with the message, and no
   process is spawned.
6. With the overcommit variable set, case 5 spawns the process.
7. A lazy child that dies is restarted by the next `acquire`.
8. A model warmed with `load` and never requested has a `lastUsedAt`,
   and is not stopped ahead of a model used longer ago.

For the front door:

1. A client that disconnects while its model is loading is not
   forwarded once the load finishes, and the count is zero.

### Task 16: the flag

**Files:** `scripts/agency.ts`, `lib/cli/localServe.ts`,
`lib/cli/localServe.test.ts`, `lib/local/serve.ts`.

`--lazy` names a model, so it is a row in `NAMING_FLAGS`, not a branch
beside it.

1. Declare the option next to `--vlm`:

   ```ts
   .option(
     "--lazy <model>",
     "Serve this model on demand: load it on its first request, and stop it when another lazy model needs the memory (repeatable)",
     collectRepeats,
     [],
   )
   ```

2. Widen the row type and add the row:

   ```ts
   type NamingFlag = {
     flag: string;
     key: "embedding" | "speech" | "image" | "vlm" | "lazy";
     /** The kind the flag gives its model. Null: read it from the model. */
     kind: ServeKind | null;
     runtime: ChatRuntime | null;
     lazy: boolean;
   };

   { flag: "--lazy", key: "lazy", kind: null, runtime: null, lazy: true },
   ```

   The four existing rows get `lazy: false`. Add `lazy?: string[]` to
   `ServeFlags` and `lazy?: boolean` to `ServeTarget`.

   Three things now work with no further code, because each reads the
   table: `groupServeArgv` attaches a `--draft` written after `--lazy b`
   to `b`. `targetsFromFlags` returns a lazy target for it. The picker
   check in `localServe` sees a model was named.

3. One model may be named by a kind flag and by `--lazy`, as in
   `--vlm a --lazy a`. Add a pure function that runs after planning:

   ```ts
   /** One plan per model. Two plans for one model are joined when one
    *  came from `--lazy` alone and the other from a kind flag. Any other
    *  repeat throws "<name> is named twice." */
   function joinLazyPairs(planned: Planned[]): Planned[]
   ```

   It compares the planned names, not the text typed, so
   `--vlm qwen3.5-9b --lazy mlx:mlx-community/Qwen3.5-9B-4bit` is one
   model. It replaces the "named twice" check in `serveTargets`.
   `a --lazy a` is still an error, since neither came from a kind flag.

4. Load only the models that are not lazy before opening the door.

5. `memoryWarning` counts only the models that are not lazy.

6. The banner marks each lazy model with `(on demand)`.

7. In `lib/local/serve.ts`, remove the refusal from Task 12 and pass
   `lazy` through to the target.

**Tests:**

1. `agency local serve a --lazy b` spawns one process before the door
   opens.
2. `--lazy b --draft c` attaches the draft to `b`.
3. `a --lazy a` throws `a is named twice.`
4. `--vlm a --lazy a` plans one model, lazy, with the `mlx-vlm` runtime.
5. The same pairing with the model spelled two ways plans one model.
6. `agency local serve --lazy a`, with no other model, does not open the
   picker, and opens the door with no process spawned.
7. Three large lazy models print no memory warning.
8. `serve([{ model: "a", lazy: true, vlm: true }])` plans one model,
   lazy, with the `mlx-vlm` runtime.

### Task 17: docs for PR 4

1. `docs/site/cli/local.md`: the flag, with the example from the spec.
2. `docs/site/guide/using-local-models.md`: a section on serving several
   models that do not fit in memory together. Say that the first request
   for a lazy model waits for the load, that the wait counts against the
   caller's timeout, and that `server.load(model)` warms a model ahead
   of a request with a deadline.
3. `docs/dev/llm/mlx-local-models.md`: `makeRoom`, `evictionCandidate`,
   the estimate and its table, how memory is read, and the
   `NAMING_FLAGS` row.

## PR 5: `cancel`

### Task 18: cancel in the pool and the front door

**Files:** `lib/cli/mlxServer.ts`, `lib/cli/modelPool.ts`,
`lib/cli/localServe.ts`, `lib/cli/vlmChat.ts`, `lib/local/serve.ts`,
tests beside each.

1. Whether closing the connection stops a request is a property of the
   runtime, so it is a field of its row. Add to `ChatRuntimeSpec`:

   ```ts
   /** Whether the runtime stops generating when the connection closes. */
   stopsOnClose: (body: Record<string, unknown>) => boolean;
   ```

   `mlx-lm` gets `() => true`. `mlx-vlm` gets
   `(body) => body.stream === true`. Every other kind stops, so
   `ModelPlan.stopsOnClose` is the chat spec's function, or `() => true`.
   The table in the spec is the doc comment on the field.

2. The front door keeps, per model, every request from the moment its
   model is known until it ends:

   ```ts
   type InProgress = {
     res: http.ServerResponse;
     /** Null while the request waits for its model to load. */
     upstream: http.ClientRequest | null;
     stopsOnClose: boolean;
     cancelled: boolean;
   };
   ```

3. `door.cancel(model)` does this for each entry of the model:
   1. Set `cancelled`.
   2. If the reply has not started (`!res.headersSent`), write a
      `CLIENT_CLOSED_REQUEST` (499) with
      `{ "error": { "message": "Cancelled" } }`. Otherwise destroy
      `res`.
   3. Destroy `upstream` when there is one.

4. Destroying `upstream` makes Node emit `error` on it. The handler in
   `forward` writes a 502 today, and writing headers a second time
   throws and takes the server down. Make the handler return at once
   for an entry with `cancelled` set. The request's log line shows 499.

5. A request that was waiting for a load is not forwarded. After
   `acquire` resolves, the door checks `cancelled` next to the
   `res.destroyed` check from Task 11, and releases. The load itself is
   left to finish.

6. If any cancelled entry had an `upstream` and `stopsOnClose === false`,
   call `pool.unload(model)`. Then call `pool.load(model)` when the plan
   is not lazy.

7. Add a row to the admin table: `POST /v1/agency/cancel` reads
   `{ model }`. It answers 404 for a model that is not served, and 200
   with `{ "cancelled": <count> }` otherwise. The 415 and the host check
   come from `adminRefusal`.

8. Add `cancel` to `ServeHandle` and to the public `LocalServer`.

**Tests:**

1. `cancel` on a model with one request waiting gives that client a 499
   and destroys the upstream request.
2. After test 1, the door answers another request. This fails if the
   error handler writes a second reply.
3. `cancel` on an image record keeps its process.
4. `cancel` on an `mlx-vlm` record with a non-streamed request unloads
   the process. A record that is not lazy is loaded again.
5. `cancel` on an `mlx-vlm` record with a streamed request keeps its
   process.
6. `cancel` on a model whose one request is waiting for a lazy load
   gives the client a 499, does not forward it, and lets the load
   finish.
7. `cancel` on an idle model spawns and kills nothing.
8. The route refuses a POST with `content-type: text/plain`.
9. The log line for a cancelled request shows 499.

### Task 19: docs for PR 5

Add a "Cancelling" section to `docs/dev/llm/mlx-local-models.md` with the
table, the `stopsOnClose` field, and why a cancelled entry is marked
before its upstream is destroyed. Add the two examples from the spec to
the guide.

## PR 6: shutting down

### Task 20: `close` waits

**Files:** `lib/cli/localServe.ts`, `lib/cli/modelPool.ts`,
`lib/cli/mlxServer.ts`, `lib/local/serve.ts`, tests.

1. Widen `Child.kill` to take a signal:
   `kill: (signal?: NodeJS.Signals) => unknown`.

2. `pool.stopAll()` runs on the queue. It refuses every later `acquire`
   and `load` with the `stopping` reason. It sends SIGTERM to every
   child, including one that is still loading, waits for all exits or
   `STOP_GRACE_MS` (5000), then sends SIGKILL to the rest and waits for
   those exits. Take the timer from `PoolDeps`, so tests do not wait.

3. The door gets `refuseNew()`. After it, every request gets a 503 with
   `This server is shutting down.`

4. `handle.close()` calls `door.refuseNew()`, then `pool.stopAll()`,
   then `door.close()`.

5. Add a row to the admin table: `POST /v1/agency/shutdown` answers 200,
   and then calls a `shutdown` callback that the door was given.
   - Under the CLI, `localServe` resolves its wait on that callback and
     exits 0, on the same path as SIGINT.
   - Under `serve()`, the callback is `handle.close()`. The host program
     keeps running.

**Tests:**

1. A fake child that ignores SIGTERM gets SIGKILL after the grace
   period.
2. `close` resolves only after every child has exited.
3. `close` during a load kills the loading child.
4. A request made during `close` gets the 503.
5. The shutdown route calls the callback once.

### Task 21: docs for PR 6

Add "Shutting down" to `docs/dev/llm/mlx-local-models.md`, covering the
five steps of `close`, what the shutdown route does under the CLI and
under `serve()`, and why the admin routes check the host and the content
type. Add `close` and the shutdown route to the guide.

## Finishing a PR

1. Run the unit tests for the files touched, and save the output:

   ```
   pnpm test:run lib/cli lib/stdlib lib/local > /tmp/local-api-tests.log 2>&1
   ```

2. `pnpm run lint:structure`
3. `pnpm run fmt:ts`
4. `make`, when a stdlib file or a Python script changed.
5. Check the code against `docs/dev/contributing/anti-patterns.md`, and
   against "Rules for the whole plan" above.
6. Check the new docs and comments against
   `docs/dev/contributing/general-writing-tips.md` and
   `docs/dev/contributing/verbal-tics.md`.
7. Write the commit message and the PR description to a file, and pass
   the file to `git` and `gh`.

Do not run the full Agency test suite locally. CI runs it.

## Checks against real models

These need the models on the external volume and several minutes each.
Hand the commands to the user to run. Do not run them from the agent.

After PR 1:

```
agency local serve z-image-turbo wd14-tagger
node scripts/checks/local-api-generate.mjs
```

The script calls `generateImage` and `tagImage` from `agency-lang/local`
and writes the picture to the scratch folder. Write the script in this
PR. It needs `make` first, since it imports the built package.

After PR 2, three checks:

1. Start the server, send the Node process SIGKILL, and confirm with
   `ps` that no Python model process remains.
2. Do the same while a model is still loading.
3. Start one server script by hand as a background job
   (`python lib/cli/visionServer.py ... &`) and confirm it keeps
   running.

After PR 4:

```
agency local serve --lazy z-image-turbo --lazy flux2-klein-9b --lazy qwen3.8-27b
```

Request each model in turn. Confirm from the log that a model is stopped
only when the next one does not fit, and that the stopped one is the one
used longest ago. Then:

1. Note the available memory the log reports just after a model is
   stopped. If it has not risen by about the model's size, the formula
   is reading memory that macOS has not yet handed back, and the plan
   needs a short wait or a different reading before PR 4 merges.
2. Time a cold load of `z-image-turbo` and compare it with the 168
   seconds an 8-step request is given. If the load takes more than half
   of that, add a load allowance to `localImageTimeoutMs` and to the
   vision timeout.

After PR 5: start a non-streamed chat request to a `--vlm` model that
asks for a long reply, call `POST /v1/agency/cancel`, and confirm with
`ps` that the Python process was replaced.

After PR 6: press Ctrl-C while a lazy model is loading, and confirm with
`ps` that no Python model process remains.

## Departures from the spec

Update the spec to match before starting the PR each one belongs to.

1. **`tagImage` takes `limit`** (PR 1). The stdlib function sends it, so
   the public one must, or the two requests differ. Done in the spec.
2. **The public result type is defined by the entry point** (PR 1). It
   is `{ success: true, value } | { success: false, error }`, not the
   runtime's or smoltalk's. Done in the spec, along with a `seed` that
   may be null and the optional models folder `listModels` takes.
3. **Processes that exit with the server ship second, not last** (PR 2),
   and the watcher runs only when `AGENCY_EXIT_WITH_PARENT=1`.
4. **The pipe test does not start the real image server script** (PR 2).
   See Task 7.
5. **The public `ServedModel` has `kind` and `vlm`** (PR 3). Without
   them `serve()` cannot serve a vision-language model, or a model whose
   files do not say its kind.
6. **The admin routes check the `Host` header** (PR 3). The content-type
   rule stops a cross-site form post. It does not stop a page that
   reaches `127.0.0.1` under its own hostname.
7. **`cancel` also answers requests that are waiting for a load**
   (PR 5).
8. **Over HTTP, a model that is not lazy stays unloaded until the server
   restarts.** The spec has no load route. The 503 message says so.

## Out of scope

The spec's "Not in this spec" section applies. In particular, this plan
does not move Mark Cut Paste onto the new API, does not add a serve
file to `agency.json`, does not change `--draft`, and does not add HTTP
routes for `load` and `unload`.
