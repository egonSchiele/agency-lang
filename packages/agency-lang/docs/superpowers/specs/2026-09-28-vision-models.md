# `std::vision`: object detection, tagging, and captions from a model on this machine

Depends on `2026-09-28-local-models-dx.md`: the `vision` kind, the
kind-based `serve`, and the adapters folder. This spec is the fifth kind
itself: which models, what the server answers, what the stdlib exposes,
and how the pieces compose into a labeling pipeline without any one
function knowing about the pipeline.

## What this adds

1. A `vision` server script, `lib/cli/visionServer.py`, one process per
   model behind the front door, with a family table like the image
   server's. Two families to start: the WD14 tagger (ONNX, no torch) and
   Florence-2 (transformers).
2. Three routes: `/v1/vision/detections`, `/v1/vision/tags`,
   `/v1/vision/captions`. A model answers the routes its family lists.
3. `std::vision` with three functions over those routes, `detectObjects`,
   `tagImage`, and `captionImage`, each returning a `Result`, each raising
   one effect for the image it reads.
4. Three pixel functions in `std::image`, `cropImage`, `imageSize`, and
   `pasteImages`, which need no model. The first turns a box into a
   training example; the last makes a contact sheet or a before-and-after
   pair.
5. Catalog entries for the two models, and the `vision` row in the kind
   inference table.

## Why small functions rather than one pipeline

The goal that motivated this is "turn a folder of comic pages into labeled
crops for training." The temptation is one `buildTrainingSet(pages, out)`
function. It would be used once. The same three operations, detect,
crop, and tag, are also what a person needs to find every panel with a
character in it, to pull a reference sheet out of a sketchbook, to check
whether a generated image actually contains what was asked for, or to
caption a folder for search. So each is its own function with one job,
a `Result`, and named arguments with defaults, and the pipeline is
twelve lines of Agency the user writes and owns:

    import { detectObjects, tagImage } from "std::vision"
    import { cropImage } from "std::image"
    import { glob, write } from "std::shell"

    node main() {
      const pages = glob("*.png", "./comics") with approve
      for (page in pages) {
        const found = detectObjects(page, ["person", "desk", "chair"], "florence-2") catch []
        for (hit in found) {
          const out = "./dataset/${hit.label}_${hit.id}.png"
          cropImage(page, hit.box, out, pad: 0.05)
          const tags = tagImage(out, "wd14-tagger") catch []
          write("${out}.txt", tags.join(", "))
        }
      }
    }

Every call in it is a tool the model could also be handed on its own,
and partial application narrows each one: `detectObjects.partial(labels:
["person"], model: "florence-2")` is a person-finder; `cropImage.partial(
outDir: "./dataset")` can only write there.

## The models

| Catalog name | Repo | Kind | Engine | Size | License | Routes |
|---|---|---|---|---|---|---|
| `wd14-tagger` | `SmilingWolf/wd-eva02-large-tagger-v3` | vision | onnxruntime | 1.2 GB | apache-2.0 | tags |
| `florence-2` | `microsoft/Florence-2-large` | vision | transformers | 1.5 GB | mit | detections, tags, captions |

Both run on the CPU or the GPU, both are permissive, and both are
natively supported by their engine, so `trust_remote_code` stays off.
The tagger was measured in the spike: 583 drawings in six minutes on the
CPU. Florence-2 is the open-vocabulary detector: it takes the label list
as text, so "desk" and "bookcase" need no training.

Grounding DINO and OWLv2 are stronger detectors on odd inputs like line
art and are also native to transformers. They are the next two rows,
added the same way, once Florence-2's results on real comics are seen.
A vision-language chat model such as Qwen3-VL is `chat`, not `vision`,
per the DX spec; a caller who wants its grounding parses its text.

## The server

