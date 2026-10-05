# Local vision models: `std::vision` and the vision server

`agency local serve wd14-tagger florence-2` starts one process per model
with `lib/cli/visionServer.py`, behind the same front door as chat, speech,
and images. Agency code asks them about an image through `std::vision`:

    import { detectObjects, tagImage, captionImage, findRegions, embedImage } from "std::vision"

    node main() {
      const found = detectObjects("page.png", ["person", "desk"], "florence-2") with approve
      const tags = tagImage("page.png", "wd14-tagger") with approve
      const caption = captionImage("page.png", "florence-2", detail: "long") with approve
      const regions = findRegions("page.png", "owlv2-base") with approve
      const vectors = embedImage("page.png", "dinov2-base") with approve
    }

The specs are `docs/superpowers/specs/2026-09-28-vision-models.md`, and
`docs/superpowers/specs/2026-09-30-vision-embeddings-and-owlv2.md` for
DINOv2, OWLv2, and the regions and embeddings routes. This doc is what
shipped and why.

## The models

| Catalog name | Repo | Kind | Engine | Download | Routes |
|---|---|---|---|---|---|
| `wd14-tagger` | `SmilingWolf/wd-eva02-large-tagger-v3` | vision | onnxruntime, CPU | 1.3 GB | tags |
| `florence-2` | `florence-community/Florence-2-large` | vision | transformers, GPU | 1.6 GB | detections, tags, captions, regions |
| `dinov2-base` | `facebook/dinov2-base` | vision | transformers, GPU | 346 MB | embeddings |
| `owlv2-base` | `google/owlv2-base-patch16-ensemble` | vision | transformers, GPU | 620 MB | detections, regions |

Both are catalogued with an `mlx:` URI, because that is how every served
repo is named and downloaded; the kind, not the backend, picks the
server. `visionFiles` in `lib/stdlib/visionFiles.ts` cuts a vision
download to what the server reads. The WD14 repo ships the same weights
as `.onnx`, `.safetensors`, and `.msgpack`. The server reads only the
`.onnx`, so a snapshot with `model.onnx` beside `selected_tags.csv`
keeps that file and drops the other two.
Florence-2 is the community conversion, which transformers 5.17 loads
with its own `Florence2ForConditionalGeneration`; the original
`microsoft/Florence-2-large` ships a `modeling_florence2.py`, which is
remote code and is never run.

## The kind

A directory is a vision model when `model.onnx` sits beside
`selected_tags.csv`, or when `config.json`'s first architecture is in
`VISION_ARCHITECTURES` (`modelKind.ts`). That rule comes before the chat
rule, because Florence-2's class ends in `ForConditionalGeneration` the
way a chat model's does. It also comes before the embedding rule, which
calls any class ending in `Model` a text embedding model: DINOv2's class
is `Dinov2Model`, and without the vision rule first `serve` would start
the MLX embedding server for it. A test keeps `VISION_ARCHITECTURES` and
`VISION_ONNX_FILES` equal to what `visionRules.py` identifies.

`VISION_ARCHITECTURES` is the keys of `VISION_FAMILIES`, which is all
TypeScript knows about each transformers family: `tryIt`, the
`std::vision` function the serve banner suggests for it. The banner
reads the served model's architecture from its `config.json` and falls
back to `tagImage` for the ONNX tagger, which has no config.

Which Python modules a vision process needs depends on its family, not
its kind: `modulesFor` in `localServe.ts` reads the directory and asks
for `onnxruntime` alone for a tagger, or `torch` and `transformers` for
the others, so a tagger-only user installs no torch.

## The server

`visionServer.py` has the properties `local-images.md` lists for the
image server: bound to `127.0.0.1`, one model per process chosen at
start, a family table that decides what is imported, `HF_HUB_OFFLINE=1`
before any import, `use_safetensors`, no `trust_remote_code`, a request body
of one image as base64 plus 64 KB, one request at a time under a lock, and a warm-up before
the port opens. The rules are in `visionRules.py`, which imports nothing
from torch or onnxruntime, so `visionServer.test.ts` runs them with
`python3`.

