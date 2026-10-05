# Local models from TypeScript: `agency-lang/local`

`agency-lang/local` is the entry point for a TypeScript program that uses
local models and has no Agency code. It lists the models on the machine
and calls the server `agency local serve` runs:

```ts
import { listModels, generateImage, tagImage } from "agency-lang/local";

const models = listModels();
const generated = await generateImage({
  model: "z-image-turbo",
  prompt: "a lighthouse in a storm",
});
if (generated.success) {
  const tags = await tagImage({ model: "wd14-tagger", image: generated.value.bytes });
}
```

The spec is `docs/superpowers/specs/2026-10-05-local-models-from-typescript.md`
and the plan is `docs/superpowers/plans/2026-10-05-local-models-from-typescript.md`.
This doc covers the first part, which has shipped: listing and calling.
Starting a server from TypeScript, on-demand loading, and cancelling a
model's work come in later parts of that plan.

## Source files

| File | Responsibility |
|---|---|
| `lib/local/public.ts` | What the entry point exports, and nothing else |
| `lib/local/result.ts` | The `Result` type every call returns |
| `lib/local/models.ts` | `listModels` |
| `lib/local/calls.ts` | `generateImage` and the five vision functions |
| `lib/stdlib/localRequest.ts` | `postLocalJson`, the one function that posts to the local server |
| `lib/stdlib/mlxImage.ts` | The image request: its checks, its body, and its post |
| `lib/stdlib/vision.ts` | The vision request: its model check, its post, and its answer |
| `lib/stdlib/localImageInputs.ts` | Which input images go together, and an input as base64 |

The `./local` entry in `package.json` points at `lib/local/public.ts`.

## Why it exists

Before this entry point, a TypeScript app that wanted a local image did
two things it should not have had to do.

1. It wrote an `.agency` file whose nodes each wrapped one stdlib call
   and approved the interrupt that call raised.
2. It imported `agency-lang/stdlib-lib/localModels.js` and called
   `_listDownloadedModels`. The `./stdlib-lib/*` export exists so that
   the stdlib's own compiled files can import their TypeScript helpers.
   No release promises those files or names to anyone else.

## One request, two callers

Each call function is the twin of a stdlib function: `generateImage` of
`generateImageLocal` in `std::image`, and `tagImage` of `tagImage` in
`std::vision`. A twin must send the same request. To make that hold,
each stdlib helper is split into the part only the stdlib needs and the
part both share.

| Step | Stdlib | `agency-lang/local` |
|---|---|---|
| Decide which input images go together | `localImageMode` | `localImageMode` |
| Read an input image | `approvedFileBytes`, after a `std::readImage` approval | `encodedImageInput`, with no approval |
| Build the image request body | `localImageBody`, called by the `mlx` provider | `localImageBody` |
| Post the image request | `postLocalImage`, called by the `mlx` provider | `postLocalImage` |
| Check a vision model | `checkVisionModel` | `checkVisionModel` |
| Post a vision request | `postVisionRequest` | `postVisionRequest` |
| Shape a vision answer | `visionAnswer` | `visionAnswer` |

The stdlib's image request goes through smoltalk, because that is where
usage accounting, the `imageGeneration` statelog event, and guards are
applied. All of that needs a run. A plain TypeScript caller has no run,
so `generateImage` calls `postLocalImage` directly.

Both posts end in `postLocalJson` in `lib/stdlib/localRequest.ts`. It
holds the one copy of the fetch, the timeout, and the wording of each
failure. The image provider and the vision helper each used to have
their own copy.

Tests hold the twins together. `lib/local/calls.test.ts` and
`lib/stdlib/image.test.ts` run a stdlib function and its twin against a
fake server and compare the two request bodies.

## What a twin does differently

**It raises no interrupt.** An interrupt lets a person refuse an action
a model chose. A TypeScript program that calls `tagImage` chose the
image itself. A program that wants approvals writes Agency code and
calls `std::vision`.

**It takes an image as a path or as bytes.** `encodedImageInput` handles
both. A path goes through the checks a stdlib input goes through: a file
on this machine, an image extension, a regular file, no symlink, and a
read through the contained-files module. Bytes are checked against the
field's size cap only. The server decides whether they are an image.

**It takes the server's address.** Every call takes `baseUrl`. With
none, it uses `mlxBaseUrl()`, which reads `client.baseUrl.mlx` and then
`MLX_BASE_URL`.

The stdlib functions take no address, and that is deliberate.
`generateImageLocal` promises that the picture never leaves the machine.
Every Agency function is a tool a model can call, so an address
parameter would let a model send the picture to any host. The address
stays in `agency.json` and the environment, which the person running the
program controls.

**It takes a signal.** Aborting it ends the call with the failure
`Cancelled`. `postLocalJson` joins the caller's signal with its own
timeout. It checks whether the caller aborted in two places: when the
fetch fails, and when reading the reply's body fails. An abort can land
in either, and without the second check an abort during the body reads
as "a body that is not JSON".

## Failure messages name the function called

The checks in `localImageInputs.ts` were written for `generateImageLocal`
and started every refusal with that name. `localImageMode` and
`encodedImageInput` now take the caller's name, so a refusal from the
public function reads `generateImage failed: mask goes with startImage,
and this call has none.`

## The result type

Every call returns `Result<T>` from `lib/local/result.ts`:

```ts
type Result<T> = { success: true; value: T } | { success: false; error: string };
```

It is a type of its own. The image provider uses smoltalk's result and
the vision helpers use the runtime's untyped `ResultValue`, which carries
fields for Agency's failure handling. Neither is exported here. The
shared request functions return `{ error }` or a value, and `calls.ts`
turns that into a `Result`.

## Defaults stated twice

The stdlib's vision defaults are parameter defaults in
`stdlib/vision.agency`, such as `threshold: number = 0.35` on
`tagImage`. TypeScript cannot import them, so `calls.ts` states them
again in `VISION_DEFAULTS`. A test in `lib/local/calls.test.ts` reads
`vision.agency` and compares each default with the text of the matching
signature. Change a default in both places.

`generateImage` has no such table. Every setting it leaves out is left
out of the request, and the server uses the model's own value.

## `listModels`

`listModels` returns what `agency local list` prints, as data. It wraps
`_listDownloadedModels`, `readModelAliases`, and `hubSnapshotDir`.

- `directory` is the folder holding the model's files. For a Hugging
  Face cache folder, it is the snapshot folder.
- `family` is `_class_name` in `model_index.json`, or the first entry of
  `architectures` in `config.json`. An app that keeps its own table of
  what each image family can do keys it on this.
- `aliases` lists every alias in `agency.json` that points at the model,
  by URI or by path.

Three kinds of entry are listed and cannot be served: a GGUF file, a
ControlNet, and a download that is not complete. `serve` and the call
functions take the `name` of every other entry. A test checks that each
of those names resolves with `_resolveModel`.

## Checking against a real model

`scripts/checks/local-api-generate.mjs` calls `generateImage` and
`tagImage` from the built package and writes the picture to a folder.
It needs `make` first, and a server with both models:

```
agency local serve z-image-turbo wd14-tagger
node scripts/checks/local-api-generate.mjs
```
