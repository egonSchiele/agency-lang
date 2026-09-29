# Local vision models: `std::vision` and the vision server

`agency local serve wd14-tagger florence-2` starts one process per model
with `lib/cli/visionServer.py`, behind the same front door as chat, speech,
and images. Agency code asks them about an image through `std::vision`:

    import { detectObjects, tagImage, captionImage } from "std::vision"

    node main() {
      const found = detectObjects("page.png", ["person", "desk"], "florence-2") with approve
      const tags = tagImage("page.png", "wd14-tagger") with approve
      const caption = captionImage("page.png", "florence-2", detail: "long") with approve
    }

The spec is `docs/superpowers/specs/2026-09-28-vision-models.md`. This doc
is what shipped and why.

## The models

| Catalog name | Repo | Kind | Engine | Download | Routes |
|---|---|---|---|---|---|
| `wd14-tagger` | `SmilingWolf/wd-eva02-large-tagger-v3` | vision | onnxruntime, CPU | 1.3 GB | tags |
| `florence-2` | `florence-community/Florence-2-large` | vision | transformers, GPU | 1.6 GB | detections, tags, captions |

Both are catalogued with an `mlx:` URI, because that is how every served
repo is named and downloaded; the kind, not the backend, picks the
server. `visionFiles` in `lib/stdlib/visionFiles.ts` cuts a vision
download to what the server reads: the WD14 repo ships the same weights
as `.onnx`, `.safetensors`, and `.msgpack`, and only the first is kept.
Florence-2 is the community conversion, which transformers 5.17 loads
with its own `Florence2ForConditionalGeneration`; the original
`microsoft/Florence-2-large` ships a `modeling_florence2.py`, which is
remote code and is never run.

## The kind

A directory is a vision model when `model.onnx` sits beside
`selected_tags.csv`, or when `config.json`'s first architecture is in
`VISION_ARCHITECTURES` (`modelKind.ts`). That rule comes before the chat
rule, because Florence-2's class ends in `ForConditionalGeneration` the
way a chat model's does. A test keeps `VISION_ARCHITECTURES` and
`VISION_ONNX_FILES` equal to what `visionRules.py` identifies.

Which Python modules a vision process needs depends on its family, not
its kind: `modulesFor` in `localServe.ts` reads the directory and asks
for `onnxruntime` alone for a tagger, or `torch` and `transformers` for
Florence-2, so a tagger-only user installs no torch.

## The server

`visionServer.py` has the properties `local-images.md` lists for the
image server: bound to `127.0.0.1`, one model per process chosen at
start, a family table that decides what is imported, `HF_HUB_OFFLINE=1`
before any import, `use_safetensors`, no `trust_remote_code`, a 64 KB
request body, one request at a time under a lock, and a warm-up before
the port opens. The rules are in `visionRules.py`, which imports nothing
from torch or onnxruntime, so `visionServer.test.ts` runs them with
`python3`.

The family table is flat, one key per value. Each row names a runner
class, `Wd14Runner` or `Florence2Runner`, and the routes it answers. A
runner has one method per route it lists and nothing else; the handler
dispatches by route name after `check_request` confirmed the family
lists it. No route method asks which family it is.

The routes, all `POST`, all taking `{"model", "image", ...}`:

| Route | Extra fields | Reply |
|---|---|---|
| `/v1/vision/detections` | `labels` (1 to 50), `threshold` | `{"detections": [{"label", "score", "box"}]}` |
| `/v1/vision/tags` | `threshold`, `limit` (1 to 500) | `{"tags": [{"tag", "score"}]}` |
| `/v1/vision/captions` | `detail`: `short` or `long` | `{"caption": "..."}` |

Boxes are normalized to 0..1 with the origin at the top left, the shape
`std::ocr` returns, so a box from either goes to `cropImage`. Florence-2
gives no scores, so its detections and tags score 1. A route the family
does not answer is a 404 naming the ones it does; `GET /health` lists
them, and `serve` waits on it as it does for an image process.

