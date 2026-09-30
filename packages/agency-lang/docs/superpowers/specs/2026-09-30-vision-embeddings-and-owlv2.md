# `std::vision`: finding your own objects with DINOv2 and OWLv2

Builds on `2026-09-28-vision-models.md`, which added the vision server,
its family table, and `detectObjects`, `tagImage`, and `captionImage`.
This spec adds two model families to that server and two functions to
`std::vision`, so a program can find the things one person cares about
from a few examples of them.

## The problem

`detectObjects(photo, ["mug"], "florence-2")` finds things by the name
of their kind. That fails in two ways, and each has its own example.

**Confusion.** You have 20 photos of your own mug and want to find it
in other photos. The detector finds every mug. It cannot tell yours
from the one next to it, because it learned categories and not
individual objects.

**Misses.** You draw pen-and-ink illustrations, and the same cats
appear in many of them. The detector learned mostly from photos. Asked
for "cat" on one of your pages, it may return nothing, because your
cats are a few ink lines on white paper.

Two tools close these gaps without training a model:

1. **Compare.** Turn a region of an image into an embedding, a list of
   numbers that describes how it looks. Regions that look alike get
   embeddings that are close together. This needs an image embedding
   model: DINOv2. It fixes confusion.
2. **Box everything.** Ask a model for a box around every drawn or
   photographed thing, with no names at all, and let the comparison
   decide which boxes matter. OWLv2 and Florence-2 can both do this. It
   helps with misses.

The mug needs the first. The cats need the second and the first
together. "Putting it together" shows the code.

A third tool, searching by example, was tried and dropped. See
"Search by example, tried and dropped".

Fine-tuning a detector is left out on purpose; see "Not in this spec".

## What this adds

1. A DINOv2 family on the vision server, answering a new route,
   `/v1/vision/embeddings`.
2. An OWLv2 family, answering `/v1/vision/detections` and a new route,
   `/v1/vision/regions`.
3. `/v1/vision/regions` on Florence-2 as well.
4. `embedImage` and `findRegions` in `std::vision`.
5. A per-family default threshold for detections, and a nullable
   `threshold` on `detectObjects`, because OWLv2's scores run much lower
   than Florence-2's.
6. Catalog entries `dinov2-base` and `owlv2-base`, and both
   architectures in the kind rules.

## The models

| Catalog name | Repo | License | Download | Routes |
|---|---|---|---|---|
| `dinov2-base` | `facebook/dinov2-base` | Apache-2.0 | 346 MB | embeddings |
| `owlv2-base` | `google/owlv2-base-patch16-ensemble` | Apache-2.0 | 620 MB | detections, regions |

Both load with transformers 5.17, which the vision server already pins,
through `Dinov2Model` and `Owlv2ForObjectDetection`. Each runner names
its image processor class, the Pillow one, because the class
transformers picks by default needs torchvision, which `serve` does not
install. Neither needs
remote code. Both repos ship `model.safetensors` beside a
`pytorch_model.bin`. `visionFiles` already drops `.bin`, so each
download keeps one copy of the weights with no change there.

`modulesFor` in `localServe.ts` already asks for `torch` and
`transformers` for any vision model that is not the ONNX tagger, so
`serve` needs no change either.

Neither model reports usage to anyone. The weights are data, and the
server sets `HF_HUB_OFFLINE=1` before it imports anything, which also
turns off the Hugging Face library's telemetry.

DINOv2 was chosen over CLIP and SigLIP because it was trained on how
things look, and they were trained on captions. That makes it better at
telling one mug from another mug. CLIP is better at matching a picture
to words, which this spec does not need.

DINOv2 was chosen over DINOv3 because of the license. DINOv3's weights
are gated on Hugging Face and come under Meta's own DINOv3 License,
which asks for a legal review that Apache-2.0 does not. The catalog
holds only models anyone can download and use.

DINOv2 learned from photos, so how well it separates ink drawings is
not known. The manual run measures it. If it does poorly, SigLIP is the
next model to try, as another row answering the same route.

## The kind

Both architectures go into `VISION_ARCHITECTURES` in `modelKind.ts`.

This matters more for DINOv2 than it looks. Its architecture is
`Dinov2Model`, and the last rule in `KIND_RULES` calls any class ending
in `Model` a text embedding model. Without the vision entry, `serve`
would start the MLX embedding server for it, which cannot load it. The
vision rule runs before the embedding rule, so adding the name is
enough. The existing test that keeps `VISION_ARCHITECTURES` equal to
what `visionRules.py` identifies covers both.

