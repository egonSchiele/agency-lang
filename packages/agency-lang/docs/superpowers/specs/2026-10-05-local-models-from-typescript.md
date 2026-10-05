# Local models from TypeScript: a public API, on-demand loading, and cancelling

Builds on `2026-09-28-local-models-dx.md`, which gave every model a kind
and made `agency local serve` take models of any kind.

## The problem

Mark Cut Paste is a TypeScript app that generates, edits, and tags images
with local models. It uses Agency for the model servers and for the code
that calls them. No model in the app decides what to do next, so the app
has no use for interrupts, handlers, or tools.

To reach the parts it needs, the app does five things that Agency should
make unnecessary.

1. **It writes Agency code it does not need.** `images.agency` has eight
   nodes. Each one wraps a single stdlib call and approves the interrupt
   that call raises. The app keeps a hand-written `images.d.ts` beside it.
2. **It imports Agency's internal files.** The model list comes from
   `agency-lang/stdlib-lib/localModels.js`, through a function named
   `_listDownloadedModels`. Nothing promises that file or that name will
   exist in the next release.
3. **It manages the server processes itself.** It spawns the
   `agency local serve` command once per model, picks a free port, polls
   `/v1/models` until the model answers, and cleans up processes that
   outlive the backend. This is about 500 lines.
4. **It decides which models fit in memory.** `agency local serve a b c`
   loads all three at once and prints a warning if they are larger than
   the machine's memory. The app instead starts a model when a job needs
   it, and stops idle models first when memory is short.
5. **It starts a new Node process for every model call.** Each model has
   its own port, and the stdlib functions read the server address from
   the `MLX_BASE_URL` environment variable. The app also kills that
   process to cancel a call.

## What this adds

1. A public entry point, `agency-lang/local`, for TypeScript programs.
   It lists models, starts a server, and calls the server.
2. On-demand loading in `agency local serve`, with a `--lazy <model>`
   flag. A lazy model's process starts on its first request. When memory
   is short, the server stops the lazy model that has been idle longest.
3. Cancelling. Every call takes an `AbortSignal`, and the server can
   cancel the work running on one model.
4. Shutting down. The server waits for its processes to exit, and the
   processes exit on their own if the server dies.

The four parts can ship separately, in the order under "What changes, in
order".

## 1. `agency-lang/local`

Here is the app's whole use of Agency, written against the new entry
point:

```ts
import {
  listModels,
  serve,
  generateImage,
  tagImage,
} from "agency-lang/local";

const models = listModels();
const imageModel = models.find((model) => model.kind === "image");
const taggingModel = models.find((model) => model.kind === "vision");

const server = await serve(
  [
    { model: imageModel.name, lazy: true },
    { model: taggingModel.name, lazy: true },
  ],
  { port: 0 },
);

const cancelButton = new AbortController();
const generated = await generateImage({
  baseUrl: server.url,
  model: imageModel.name,
  prompt: "a lighthouse in a storm",
  size: "1024x1024",
  signal: cancelButton.signal,
});

const tags = await tagImage({
  baseUrl: server.url,
  model: taggingModel.name,
  image: generated.value.bytes,
});

await server.close();
```

The program compiles no `.agency` file and raises no interrupts. One
server address serves both models, so the program needs no environment
variable and no second process.

### Listing models

```ts
type LocalModel = {
  name: string;
  aliases: { name: string; description: string }[];
  kind: ModelKind | null;
  family: string | null;
  backend: "llama-cpp" | "mlx" | "diffusers";
  directory: string;
  sizeBytes: number;
  complete: boolean;
  revision: string | null;
};

function listModels(): LocalModel[];
```

`listModels` returns what `agency local list` prints, as data.
It takes an optional models folder, `listModels(cacheDir)`, and reads the
configured one without it. Three kinds of entry are listed and cannot be
served: a GGUF file, a ControlNet, and a download that is not complete.

- `name` is the name `serve` and the call functions accept.
- `aliases` holds every alias in `agency.json` that points at this model.
- `kind` is the kind recorded at download, or read from the files.
- `family` is the class name in the model's `model_index.json`, or the
  first entry of `architectures` in its `config.json`. For example,
  `"ZImagePipeline"` or `"Florence2ForConditionalGeneration"`.
