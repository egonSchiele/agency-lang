# Local models from TypeScript: `agency-lang/local`

`agency-lang/local` is the entry point for a TypeScript program that uses
local models and has no Agency code. It lists the models downloaded to
the machine and calls the server `agency local serve` runs:

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

The spec is `docs/superpowers/specs/2026-10-05-local-models-from-typescript.md`.

## Source files

| File | Responsibility |
|---|---|
| `lib/local/public.ts` | What the entry point exports |
| `lib/local/result.ts` | The `Result` type every call returns |
| `lib/local/models.ts` | `listModels` |
| `lib/local/calls.ts` | `generateImage` and the five vision functions |
| `lib/stdlib/localRequest.ts` | `postLocalJson`, the one function that posts to the local server |
| `lib/stdlib/mlxImage.ts` | The image request: its checks, its body, and its post |
| `lib/stdlib/vision.ts` | The vision request: its model check, its post, and its answer |
| `lib/stdlib/localImageInputs.ts` | Which input images go together, and an input as base64 |

The `./local` entry in `package.json` points at `lib/local/public.ts`.
The `./stdlib-lib/*` export is for the stdlib's own compiled files. Its
file and function names are not a public API.

## One request, two callers

Each call function is the twin of a stdlib function: `generateImage` of
`generateImageLocal` in `std::image`, and `tagImage` of `tagImage` in
`std::vision`. A twin must send the same request, so both go through the
same functions:

| Step | Stdlib | `agency-lang/local` |
|---|---|---|
| Decide which input images go together | `localImageMode` | `localImageMode` |
| Read an input image | `approvedFileBytes`, after a `std::readImage` approval | `encodedImageInput`, with no approval |
| Build the image request body | `localImageBody`, called by the `mlx` provider | `localImageBody` |
| Post the image request | `postLocalImage`, called by the `mlx` provider | `postLocalImage` |
| Check a vision model | `checkVisionModel` | `checkVisionModel` |
| Post a vision request | `postVisionRequest` | `postVisionRequest` |
| Shape a vision answer | `visionAnswer` | `visionAnswer` |

The stdlib's image request goes through smoltalk, where usage
accounting, the `imageGeneration` statelog event, and guards are
applied. All of that needs a run. A plain TypeScript caller has no run,
so `generateImage` calls `postLocalImage` directly.

When you change a request, change the shared function. Tests in
`lib/local/calls.test.ts` and `lib/stdlib/image.test.ts` run each stdlib
function and its twin against a fake server and compare the two request
bodies.

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

Do not add an address parameter to the stdlib functions.
`generateImageLocal` promises that the picture never leaves the machine.
Every Agency function is a tool a model can call, so an address
parameter would let a model send the picture to any host. The address
stays in `agency.json` and the environment, which the person running the
program controls.

**It takes a signal.** Aborting it ends the call with the failure
`Cancelled`. `postLocalJson` checks whether the caller aborted in two
places: when the fetch fails, and when reading the reply's body fails.
An abort during the body would otherwise be reported as "a body that is
not JSON".

**Its failures carry its own name.** `localImageMode` and
`encodedImageInput` take the caller's name, so the same refusal reads
`generateImage failed: ...` from the public function and
`generateImageLocal failed: ...` from the stdlib.

## The result type

Every call returns `Result<T>` from `lib/local/result.ts`:

```ts
type Result<T> = { success: true; value: T } | { success: false; error: string };
```

The runtime's `ResultValue` and smoltalk's result are not exported from
this entry point. The shared request functions return `{ error }` or a
value, and `calls.ts` turns that into a `Result`.

## Defaults stated twice

The stdlib's vision defaults are parameter defaults in
`stdlib/vision.agency`, such as `threshold: number = 0.35` on
`tagImage`. TypeScript cannot import them, so `calls.ts` states them
again in `VISION_DEFAULTS`. A test in `lib/local/calls.test.ts` reads
`vision.agency` and compares each default with the text of the matching
signature. Change a default in both places.

`generateImage` has no such table. A setting it leaves out is left out
of the request, and the server uses the model's own value.

## `listModels`

`listModels` returns every downloaded model. `agency local list` prints
these and also the catalog's models that are not downloaded, which
`listModels` leaves out.

- `directory` is the folder holding the model's files. For a Hugging
  Face cache folder, it is the snapshot folder.
- `family` is `_class_name` in `model_index.json`, or the first entry of
  `architectures` in `config.json`.
- `aliases` lists every alias in `agency.json` that points at the model,
  by URI or by path. An alias pinned to a revision, such as
  `mlx:org/repo@abc123`, is listed only under the download at that
  revision.

Three kinds of entry are listed and cannot be served: a GGUF file, a
ControlNet, and a download that is not complete. The call functions take
the `name` of every other entry.

## Checking against a real model

`scripts/checks/local-api-generate.mjs` calls `generateImage` and
`tagImage` from the built package and writes the picture to a folder.
It needs `make` first, and a server with both models:

```
agency local serve z-image-turbo wd14-tagger
node scripts/checks/local-api-generate.mjs
```