`visionServer.py` follows `diffusersImageServer.py` in every property
that doc lists: bound to `127.0.0.1`, one model per process chosen at
start, a family table that decides what is imported (`_class_name` or
the ONNX file plus `selected_tags.csv`), `HF_HUB_OFFLINE=1` before any
import, `use_safetensors`, a 64 KB request body, and a rules module
`visionRules.py` with no torch import so CI tests it with `python3`.

**Images are named, not sent.** A request carries the image's path, not
its bytes. The body cap is 64 KB and a page is megabytes; more to the
point, the stdlib function has already raised an effect naming that
exact path, and the server reading it is the same read the approver saw.
The server refuses a path that is not an absolute path to a regular
file, refuses a symlink, and reads the file once through a descriptor.
It never lists a directory and never writes.

The routes, all `POST`, all taking `{"model", "image", ...}`:

| Route | Extra fields | Reply |
|---|---|---|
| `/v1/vision/detections` | `labels: string[]`, `threshold?` | `{"detections": [{"label", "score", "box": {x, y, width, height}}]}` |
| `/v1/vision/tags` | `threshold?`, `limit?` | `{"tags": [{"tag", "score"}]}` |
| `/v1/vision/captions` | `detail?: "short" \| "long"` | `{"caption": string}` |

Boxes are normalized to 0..1 with the origin at the top left, the same
`BoundingBox` shape `std::ocr` already returns, so a box from either can
go to `cropImage`. Scores are 0..1. A model that does not answer a route
gets a 404 from the front door naming the routes it does answer, as a
model that is not served does today.

`GET /health` answers `{"status": "ok", "routes": [...]}`, and `serve`
waits on it as it does for an image process.

## The stdlib

```
effect std::vision { dir: string, filename: string, task: string, model: string }

export type Detection = { id: number, label: string, score: number, box: BoundingBox }
export type Tag = { tag: string, score: number }

export def detectObjects(
  path: string,
  labels: string[],
  model: string,
  threshold: number = 0.3,
): Result<Detection[]> raises <std::vision>

export def tagImage(
  path: string,
  model: string,
  threshold: number = 0.35,
  limit: number = 30,
): Result<Tag[]> raises <std::vision>

export def captionImage(
  path: string,
  model: string,
  detail: string = "short",
): Result<string> raises <std::vision>
```

One effect, `std::vision`, tagged `@alwaysUnder(dir)`, because all three
functions do the same thing to the file: read it once and hand it to a
local model. The payload names the task and the model so a policy can
approve tagging under `./dataset` and nothing else, and so the prompt a
person sees says what will happen. It is one effect rather than three
because an approver who allows a local model to look at an image has
allowed the thing that matters; which question is asked of it is in the
payload for the curious, not a second permission.

Each function follows `readTextBlocks` in `std::ocr` exactly: resolve the
path with `_realTarget` before the interrupt, put its real `dir` and
`filename` in the payload, and after approval pass the same spelling to
the TypeScript helper, which re-validates it with `_approvedFilePath`
and sends the request through the `mlx` base URL. A model that is not a
`vision` model is refused before any request, with the serve command in
the message, as `generateImageLocal` refuses a chat model. The
detection `id` is the index in the reply, so a caller can name crops
without inventing names.

`labels` is required, not defaulted to "anything": an open-vocabulary
detector with no labels returns whatever it likes, and a training set
built from that is noise. A caller who wants everything says so with a
long list.

Every function is `idempotent`: reading an image and asking a local
model about it is safe to repeat.

## `cropImage`, `imageSize`, and `pasteImages` in `std::image`

```
effect std::cropImage { dir: string, filename: string, outDir: string, outFilename: string }

export def cropImage(
  path: string,
  box: BoundingBox,
  outPath: string,
  pad: number = 0,
  square: boolean = false,
  outDir: string = "",
): Result<string> raises <std::cropImage>

export idempotent def imageSize(path: string): Result<{ width: number, height: number }> raises <std::readImage>

effect std::pasteImages { files: string[], outDir: string, outFilename: string }

export def pasteImages(
  paths: string[],
  outPath: string,
  columns: number = 2,
): Result<string> raises <std::pasteImages>
```