## The server

### The family rows

Two rows join `FAMILIES` in `visionRules.py`:

```python
"Dinov2Model": {
    "label": "DINOv2",
    "engine": "transformers",
    "runner": "Dinov2Runner",
    "identify_architecture": "Dinov2Model",
    "routes": ["embeddings"],
},
"Owlv2ForObjectDetection": {
    "label": "OWLv2",
    "engine": "transformers",
    "runner": "Owlv2Runner",
    "identify_architecture": "Owlv2ForObjectDetection",
    "routes": ["detections", "regions"],
    "default_threshold_detections": 0.1,
},
```

The Florence-2 row gains three things: `"regions"` at the end of its
`routes`, `"task_regions": "<REGION_PROPOSAL>"`, and
`"default_threshold_detections": 0.3`.

`default_threshold_detections` replaces the route-wide
`DEFAULT_THRESHOLD["detections"]`. Florence-2 keeps 0.3, which drops
nothing, since every Florence-2 box scores 1. OWLv2's model card uses
0.1: a real object often scores 0.2 to 0.4, so 0.3 would drop many of
them. `_threshold_of` takes the family row as well as the route, so it
can read the key. A row that does not detect leaves the key out. A new
test checks that every row whose `routes` include `detections` has a
number there.

The default for `tags`, 0.35, is the same for every family, so it sits
in the route's row of the route table. A
family's own default, when it has one, wins over the route's.

The `family_of` error message names every family. It lists the
architectures from the table instead of spelling out Florence-2, so a
new row cannot leave it stale. The test that pins the message changes
with it.

`check_request` ends today in an `else` that means "captions", and a
route's path, fields, and defaults sit in four separate tables. With
three more routes, those become one table with a row per route: its
path, the fields it takes, and its defaults. Each field has one
function that checks it. `check_request` runs the checks for the
fields in the route's row, so a new route is a new row.

### `/v1/vision/embeddings`

| Field | Meaning |
|---|---|
| `image` | The image's bytes as base64, as on every route |
| `boxes` | Optional. 0 to 100 boxes, each `{x, y, width, height}` in 0..1, the shape `detectObjects` returns |

The reply is `{"embeddings": [[...], ...]}`. Without `boxes`, it holds
one list of 768 numbers for the whole image. With `boxes`, it holds one
list per box, in the order the boxes came. An empty `boxes` list gets
an empty reply and the model does not run.

`Dinov2Runner.embeddings_of` does this for each region:

1. Crop the box out of the decoded image. A box with no area is
   refused, naming its index.