Each thing the server knows is described once, as a row in a table, and
the code that acts on a row is written once:

| What | Described in | Acted on by |
|---|---|---|
| A route | a row of `ROUTE_TABLE` in `visionRules.py`: its path, fields, and defaults | `check_request` |
| A request field | an entry of `FIELD_CHECKS` | the one function that checks it |
| A family | a row of `FAMILIES` | the runner class the row names |
| What to do with OWLv2's boxes | the arguments of `kept_boxes` | `kept_boxes` |
| A task, on the client | a row of `VISION_TASKS` in `vision.ts` | `visionCall`, and the serve log |
| A body limit at the front door | `bodyLimits` in `mlxServer.ts` | `bodyLimit` |

The family table is flat, one key per value. Each row names a runner
class, `Wd14Runner`, `Florence2Runner`, `Dinov2Runner`, or
`Owlv2Runner`, and the routes it answers. A runner has one method per
route it lists and nothing else; the handler dispatches by route name
after `check_request` confirmed the family lists it. No route method
asks which family it is. A family can carry its own default threshold
for a route, `default_threshold_<route>`, which wins over the route
row's: OWLv2's detections default to 0.1, because a real object often
scores 0.2 to 0.4, and Florence-2's to 0.3, which drops nothing, since
every Florence-2 box scores 1. A test checks that every family that
answers `detections` has one.

The routes, all `POST`, all taking `{"model", "image", ...}`, where
`image` is the image's bytes as base64:

| Route | Extra fields | Reply |
|---|---|---|
| `/v1/vision/detections` | `labels` (1 to 50), `threshold` | `{"detections": [{"label", "score", "box"}]}` |
| `/v1/vision/tags` | `threshold`, `limit` (1 to 500) | `{"tags": [{"tag", "score"}]}` |
| `/v1/vision/captions` | `detail`: `short` or `long` | `{"caption": "..."}` |
| `/v1/vision/embeddings` | `boxes`: 0 to 100 boxes, or null for the whole image | `{"embeddings": [[...], ...]}` |
| `/v1/vision/regions` | `threshold`, `limit` (1 to 100) | `{"regions": [{"score", "box"}]}` |

Boxes are normalized to 0..1 with the origin at the top left, the shape
`std::ocr` returns, so a box from either goes to `cropImage`. Florence-2
gives no scores, so its detections and tags score 1, and the
`threshold` of `detectObjects` drops nothing from it.

Florence-2's detection task takes one phrase: the prompt is "Locate
{phrase} in the image." Sent `"person, desk, chair"`, it looks for that
whole phrase and labels boxes with it. So `detections_of` runs the task
once per label, and labels each box with the label that was asked for,
not the text the model wrote back. Each label is one more generation,
which is why the docstring says each label adds to the time. A route the family
does not answer is a 404 naming the ones it does; `GET /health` lists
them, and `serve` waits on it as it does for an image process.

### DINOv2 and embeddings

`Dinov2Runner.embeddings_of` crops each box, scales the crop so its
longer side is 224 pixels, centers it on a 224×224 square in the color
the processor subtracts as its mean, and returns one 768-number vector
of length 1 per box. The model card's preprocessing resizes the short
side to 256 and cuts out the middle 224×224, which would cut the ends
off a long, thin object. The square keeps the whole object in view, so
the processor is called with `do_resize=False` and
`do_center_crop=False`. The padding color normalizes to zero, so it
carries no signal.

A picture is scaled before it is padded, here and in `Owlv2Runner`. The
pixel limit on a request is width times height, and a square padded
first has the longer side on both sides: a 1200×40000 screenshot passes
the limit and would then need a 40000×40000 square, 4.8 GB.
`fitted_size` in `visionRules.py` gives the scaled size, so no square is
larger than the model's input. `Wd14Runner._prepare` still pads first.