- `directory` is the folder holding the model's files. For a Hugging
  Face cache entry it is the snapshot folder.

`listModels` wraps `_listDownloadedModels`, `readModelAliases`, and
`hubSnapshotDir`. Those three stay where they are.

### Starting a server

```ts
type ServedModel = {
  model: string;
  lazy?: boolean;
  draft?: string;
  draftTokens?: number;
};

type ServeOptions = {
  port?: number;
  python?: string;
  log?: (line: string) => void;
};

type ModelStatus = {
  model: string;
  state: "stopped" | "loading" | "ready" | "failed";
  error: string | null;
  requestsInProgress: number;
  lastUsedAt: number | null;
};

type LocalServer = {
  url: string;
  port: number;
  models: string[];
  failure: Promise<string>;
  status(): ModelStatus[];
  load(model: string): Promise<void>;
  unload(model: string): Promise<void>;
  cancel(model: string): Promise<void>;
  close(): Promise<void>;
};

function serve(
  models: (string | ServedModel)[],
  options?: ServeOptions,
): Promise<LocalServer>;
```

`serve` is `runServe` from `lib/cli/localServe.ts` with a smaller set of
options. `runServe` already returns a handle with `port`, `models`,
`failure`, and `close`. This spec adds `url`, `status`, `load`, `unload`,
and `cancel` to that handle.

- `port: 0` asks the operating system for a free port. `server.port` and
  `server.url` report the one it chose.
- `log` receives the lines the command prints to the terminal. The
  default discards them.
- A model given as a string is served with no options. It loads before
  `serve` resolves and stays loaded.
- `lazy` is described under "On-demand loading".
- `draft` and `draftTokens` are the command's `--draft` and
  `--draft-tokens`.
- `load` starts a model's process and resolves when it is ready. Use it
  to warm a model before the first request.
- `unload` stops a model's process. The next request for a lazy model
  starts it again. A model that is not lazy stays stopped until `load`.
- `cancel` is described under "Cancelling".

`serve` starts model processes with their output piped to `log`. The
command keeps printing to the terminal as it does today.

### Calling the server

```ts
type CallOptions = { baseUrl?: string; signal?: AbortSignal };
type ImageInput = string | Uint8Array;

function generateImage(options: CallOptions & {
  model: string;
  prompt: string;
  size?: string;
  steps?: number;
  guidance?: number;
  seed?: number;
  negativePrompt?: string;
  format?: "png" | "jpeg" | "webp";
  lora?: string;
  loraScale?: number;
  controlnet?: string;
  controlImage?: ImageInput;
  controlScale?: number;
  invertControlImage?: boolean;
  images?: ImageInput[];
  startImage?: ImageInput;
  strength?: number;
  mask?: ImageInput;
}): Promise<Result<{ bytes: Uint8Array; mimeType: string; seed: number | null }>>;

function detectObjects(options: CallOptions & {
  model: string; image: ImageInput; labels: string[]; threshold?: number;
}): Promise<Result<Detection[]>>;

function tagImage(options: CallOptions & {
  model: string; image: ImageInput; threshold?: number; limit?: number;
}): Promise<Result<Tag[]>>;
```

`captionImage`, `embedImage`, and `findRegions` follow the same shape.

`Result` is a plain type that the entry point defines and exports:

```ts
type Result<T> = { success: true; value: T } | { success: false; error: string };
```

It is not the runtime's result or smoltalk's. Both carry more, and
neither is part of this entry point.

Each function sends the same request its stdlib twin sends, and returns
the same value, with three differences.

1. **No interrupt.** The stdlib functions raise `std::readImage` or
   `std::vision` before reading a file. These functions read the file
   directly. See "Decisions" for why that is safe.
2. **An image can be bytes.** An `ImageInput` is a path or the image's
   bytes. The app holds its images in a database, so today it writes
   each one to a temporary folder for Agency to read back.
3. **The server address is an argument.** With no `baseUrl`, the function
   uses `mlxBaseUrl()`, which reads `client.baseUrl.mlx` and then
   `MLX_BASE_URL`.

There is no chat function. A chat or vision-language model served this
way answers the OpenAI chat API at `server.url`, so any OpenAI client
works.

### Where the code goes