2. Pad the crop to a square, centered, with the color the processor
   subtracts as its mean (ImageNet's mean, about `(124, 116, 104)`).
3. Run the processor with `do_center_crop=False` and a size of 224×224.
   The model card's settings resize the short side to 256 and then cut
   out the middle 224×224, which would cut the ends off a long, thin
   object. Padding first keeps the whole object in view.
4. Take `pooler_output`, the model's summary of the whole picture, and
   scale it to length 1. Two such vectors' cosine similarity is then
   their dot product, and `cosineSimilarity` in `std::embedding` gives
   the same answer either way.

The padding color in step 2 is gray, which suits photos. On a drawing
it puts two gray bars beside a crop of white paper. Every crop gets the
same bars, so they may not matter. The manual run compares gray with
white padding on drawings. A `padding` field is added only if the
results differ.

The regions of one request run as one batch under the lock.

### `/v1/vision/detections` on OWLv2

The same request and reply as Florence-2's. `Owlv2Runner.detections_of`
passes every label in one call, unlike Florence-2, which runs once per
label. So a long label list costs OWLv2 almost nothing extra, and the
docstring's warning about time per label becomes Florence-2's alone.

OWLv2's processor pads each image to a square, on the bottom and the
right, before it detects. The boxes the model returns are positions in
that square, from 0 to 1. Both OWLv2 routes get their boxes this way, so one plain Python function in `visionRules.py` finishes the job
for all of them:

1. Drop boxes scoring below the threshold.
2. Scale each box by the longer side of the image, which turns a
   position in the square into pixels.
3. Clamp each box to the image with `normalized_box`, as Florence-2's
   boxes are. A box that lay wholly in the padding has no area left,
   and is dropped.
4. Remove boxes that overlap a higher-scoring one, on the routes that
   ask for that.
5. Keep the best 100 at most.

For `detections`, the score of a box is the sigmoid of its best
label's logit, and the box takes that label. Overlapping boxes are
kept, as transformers' own post-processing keeps them. The runner does
not call `post_process_grounded_object_detection`: it does steps 1 and
2 and nothing else, and sharing the function above keeps every route's
boxes in one set of units.

### Search by example, tried and dropped

OWLv2 can take a picture of a thing instead of its name, through
`embed_image_query`, and find things that look like the picture. The
first version of this spec had a `/v1/vision/matches` route and a
`findByExample` function built on it. A measurement before building
them showed it does not work well enough to ship.

The test used two public COCO photos: two tabby cats and two TV remotes
on a couch, and a black-and-white cat on a laptop. Examples were crops
from one photo, searched for in the other, or in the same photo.

- With a crop of one remote as the example, OWLv2 ranked both cats
  above both remotes.
- Boxes on nothing at all scored 0.96 to 1.0 on every search, as high
  as the real matches, so no threshold could separate them.
- Transformers' own `image_guided_detection`, with its rescaled scores,
  made the same mistakes, so the problem is the model and not the
  runner.
- Centering each example on a square, the fix this spec had planned
  for wide examples, made the results worse.

Boxing everything and comparing the boxes with DINOv2 did the same job
on the same photos. With a crop of the left cat as the example, the
left cat's box scored 0.97 and the other cat's 0.57. With a remote as
the example, that remote scored 0.96 and the other remote 0.66. So the
second tool, not a third, answers "find this thing".

### `/v1/vision/regions`

| Field | Meaning |
|---|---|
| `image` | The image to look at |
| `limit` | Optional. At most this many regions, 1 to 100. The default is 50 |

The reply is `{"regions": [{"score", "box"}]}`, best first. The limit
of 100 is the same as the limit on `boxes` in `/v1/vision/embeddings`,
so every region of one reply can be embedded in one request.

`Owlv2Runner.regions_of` uses OWLv2's objectness score. For every box
it predicts, OWLv2 also says how likely the box is to hold a thing of
any kind. The runner calls the model with one placeholder label, reads
`objectness_logits` and `pred_boxes` from the output, and ignores the
label scores. It sorts the boxes by objectness, runs
`merge_overlapping`, and keeps the first `limit`. The score is the
sigmoid of the objectness logit.

`Florence2Runner.regions_of` runs the `<REGION_PROPOSAL>` task, which
returns boxes with no names. Florence-2 gives no scores, so each region
scores 1, in the order the model wrote them.

This route exists for the case where a detector does not know the name
of what is on the page. `detectObjects` still requires labels. A
detector with an empty label list is a different request from "box
everything", and it keeps its own name.

### Warm-up

`warm_up_request` sends the family's first route. For `embeddings` that
is the drawn square with no boxes. For OWLv2 it is `detections` with
`["square"]`, as for Florence-2.

## `serve`

Three places in `agency local serve` know the vision routes today, or
should, and each needs the new ones.

**The front door.** `mlxServer.ts` reads every request body before it
passes it on, with a limit. Only the image server's path has its own
limit. Every other path gets the default of 10 MB, so a vision request
over 10 MB is refused at the door today, though the vision server
allows a 50 MB image. The door gives the vision paths the vision
server's own limit. This also fixes detection on a large photo, which
is broken on main.

**The log.** `describeRequest` in `serveLog.ts` shows a vision
request's `image` as a note of its size, as it does for the image
server's fields. `describeReply` indents a vision reply's
JSON and counts what is in it, such as `3 detections`. `VISION_PATHS`
gains the two new paths. A regions reply counts as regions. An embeddings reply is handled like an image
reply: it can hold 76,800 numbers, so the log shows
`<100 embeddings>` and never the numbers.

**The banner.** After the models load, `serve` prints a line of Agency
code to try, and for any vision model that line is `tagImage(...)`.
DINOv2 and OWLv2 do not answer `tags`. The line now comes from a table
keyed by the architecture in the model's `config.json`:
`embedImage("drawing.png", "dinov2-base")` for DINOv2, and
`detectObjects("drawing.png", ["cat"], "owlv2-base")` for OWLv2. The
tagger and Florence-2 keep `tagImage`.

## The stdlib

### `embedImage`

```ts
export idempotent def embedImage(
  path: string,
  model: string,
  boxes: BoundingBox[] | null = null,
): Result<number[][]> raises <std::vision>
```

It raises `std::vision` with `task: "embeddings"`, reads the file after
approval, and sends its bytes, like the other functions.

With `boxes` left null, the result holds one vector for the whole
image. With a list of boxes, it holds one vector per box. An empty list
gives an empty result. Null and an empty list are kept apart on
purpose: a program that found no mugs in a photo must get no vectors
back, and must not get the vector of the whole photo.

`boxes` exists so a program can embed every detection in one photo
with one approval and one request. Without it, each detection needs
`cropImage` to write a file first, and each file is another approval.

The docstring is three sentences, since it doubles as the tool
description: what an embedding is for, that `boxes` embeds parts of the
picture instead of the whole, and that two embeddings should only be
compared when both were cut the same way. The last one is the mistake
the examples below avoid. A whole photo of a mug on a desk and a tight
crop of a mug do not compare well, because the first vector mostly
describes the desk.

### `findRegions`

```ts
export type Region = {
  id: number,
  score: number,
  box: BoundingBox,
}

export idempotent def findRegions(
  path: string,
  model: string,
  limit: number = 50,
): Result<Region[]> raises <std::vision>
```

It raises `std::vision` with `task: "regions"`. `id` is the region's
index in the reply, as it is for a `Detection`, so crops can be named
after it.

### `detectObjects`

Its `threshold` becomes `number | null = null`, where null uses the
model's default. Today the default of 0.3 is written into the
signature, which would make OWLv2 drop most real objects. A caller who
passes a number sees no change. `vision.ts` sends null as JSON `null`,
which `_threshold_of` already reads as "use the default".

### Putting it together

Here is the cat case. The program boxes everything on a page, embeds
each box, and keeps the boxes that look more like your cats than like
anything else you draw:

```ts
import { findRegions, embedImage } from "std::vision"
import { cosineSimilarity } from "std::embedding"

// How alike `vector` is to the closest of `references`, where 1 is identical.
def closest(vector: number[], references: number[][]): number {
  let best = 0
  for (reference in references) {
    const similarity = cosineSimilarity(vector, reference)
    if (isSuccess(similarity) && similarity.value > best) {
      best = similarity.value
    }
  }
  return best
}

// One vector per crop file.
def embedCrops(paths: string[]): number[][] {
  let vectors: number[][] = []
  for (path in paths) {
    const embedded = embedImage(path, "dinov2-base")
    if (isSuccess(embedded)) {
      vectors.push(embedded.value[0])
    }
  }
  return vectors
}

node main(page: string, catCrops: string[], otherCrops: string[]) {
  const cats = embedCrops(catCrops)
  const others = embedCrops(otherCrops)
  const regions = findRegions(page, "owlv2-base")
  if (isFailure(regions)) {
    return regions.error
  }
  const boxes = map(regions.value) as region {
    return region.box
  }
  const vectors = embedImage(page, "dinov2-base", boxes: boxes)
  if (isFailure(vectors)) {
    return vectors.error
  }
  for (vector, i in vectors.value) {
    if (closest(vector, cats) > closest(vector, others)) {
      print("Cat in region ${i}")
    }
  }
}
```

`catCrops` are tight crops of your cats, and `otherCrops` are tight
crops of other things you draw. A crop file embedded whole is cut the
same way as a box embedded from a page, so the two sides compare
fairly.

The rule in the last loop is "the nearest example wins". It needs no
cut-off value. It does need the other crops: without them there is
nothing for a cat to be closer than.

The crops come from the same route. Run `findRegions` over a few pages
and write each region out:

```ts
for (region in regions.value) {
  cropImage(page, region.box, "crops/${region.id}.png")
}
```

Then sort the files into two folders by hand. `pasteImages` makes a
contact sheet of them if that is easier to look over.

The mug case is the same program with two changes. The boxes come from
`detectObjects(photo, ["mug"], "owlv2-base")` instead of `findRegions`,
since a detector does know what a mug is. The other crops are other
people's mugs, since those are what yours gets confused with.

The models run as separate processes: `agency local serve dinov2-base
owlv2-base`.

A trained classifier does the job of `closest` better once there are
more than a handful of examples. That is the subject of
`2026-09-30-std-vectors.md`, and nothing here depends on it.

## Effects

No new effect. `std::vision` already carries `task` and `model`, so a
policy can allow `embeddings` under `./refs` and nothing else. The
two new task names, `embeddings` and `regions`, go in the
effect's documentation, and `tests/agency/vision.agency` gains a case
for each payload with a rejecting handler.

## Tests

- `visionServer.test.ts`, with `python3` and no torch:
  - the two new rows and `family_of` for both architectures
  - the rule that every row that detects has a default threshold, and
    the default each family fills in
  - every refusal of the two new routes: too many boxes, a box with
    no area, a `limit` out of range, and a field the route does not
    take
  - the 404 for a route the family does not answer, such as
    `embeddings` on OWLv2
  - an empty `boxes` list giving an empty reply
  - `merge_overlapping`
- The same file, with a fake model and a fake processor: a box that
  reaches into the padding is clamped, and a box wholly in the padding
  is dropped. `regions_of` sorts by objectness and keeps `limit`.
  `detections_of` labels each box with its best label. These check the
  runner's own arithmetic. They cannot check where the real
  model puts a box, which is in the manual run.
- A Pillow test for the square padding: a 300×100 crop comes out
  300×300, with the crop centered and the padding in the mean color.
- `mlxServer.test.ts`: a vision request over 10 MB and under the
  vision limit reaches the model's server.
- `serveLog.test.ts`: a request's `image` shown as a note, the count
  for a regions reply, and
  an embeddings reply logged by its vector count with no numbers.
- `localServe.test.ts`: the banner line for a DINOv2 and an OWLv2
  model.
- `vision.test.ts` against the stand-in server: the body each new
  function sends, that `boxes` are sent as given, that null `boxes`
  is sent as null, and the refusal of a model of another kind.
- `modelKind.test.ts`: a directory whose `config.json` names
  `Dinov2Model` is a vision model and is not an embedding model.
- A manual run on a Mac with all three models, recorded in the dev
  doc's timings section. It has a photo half and a drawing half.

  Photos:
  1. Embed 20 reference crops of one object. Search 10 photos with and
     without lookalikes. Note the similarity values that separated
     them.
  2. Detect one object in a 2:1 photo with OWLv2 and crop it with
     `cropImage`. The crop must show the object.

  Drawings, on ten pen-and-ink pages:
  1. What `detectObjects(page, ["cat"])` finds with Florence-2 and with
     OWLv2.
  2. Whether `findRegions` puts one box around each cat, with each
     model.
  3. Whether cat crops embed closer to each other than to other crops.
  4. The same comparison with white padding instead of gray.

## Docs

`docs/dev/llm/local-vision.md` gains the two families, the two
routes, why search by example was dropped, and the results of the
manual run. Its "Not here yet" list loses OWLv2.

## Not in this spec

- **Fine-tuning a detector.** Whether it is needed depends on which
  failure is left after the manual run.

  If confusion is left, the next step is a small trained classifier
  over the embeddings, which `2026-09-30-std-vectors.md` specifies. It
  needs no new model and no serving family.

  If misses are left, because no model boxes the cats, the next step is
  a trained detector. It needs a training package like `packages/lora`
  and a serving family of its own. The candidates are the detectors
  transformers 5.17 can already train: RT-DETRv2, D-FINE, RF-DETR,
  LW-DETR, and YOLOS each take `labels` and have a loss in
  `transformers/loss/`. A LoRA adapter on Florence-2 is the other
  candidate, and it would load into the family already served.

  Two things make the training pages cheap. The functions in this spec
  can label a folder, with a person correcting the result. And a cat
  cut out of white paper can be pasted onto another white page with no
  visible edge, so `cropImage` and `pasteImages` can turn 20 cats into
  a few hundred pages whose boxes are already known.

  Ultralytics is ruled out either way. Its license is AGPL-3.0, which
  would bind any package that imports it, and it sends usage analytics
  by default.
- **Recognizing a particular person.** DINOv2 is poor at telling faces
  apart. That needs a face-recognition model such as InsightFace's
  ArcFace, whose pretrained weights are licensed for non-commercial
  research only, so it cannot go in the public catalog.
- **A saved index of reference embeddings.** The example embeds the
  reference crops on every run. A program can save the vectors as JSON
  itself, and a store for them can come later if programs need one.
- **Text-to-image search** ("find photos of a red bicycle"). That is
  CLIP's or SigLIP's job, and a separate family.
- **Masks.** A region here is a box. Cutting an object out along its
  outline needs a segmentation model, which the earlier spec also left
  out.