Each number of a vector is rounded to six places. A float32 holds about
seven digits and Python prints seventeen, so rounding halves the reply:
a hundred vectors are about 0.8 MB of JSON.

`_boxes_of` turns a missing or null `boxes` into one box over the whole
image, `WHOLE_IMAGE`, so the runner has one path. An empty list stays
empty and gets an empty reply, and the model does not run: a program
that found no mugs must get no vectors back, not the vector of the
whole photo. The processor turns an empty list into a tensor the model
cannot take, so `_embed` returns `[]` itself.

### OWLv2, regions, and `kept_boxes`

`Owlv2Runner` answers `detections` with every label in one pass,
unlike Florence-2, and `regions` from `model.objectness_predictor`: how
much each box looks like a thing of any kind, with no text run at all.
OWLv2 scores every one of its 3,600 boxes, and most hold nothing, so
`regions` has a threshold with a default of 0.1. On two test photos the
real things scored 0.23 and up, and 0.1 kept 8 or 9 regions of the best
50. Drawings have not been measured.
Its three torch methods return plain lists, scores and boxes as [x1,
y1, x2, y2] in 0..1 of the square the image was padded to. Everything
else is `kept_boxes` in `visionRules.py`, which CI tests without torch:
it drops boxes under the threshold, scales each box by the image's
longer side (OWLv2 pads on the bottom and the right, so that gives
pixels), clamps it with `normalized_box`, drops a box that lay wholly in
the padding, merges boxes that overlap a better one by more than 0.3
when asked, and stops at a limit. Detections keep overlapping boxes, as
transformers' own post-processing does; regions merge them.

Florence-2 answers `regions` too, through its `<REGION_PROPOSAL>` task,
with every region scoring 1.

### Processor classes are named, not looked up

The serve environment has neither torchvision nor scipy.
`AutoImageProcessor` picks a class that needs torchvision for DINOv2
and OWLv2, so the server would fail as it starts. `Dinov2Runner` loads
`BitImageProcessorPil` by name, and `Owlv2Runner` loads
`Owlv2ImageProcessorPil` and `CLIPTokenizer` by name. `AutoProcessor`
happens to fall back to the Pillow class when torchvision is missing,
but the family table, not a fallback, should decide what is imported.

`Owlv2ImageProcessorPil` also needs scipy for its resize, a Gaussian
blur and a linear zoom. `Owlv2Runner._pixel_values` resizes the image
and pads it with Pillow instead, and calls the processor with
`do_pad=False` and `do_resize=False`, so it only rescales and
normalizes. Its scores have not been compared with the scores through
the library's own resize.

### No search by example

OWLv2 can take a picture of a thing instead of its name, through
`image_guided_detection`. There is no route for it, because it failed
a test: with a remote as the example it ranked both cats in a photo
above both remotes, and boxes on nothing scored as high as real
matches. The spec has the test. A model that replaces it must pass it.

**Images are sent, not named.** A request carries the image's bytes as
base64, never a path. The stdlib raises `std::vision` for the file,
reads it after approval, and sends what it read. So the server opens no
file a request chose. Any local process can reach the port, and so can
an Agency program whose `fetch` to `127.0.0.1` was approved. With a
path in the request, either could have the server describe any image on
the machine without the user seeing a file prompt. With bytes, it can
describe only images it could already read. The adapters folder in
`local-images.md` follows the same rule.

`image_bytes_of` in `localServerCommon.py` refuses anything that is not
base64 of at most 50 MB, checking the length before decoding.
`visionServer.py` then decodes the bytes with Pillow, allowing only PNG,
JPEG, WebP, and GIF. It refuses an image over 100 million pixels, which
is a small file that would decode to a huge one. The body limit is the
base64 length of 50 MB plus 64 KB for the settings. `vision.ts` has the
same 50 MB limit in `MAX_IMAGE_BYTES`, and refuses a larger file before
reading it, and `visionBodyBytes()` there is the same body limit. Tests
keep both pairs equal. The server never lists a directory and never
writes.