**Images are named, not sent.** A request carries the image's absolute
path. `check_image_path` in `localServerCommon.py` refuses a relative
path, a symlink at any component, a directory, a missing file, an
extension that is not an image, and a file over 50 MB, and
`read_image_bytes` opens what passed with `O_NOFOLLOW`. The stdlib sends
the real spelling it raised an effect for, so the server reading it is
the same read the approver saw. The server never lists a directory and
never writes. macOS's `/tmp` and `/var` are symlinks, which is why a
test that hands the server a temp path realpaths it first, as the
stdlib does.

## The stdlib

`std::vision` has one effect, `std::vision`, tagged `@alwaysUnder(dir)`,
with `dir`, `filename`, `task`, and `model`. All three functions do the
same thing to the file, read it once and hand it to a local model, so
one permission covers them; the task and model are in the payload for a
policy that wants to allow tagging under `./dataset` and nothing else.
Each function follows `readTextBlocks` in `std::ocr`: `_realTarget`
before the interrupt, the real `dir` and `filename` in the payload, and
`_approvedFilePath` on that spelling after approval, in `vision.ts`.

`vision.ts` is one HTTP call, `visionRequest`, behind three thin exports.
It refuses a model whose kind is known and is not `vision` before any
request (`_localModelKindOf` in `localModels.ts`), and lets the front
door's 404 speak for a model that is not served. `labels` is required on
`detectObjects`: a detector with no labels returns whatever it likes.
Every function is `idempotent`. The detection `id` is its index in the
reply, so crops can be named after it.

## `cropImage`, `imageSize`, and `pasteImages`

Three pixel functions in `std::image` that take no model. They are what
turns a box into a training example, and a folder into a contact sheet.
The pixel work runs in `lib/cli/imageTools.py`, a one-shot script over
Pillow, through the Python `serve` uses (`configuredPython` in
`localPython.ts`, the same order `serve` resolves it in). The core
package has no image library and, per `supply-chain.md`, does not gain a
native one for a crop; Pillow is already in the environment every local
model needs. Each command is a function of its arguments returning one
dict, and `main` is a table lookup, so adding one is a row.

`cropImage` raises `std::cropImage` with both real paths, since one
approval is "read this, write that"; `pasteImages` raises
`std::pasteImages` with every input in `files`, as `applyPatch` lists
the files it touches. Output files are created with mode `x`, so an
existing file is refused, never overwritten. `imageSize` raises
`std::readImage`, the effect for reading an image's bytes, because that
is what it does.

## Why small functions

The goal that motivated this is labeling a folder of comic pages for
training. One `buildTrainingSet` function would be used once. Detect,
crop, and tag are also what a person needs to find every panel with a
character, to pull a reference sheet from a sketchbook, or to check a
generated image. So each is one function with one job and a `Result`,
the pipeline is a dozen lines of the user's own code, and partial
application narrows each: `detectObjects.partial(labels: ["person"],
model: "florence-2")` is a person-finder.

## Tests

- `visionServer.test.ts` runs the rules module with `python3`: the
  families, every refusal, the path rules against real files and
  symlinks in a temp directory, the version pins, and the warm-up.
- `vision.test.ts` drives the three helpers against a stand-in HTTP
  server: the body per function, the numbering, the refusals of a model
  of another kind and of a symlinked image, and the no-server message.
- `imageTools.test.ts` runs the real script against PNGs it makes with
  the same Pillow, skipped where that Python is not there.
- `visionFiles.test.ts`, the kind rules in `modelKind.test.ts`, the serve
  test that starts a tagger and a Florence-2 with the right imports, and
  the log summary in `serveLog.test.ts`.
- `tests/agency/vision.agency` checks the effect's payload with a
  handler that rejects, so it runs with no model.

## Timings

On an M5 Ultra, the WD14 tagger answers a 2000×2400 drawing in about 0.5
s on the CPU, and loads in 2 s. That run went through the whole path:
`agency local serve wd14-tagger` on a Hugging Face cache copy, and an
Agency program calling `imageSize`, `tagImage`, `cropImage`,
`pasteImages`, and a refused `tagImage` on an image model. Florence-2 has
not been timed here yet.

## Not here yet

An opt-in live test like `diffusersImageServer.live.test.ts`, Florence-2
timings, Grounding DINO and OWLv2 as detector families, and a pose
estimator for the ControlNet spec.