The stdlib helpers in `lib/stdlib/mlxImage.ts` and `lib/stdlib/vision.ts`
each do two jobs today. They resolve and read the approved file, and they
send the request. Split each into two functions:

1. A request function that takes bytes, a server address, and a signal.
   It builds the body, sends it, and parses the reply.
2. The existing stdlib function, which reads the approved file and calls
   the request function.

`lib/local/public.ts` exports the request functions under the names
above, with a thin wrapper that reads a path into bytes. Add the entry to
`package.json`:

```json
"./local": {
  "types": "./dist/lib/local/public.d.ts",
  "import": "./dist/lib/local/public.js",
  "require": "./dist/lib/local/public.js"
}
```

The `./stdlib-lib/*` export stays. The stdlib's own compiled files import
their TypeScript helpers through it, and so do the sibling packages. Add
a sentence to `docs/site/guide/using-local-models.md` saying that
`stdlib-lib` is internal and that `agency-lang/local` is the supported
entry.

## 2. On-demand loading

```
agency local serve florence-2 --lazy z-image-turbo --lazy flux2-klein-9b
```

This command serves three models. `florence-2` loads before the port
opens and stays loaded until the command exits, as every model does
today. The two image models are lazy.

A lazy model differs from the others in two ways:

1. Its process starts on the first request that names it. That request
   waits until the model is ready.
2. The server may stop it to make room for another lazy model.

All three names appear in `GET /v1/models` as soon as the port opens.

`--lazy` takes one model name and can be given any number of times. It
names a model to serve, so a lazy model is not also written as a plain
argument. Naming a model both ways is an error:

```
z-image-turbo is named twice.
```

A lazy model is served as the kind recorded for it. To force a kind,
give the kind flag as well, such as `--vlm qwen3.5-9b --lazy qwen3.5-9b`.
That pairing is the one case where a name may appear twice.

### What a request does

The front door in `lib/cli/mlxServer.ts` keeps a record for each model:
its state, its process, its port, the number of requests in progress, and
the time of the last request. For each request:

1. Find the model's record. An unknown model gets the 404 it gets today.
2. If the state is `ready`, forward the request.
3. If the state is `loading`, wait for the load, then forward.
4. If the state is `stopped` or `failed`, start a load, wait for it, then
   forward.

### What a load does

Loads run one at a time, through a single queue. A load does this:

1. Estimate the memory the model needs. The estimate is the model's size
   on disk plus headroom: 4 GiB for an image model and 1 GiB for any
   other kind. A draft model's size is added to the model it drafts for.
2. Read the memory available now.
3. If the estimate plus a reserve is more than what is available, pick a
   model to stop. Candidates are lazy, are `ready`, and have no request
   in progress. Stop the one whose last request is oldest. Read the available memory again and repeat.
4. If no candidate is left and memory is still short, fail the load. The
   request gets a 503:

   ```
   Not enough memory to load flux2-klein-9b (needs about 22 GB, 9 GB available).
   Loaded now: z-image-turbo (busy), florence-2 (not lazy).
   ```

5. Otherwise start the process and wait with `waitUntilLoaded`, as
   `runServe` does today.

The reserve is the smaller of 2 GiB and 5% of total memory.

`AGENCY_ALLOW_MEMORY_OVERCOMMIT=1` skips step 4, for a machine where the
estimate is too cautious.

### Reading available memory

Add `availableMemory` to `ServeDeps`, next to `totalmem`, so tests can
supply a number.

- On macOS, run `vm_stat` and add the free, inactive, and speculative
  pages, multiplied by the page size.
- On Linux, read `MemAvailable` from `/proc/meminfo`.
- If either fails, use `os.freemem()`.

### With no lazy model

Nothing changes. Every model loads before the port opens. The front door
uses the same records, with every model starting in `ready`.

The memory warning counts only the models that are not lazy, because
those are the ones loaded together.

### Status

`GET /v1/agency/status` returns the same list as `server.status()`:

```json
{
  "models": [
    { "model": "z-image-turbo", "state": "ready", "error": null,
      "requestsInProgress": 1, "lastUsedAt": 1791234567890 },
    { "model": "florence-2", "state": "stopped", "error": null,
      "requestsInProgress": 0, "lastUsedAt": null }
  ]
}
```