The `serve` front door, `mlxServer.ts`, reads every request body before
it passes it on, and its default limit is 10 MB. `bodyLimits` gives each
vision path `visionBodyBytes()`, as it gives the image server's path its
own limit. A photo over about 7.5 MB is over 10 MB once it is base64,
so the default would refuse a photo the vision server takes.

### Adding a route

A new route is four things: a row in `ROUTE_TABLE`, with a checker in
`FIELD_CHECKS` for any new field; a row in `VISION_TASKS`; a
`<route>_of` method on each runner that answers it, with the route in
its family's `routes`; and a function in `vision.agency` in the shape
of the others. The front door, the routing in `localServe.ts`, and the
serve log all read `VISION_TASKS`, and a test checks the two tables name
the same routes.

## The stdlib

`std::vision` has one effect, `std::vision`, tagged `@alwaysUnder(dir)`,
with `dir`, `filename`, `task`, and `model`. All five functions do the
same thing to the file, read it once and hand it to a local model, so
one permission covers them; the task and model are in the payload for a
policy that wants to allow tagging under `./dataset` and nothing else.
Each function resolves its file with `_visionFile` before the
interrupt, raises `std::vision` with the real `dir` and `filename` in
the payload, and reads the file with `approvedFileBytes` after
approval, in `vision.ts`.
`approvedFileBytes` holds the spelling with `fixedPath`, so a symlink
planted while the prompt was pending is refused, and reads through
`readBytes` in `contained.ts`.

`vision.ts` is one HTTP call behind five thin exports, each one call to
`visionCall` with a row of `VISION_TASKS`. The call has three parts:
`checkVisionModel`, `postVisionRequest`, and `visionAnswer`. The
functions in `agency-lang/local` call the same three. See
`docs/dev/llm/local-typescript-api.md`. The row says
the route, the reply field that holds the answer, whether each item gets
an `id`, and how the serve log counts it. An embeddings reply is logged
by its size and never parsed: the log keeps the first megabyte of a
reply, and a hundred vectors can be more than that.
It refuses a model whose kind is known and is not `vision` before any
request (`_localModelKindOf` in `localModels.ts`), and lets the front
door's 404 speak for a model that is not served. `labels` is required on
`detectObjects`: a detector with no labels returns whatever it likes. Its
`threshold` is null by default, which the server reads as the family's
own default. Every function is `idempotent`. A detection's and a
region's `id` is its index in the reply, so crops can be named after it.

`embedImage` takes `boxes: BoundingBox[] | null`. Null embeds the whole
image and an empty list embeds nothing, for the reason above. Its
docstring says to compare embeddings only when both were cut the same
way: a whole photo of a mug on a desk and a tight crop of a mug do not
compare well, because the first vector mostly describes the desk. The
module doc comment has the whole method, with a worked example: box
everything, embed each box, and keep the boxes nearer crops of your own
things than crops of other things.

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
approval is "read this, write that". Its "approve always" answer pins
both folders with `@alwaysUnder(dir, outDir)`, as `std::copy` does. A
rule saved for one crop into `./crops` does not let a later crop read
from another folder. `pasteImages` raises `std::pasteImages` with every
input in `files`, as `applyPatch` lists the files it touches. Like
`applyPatch`, it has no "always" tag, because a list of files cannot be
pinned to one folder. It checks every path before the interrupt, so a
bad one fails before anyone is asked. Both effects are in the
`FileWrite` capability set, so `--reject FileWrite` refuses them.
`std::vision` is in `FileRead`. Output files are created with mode `x`, so an
existing file is refused, never overwritten. The arithmetic, where a
crop box lands and where each image goes on a paste canvas, is in
`imageToolsRules.py`, which imports no Pillow. `paste` reads each input's
size from its header first, and refuses a canvas over 100 million pixels
before allocating it. Pillow refuses an input over the same limit, and
its decompression-bomb error comes back as a failure message, not a
traceback. `imageSize` raises
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
  families, every refusal, the base64 and size rules, the limits the
  stdlib shares, the version pins, the warm-up, `kept_boxes` on
  hand-written boxes, and that `ROUTE_TABLE` and `VISION_TASKS` name the
  same routes. It runs each runner's route methods with a fake in place
  of its torch methods: one Florence-2 pass per label, OWLv2's labels
  and merging, and the region proposals. With the serve Python's
  Pillow, it checks the squares, that none is larger than the model's
  input however long the image, and which crops `Dinov2Runner` embeds.