`cropImage` reads one image, cuts the box out, and writes it to
`outPath`, returning the real path written. `pad` grows the box by that
fraction of its size on every side, clamped to the image, because a
detector's box is tight and a training crop wants a margin. `square`
pads the crop to a square with the image's edge color, which is what the
spike's trainer wants and what a padded wide drawing needs. `outDir`,
when given, is a directory `outPath` must be inside, in the shape of
`allowedPaths` elsewhere; it exists so `cropImage.partial(outDir:
"./dataset")` is a tool that can only write there.

One effect carrying both the source and the destination, both as real
spellings, since one approval is for "read this, write that". An
existing output file is never overwritten; a caller who wants that
removes it first with `remove`, whose own effect says so.

`pasteImages` lays the inputs out in rows of `columns` on a white
canvas, each at its own size in a cell the size of the largest, and
writes one image. Two images side by side is a before-and-after; a
folder in rows of eight is a contact sheet for choosing a training set.
Its effect lists every input's real path in `files`, as `applyPatch`
lists the files a patch touches, and the output.

The pixel work runs in Python, not Node. The core package has no image
library and, per `supply-chain.md`, should not gain a native one for a
crop. Pillow is already in the Python environment every local model
needs. `lib/cli/imageTools.py` is a one-shot script with three commands,
`crop`, `size`, and `paste`, run through the same Python `serve` chooses,
`HF_HUB_OFFLINE` set, taking its arguments on the command line and
answering one JSON line. It imports Pillow and nothing else. A missing
Python gives the same install hint `generateImageLocal` gives. Starting
an interpreter costs about a tenth of a second per crop, which is fine
for hundreds and would be wrong for a video; a video is not this spec.

## What `serve` and the catalog learn

- `vision` joins `ServeKind`, with `MODULES_FOR_KIND.vision = ["onnxruntime"]`
  for the tagger family and `["torch", "transformers"]` for Florence-2.
  Which modules are checked depends on the family of the model planned,
  read from its files, so a tagger-only user installs no torch.
- The kind inference table gains the `vision` row from the DX spec: a
  `config.json` whose `architectures` names a class in the vision family
  table, or `model.onnx` beside `selected_tags.csv`.
- The catalog gains the two rows above with `kind: "vision"`.
- `pip install onnxruntime==<pinned>` joins the setup hint. onnxruntime
  sends no telemetry on macOS or Linux; the Windows build has an opt-in
  ETW trace, which is off.
- The front door logs a vision reply by its count: `3 detections`, `24
  tags`, `1 caption`.

## Tests

- `visionRules.py` through `python3` in `visionServer.test.ts`, as the
  image rules are: the family table against the real `config.json` of
  each model (checked in as fixtures), every refusal message, the path
  rules (relative, symlink, directory, missing), and the routes each
  family lists.
- `std::vision` against a stand-in HTTP server in `vision.test.ts`, as
  `image.test.ts` does for images: the request body per function, the
  effect payload, the refusal of a non-vision model, and the 404 wording.
- `cropImage` and `imageSize` against real PNGs in a temp directory: the
  crop geometry with and without `pad` and `square`, the refusal to
  overwrite, `outDir` containment, and the symlink refusals from the
  contained-files battery.
- An opt-in live test like `diffusersImageServer.live.test.ts`, gated on
  a model directory and a Python, that tags one fixture drawing and
  detects one object in it.
- An Agency test under `tests/agency/` for the labeling loop above, with
  the model calls answered by a stand-in so it runs without a model.

## Not in this spec

- Segmentation masks, keypoints, and pose estimation. Pose comes up for
  ControlNet (its own addendum), and a pose ControlNet takes a rendered
  skeleton image, which a person can draw; a pose *estimator* that makes
  one from a photo is a fourth route, later.
- Training a detector. The bootstrapping path, label with Florence-2,
  fix, train RT-DETR, is a `packages/` concern and needs this spec first.
- Video.