`GET /v1/models` keeps listing every served model, loaded or not, because
callers use it to ask what they may request.

## 3. Cancelling

There are two ways to cancel, for two situations.

### The caller cancels its own call

```ts
const cancelButton = new AbortController();
const pending = generateImage({ model, prompt, signal: cancelButton.signal });
cancelButton.abort();
const result = await pending;   // a failure: "Cancelled"
```

Aborting the signal closes the connection to the front door. The front
door already closes its connection to the model process when a client
leaves.

What happens next depends on the kind of model:

| Kind | After the connection closes |
|---|---|
| image | Stops after the step in progress. |
| speech | Stops at the next check for a closed connection. |
| vision | A request waiting its turn is dropped. One that has started finishes, in a few seconds. |
| embedding | Finishes. A request takes under a second. |
| chat | Stops. Agency's chat server looks at the connection on a clock. |
| vision-language, streamed | Stops. |
| vision-language, not streamed | Keeps generating until the reply is complete. |

The last row is the one that costs the caller. `mlx_vlm.server` is an
upstream program, and it does not check for a closed connection during a
reply that is not streamed. A model asked for a long reply holds the GPU
after the caller has gone.

### Someone else cancels the work on a model

```ts
await server.cancel("qwen3.5-9b");
```

```
POST /v1/agency/cancel
{ "model": "qwen3.5-9b" }
```

`cancel` stops whatever is running on one model. It works like this:

1. Close the front door's connection to the model process for every
   request in progress on that model. Each caller gets a 499 with the
   message `Cancelled`.
2. If every closed request was one that stops or finishes quickly on its
   own, per the table above, return. The process is kept.
3. Otherwise stop the process. Today that is the last row of the table
   only. The next request for a lazy model starts it again. A model
   that is not lazy is started again before `cancel` returns.

Step 3 is slow, because the model has to load again. It is the only way
to stop a runtime that does not check for a closed connection.

A model with no request in progress is left alone, and `cancel` returns
straight away.

## 4. Shutting down

```ts
await server.close();
```

```
POST /v1/agency/shutdown
```

`close` exists today. It sends each process a signal and closes the
port without waiting. Change it to:

1. Stop accepting requests. A request that arrives now gets a 503.
2. Send SIGTERM to every model process.
3. Wait up to 5 seconds for them to exit.
4. Send SIGKILL to any that remain.
5. Close the port and resolve.

`POST /v1/agency/shutdown` answers 200 and then runs the same steps. The
`agency local serve` command then exits with status 0, as it does on
Ctrl-C.

### When the server dies first

If the Node process is killed with SIGKILL, it runs none of those steps,
and each Python process keeps its model in memory. Give every model
process a pipe on its standard input that the server never writes to.
When the server exits for any reason, the pipe closes.

`localServerCommon.py` gets a function that starts a thread which reads
standard input and calls `os._exit(0)` when the read returns. The chat,
embedding, image, speech, and vision server scripts call it at startup.

`mlx_vlm.server` is an upstream module that Agency runs with `python -m`.
Run it through a small Agency script instead, which starts the same
thread and then calls the module's entry point.

### Who may call the admin routes

The front door listens on `127.0.0.1` only. The three `/v1/agency/`
routes have the same reach as the routes that generate.

A web page open in a browser on the same machine can send a POST to a
local port. To refuse it, the two POST routes require the header
`content-type: application/json`. A page cannot send that header across
origins without a preflight request, and the front door answers no
preflight.

## What changes, in order

1. **The public entry.** Split the request functions out of
   `mlxImage.ts` and `vision.ts`. Add `lib/local/public.ts` with
   `listModels`, `serve`, and the call functions. Add the export. This
   step alone lets an app delete its `.agency` file and its internal
   imports.
2. **Signals.** Thread `signal` through the request functions and
   combine it with the timeout each already sets.
3. **Model records in the front door.** Replace the fixed `Route[]` with
   per-model records, with no change in behavior. Add `status`, `load`,
   `unload`, and `GET /v1/agency/status`.
4. **`--lazy`.** Add the flag, `availableMemory`, the load queue, and
   eviction.
5. **`cancel`** and `POST /v1/agency/cancel`.
6. **Shutting down.** The new `close`, `POST /v1/agency/shutdown`, and
   the standard-input pipe.