- `vision.test.ts` drives the five helpers against a stand-in HTTP
  server: the body per function, null boxes and a null threshold sent
  as null, the numbering, the refusals of a model of another kind and
  of a symlinked image, and the no-server message.
- `mlxServer.test.ts` sends a 20 MB vision request through the front
  door, and one over the vision limit.
- `imageTools.test.ts` runs `imageToolsRules.py` with `python3`, so CI
  covers the crop box, the paste layout, and the canvas limit. It also
  runs the real script against PNGs it makes with the same Pillow,
  skipped where that Python is not there.
- `visionFiles.test.ts`, the kind rules in `modelKind.test.ts`, the serve
  test that starts a tagger and a Florence-2 with the right imports, the
  banner line for each family in `localServe.test.ts`, and the log
  summary in `serveLog.test.ts`.
- `tests/agency/vision.agency` and `tests/agency/imageEffects.agency`
  check the payloads of `std::vision`, `std::cropImage`,
  `std::pasteImages`, and `std::readImage` with a handler that rejects,
  so they run with no model and no Pillow.
- `alwaysTag.stdlib.test.ts` pins what "approve always" means for each
  of those effects.

## Timings

On an M5 Ultra, the WD14 tagger answers a 2000×2400 drawing in about 0.5
s on the CPU, and loads in 2 s. That run went through the whole path:
`agency local serve wd14-tagger` on a Hugging Face cache copy, and an
Agency program calling `imageSize`, `tagImage`, `cropImage`,
`pasteImages`, and a refused `tagImage` on an image model.

On the same machine, `agency local serve dinov2-base owlv2-base
florence-2` has the three ready in 2 s, 4 s, and 6 s, warm-up included.
On a 640×480 photo, OWLv2 detects two labels in 0.43 s and proposes
regions in 0.09 s, and DINOv2 embeds three crops in 0.25 s. An Agency program that detects,
crops, proposes regions, embeds them, and asks Florence-2 for regions
ran end to end in 2.6 s.

## What the embeddings have been measured on

One photo, of two cats and two remotes on a couch, with the boxes
`detectObjects` gave:

| Pair | Cosine similarity |
|---|---|
| the two cats | 0.55 |
| the two remotes | 0.57 |
| a cat and a remote | 0.19 to 0.26 |

So things of one kind scored well above things of different kinds.

Three things have not been measured:

1. The same object in two different photos, against a lookalike. This
   is the "my mug, not that mug" case, and nothing here supports it
   yet.
2. Pen-and-ink drawings, and white padding against gray on them.
3. How steady a small crop's vector is. The remotes are 135 and 32
   pixels wide. A change of under a pixel in how they were scaled moved
   their similarity from 0.66 to 0.57, while the cats stayed at 0.55.

## Not here yet

An opt-in live test like `diffusersImageServer.live.test.ts`, the
drawing half of the manual run in the DINOv2 and OWLv2 spec, a SigLIP
family if DINOv2 does poorly on drawings, Grounding DINO as a detector
family, and a pose estimator for the ControlNet spec.