Docs to update: `docs/site/guide/using-local-models.md`,
`docs/site/cli/local.md`, `docs/dev/llm/mlx-local-models.md`,
`docs/dev/llm/local-images.md`, and `docs/dev/llm/local-vision.md`. Add
`docs/dev/llm/local-typescript-api.md` for the entry point, and list it
in `CLAUDE.md` and the `agency-llm-docs` skill.

## Testing

`runServe` takes its dependencies as an argument, and the existing tests
in `lib/cli/localServe.test.ts` use fake processes. The new behavior uses
the same fakes.

1. **Lazy start.** No process is spawned for a lazy model until a
   request names it. A model that is not lazy is spawned at startup. Two requests for a model that is loading spawn one
   process.
2. **Eviction.** With a fake `availableMemory`, a load stops the model
   whose last request is oldest. It never stops a model with a request in
   progress or a model that is not lazy.
3. **Refusal.** When nothing can be stopped, the request gets the 503 and
   no process is spawned.
4. **Cancel.** `cancel` on an image model closes the connection and keeps
   the process. `cancel` on a vision-language model with a non-streamed
   request stops the process.
5. **Close.** A fake process that ignores SIGTERM is sent SIGKILL after
   the wait.
6. **The public functions.** Each call function sends the body its
   stdlib twin sends. Run both against a fake server and compare.
7. **The pipe.** One test starts the real image server script with a
   stub model path, closes its standard input, and checks that the
   process exits.

## Decisions

**The public call functions raise no interrupts.** An interrupt lets a
person refuse an action a model chose. A TypeScript program that calls
`tagImage` chose the image itself. A program that wants approvals writes
Agency code and calls `std::vision`.

**The stdlib functions get no server address parameter.**
`generateImageLocal` promises that the picture never leaves the machine.
A `baseUrl` argument would let a model that calls the function as a tool
send the picture to any host. The address stays in `agency.json` and the
environment, which the person running the program controls. One
server on one port removes the need to switch addresses per call.

**Staying loaded is the default, and there is no `--keep`.** A model
is lazy or it is not. A model that is not lazy loads at startup and is
never stopped to make room. A third setting, a lazy model that is never
stopped once loaded, has no user yet.

**`--lazy` takes a model name.** A flag followed by its argument is the
order every other flag uses. `--draft` keeps its current form in this
spec; see "Not in this spec".

**The front door owns loading and eviction.** It already sits in front of
one process per model and sees every request. A program in any language
gets the behavior by pointing at one port.

**A load that does not fit fails at once.** It does not wait for a busy
model to finish. A caller that wants to wait can retry, and a fixed rule
is easier to test and to explain in the error message.

**`cancel` takes a model.** It does not take a request id. A model
process runs one generation at a time, so naming the model names the
work. Request ids would need a header on every request and a table of
requests in progress.

**`./stdlib-lib/*` stays exported.** Removing it would mean moving 39
stdlib files and the sibling packages to another import path. The new
entry gives outside programs a supported path, which is the part that was
missing.

## Not in this spec

- **Stopping a model when memory runs low during a request.** Mark Cut
  Paste polls available memory while a job runs and stops the model if
  the reserve is breached. A program can do the same with
  `server.unload`.
- **Stopping a model after it has been idle for some time.** Eviction
  here happens only when another model needs the room.
- **Running one request at a time across all models.** Each model process
  already runs one generation at a time. Two models can still generate at
  once.
- **What each image family can do.** The app keeps its own table of which
  families take a start image, a ControlNet, or guidance. The matching
  table in Agency lives in the Python image server. Exposing it to
  TypeScript is a separate change. `family` on `LocalModel` is enough for
  the app's table to key on.
- **A file that says what to serve.** Each model can now carry three
  settings: lazy, a draft model, and the draft's token count. `--draft`
  attaches to the model written before it, which no other flag does.
  Flags are a poor fit once a model has several settings. A list of
  `ServedModel` objects in `agency.json`, read by `agency local serve`,
  would say the same thing the TypeScript API already takes. That is a
  separate change, and `--draft` should move with it.
- **Downloading models from TypeScript.** `agency local download` stays
  the way to get a model.
- **Changes to Mark Cut Paste.** Moving the app onto this API is a
  change in that repository.
