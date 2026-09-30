# `std::vision` embeddings and regions: implementation plan

**Spec:** `docs/superpowers/specs/2026-09-30-vision-embeddings-and-owlv2.md`.
Read it first, then `docs/dev/llm/local-vision.md`, which describes the
server this plan extends, and
`docs/dev/contributing/anti-patterns.md`.

**Branch:** `vision-embed-spec`, based on main. One PR.

**Goal:** Two model families on the vision server, DINOv2 and OWLv2,
two new routes, and `embedImage` and `findRegions` in `std::vision`, so
a program can find one person's own objects from a few example crops.

**Changed after Task 4's measurement.** The plan first had a third
route, `/matches`, and a `findByExample` function: search by example
with OWLv2. The measurement at the start of Task 4 showed it does not
work (see "Search by example, tried and dropped" in the spec), and the
owner chose to drop it. Tasks 1 to 3 were built with it, and a commit
after Task 3 removes the `matches` route, the `examples` field, the
larger body limit, and `average_directions`. Tasks 4 to 9 below no
longer mention it.

## Architecture

The work adds three routes and two families. Each of those is
described once, as a row in a table, and the code that acts on a row is
written once.

| What | Described in | Acted on by |
|---|---|---|
| A route, on the server | a row of `ROUTE_TABLE` in `visionRules.py` | `check_request` |
| A request field | an entry of `FIELD_CHECKS` | the one function that checks it |
| A family | a row of `FAMILIES` | the runner class the row names |
| What to do with a model's boxes | the arguments of `kept_boxes` | `kept_boxes` |
| A task, on the client | a row of `VISION_TASKS` in `vision.ts` | `visionCall`, and the serve log |
| The files a call reads | the list `_visionFiles` returns | a three-line loop in each Agency function |
| A body limit at the front door | a table from path to limit in `mlxServer.ts` | `bodyLimit` |

Torch appears in six short methods, one on `Dinov2Runner` and five on
`Owlv2Runner`. Each takes Pillow images and returns plain Python
lists. Everything above them is plain Python that CI runs with a fake
in place of those methods.

After this work, adding a route means one row in `ROUTE_TABLE`, one
row in `VISION_TASKS`, a method on a runner, and a function in
`vision.agency`.

## Constraints

- `visionRules.py` imports nothing from torch, transformers,
  onnxruntime, or Pillow. The existing import test covers it.
- No route method on a runner holds a threshold comparison, a sort, a
  unit conversion, or a merge. Those are in `kept_boxes`.
- An image still reaches the server as bytes. The server opens no file
  a request names.
- Every file a stdlib function reads is resolved before the first
  interrupt and read with `approvedFileBytes` after approval.
- No new effect.
- Every number with a meaning has a name. The constants are listed in
  each task.
- Run `pnpm run fmt:ts` before each commit. Save test output to a file.
  Write each commit message in a file and pass it with `git commit -F`.
- Do not run the full agency test suite locally. Run the single tests
  each task names.

## Task 1: One table for routes

This task changes no behavior. It moves what the server already knows
about its three routes into the shape the new routes need.

**Files:** `lib/cli/visionRules.py`, `lib/cli/visionServer.py`,
`lib/cli/visionServer.test.ts`.

1. Replace `ROUTES`, `ROUTE_FIELDS`, `DEFAULT_THRESHOLD`,
   `MAX_TAG_LIMIT`, and `DEFAULT_TAG_LIMIT` with one table:

   ```python
   ROUTE_TABLE = {
       "detections": {
           "path": "/v1/vision/detections",
           "fields": ["labels", "threshold"],
       },
       "tags": {
           "path": "/v1/vision/tags",
           "fields": ["threshold", "limit"],
           "default_threshold": 0.35,
           "limit_max": 500,
           "limit_default": 30,
       },
       "captions": {
           "path": "/v1/vision/captions",
           "fields": ["detail"],
       },
   }
   ```

   The comment above it lists the keys, as the comment above `FAMILIES`
   does.
2. The Florence-2 row of `FAMILIES` gains
   `"default_threshold_detections": 0.3`. `default_threshold(rules,
   route)` returns the family's `default_threshold_<route>` when the
   row has one, and the route row's `default_threshold` otherwise.
3. Every field checker takes `(rules, route, body)`:

   ```python
   FIELD_CHECKS = {
       "labels": _labels_of,
       "threshold": _threshold_of,
       "limit": _limit_of,
       "detail": _detail_of,
   }
   ```

   `_threshold_of` uses `default_threshold`. `_limit_of` reads
   `limit_max` and `limit_default` from the route's row.
4. `check_request` loses its `if / elif / else`:

   ```python
   checked = {"image": _image_of(body)}
   for field in ROUTE_TABLE[route]["fields"]:
       checked[field] = FIELD_CHECKS[field](rules, route, body)
   return checked
   ```

5. `route_of_path`, `route_paths`, `_check_fields`, and the 404
   message read `ROUTE_TABLE`. `visionServer.py` imports nothing that
   was removed.
6. Tests: every existing test passes with its messages unchanged. Add
   two:
   - every field named in `ROUTE_TABLE` has an entry in `FIELD_CHECKS`
   - every row of `FAMILIES` that answers `detections` has a numeric
     `default_threshold_detections`
7. Commit: `Describe each vision route in one table`.

## Task 2: The new routes, families, and box arithmetic

**Files:** `lib/cli/visionRules.py`, `lib/cli/visionServer.test.ts`,
`lib/stdlib/modelKind.ts`, `lib/stdlib/modelKind.test.ts`.

1. Constants, each with a comment:
   - `MAX_REPLY_BOXES = 100`: the most boxes a reply holds, and the
     most an embeddings request takes, so one reply's boxes fit one
     request.
   - `MAX_EXAMPLES = 4` and `MAX_EXAMPLE_BYTES = 10_000_000`.
   - `MERGE_IOU = 0.3`: two boxes overlapping by more than this are
     one object. `KEEP_OVERLAPS = 1.0`: no two boxes overlap by more
     than this, so nothing is merged.
   - `MAX_MERGE_CANDIDATES = 500`: how many of the best boxes
     `kept_boxes` considers.
   - `WHOLE_IMAGE = {"x": 0, "y": 0, "width": 1, "height": 1}`.
2. Three rows in `ROUTE_TABLE`:

   ```python
   "embeddings": {
       "path": "/v1/vision/embeddings",
       "fields": ["boxes"],
   },
   "matches": {
       "path": "/v1/vision/matches",
       "fields": ["examples", "threshold"],
       "default_threshold": 0.6,
   },
   "regions": {
       "path": "/v1/vision/regions",
       "fields": ["limit"],
       "limit_max": MAX_REPLY_BOXES,
       "limit_default": 50,
   },
   ```

3. Two entries in `FIELD_CHECKS`:
   - `_boxes_of`: a missing or null `boxes` gives `[WHOLE_IMAGE]`. A
     list may hold 0 to `MAX_REPLY_BOXES` items. Each is a dict with
     exactly `x`, `y`, `width`, and `height`, numbers from 0 to 1, with
     `width` and `height` above 0. The message names the index of the
     bad box.

     Turning "no boxes" into one box over the whole image here means
     the runner has one path and no branch.
   - `_examples_of`: a list of 1 to `MAX_EXAMPLES` items, each read
     with `image_bytes_of(value, MAX_EXAMPLE_BYTES)`. The message names
     the index.
4. The two rows from the spec join `FAMILIES`. The
   Florence-2 row gains `"regions"` at the end of its `routes` and
   `"task_regions": "<REGION_PROPOSAL>"`. In the same commit,
   `VISION_ARCHITECTURES` in `modelKind.ts` gains the two
   architectures, because a test keeps the two lists equal. Add the
   `modelKind.test.ts` case: a directory whose `config.json` names
   `Dinov2Model` is `vision`.
5. `MAX_BODY_BYTES` becomes
   `base64_length(MAX_IMAGE_BYTES) + MAX_EXAMPLES * base64_length(MAX_EXAMPLE_BYTES) + MAX_SETTINGS_BYTES`.
6. `family_of` builds its message's second sentence from the table:
   the file pair of each row that has `identify_file`, and the
   architecture of each row that has `identify_architecture`.
7. `kept_boxes`, the one function that turns a model's raw boxes into
   a reply's boxes:

   ```python
   def kept_boxes(scores, boxes, width, height, threshold, iou, limit):
       """The boxes of a reply, best first.

       scores[i] is the score of boxes[i]. Each box is [x1, y1, x2, y2]
       in 0..1 of the square OWLv2 padded the image to. Returns dicts
       {"index", "score", "box"}, where index is the box's position in
       the input and box is normalized to the image itself.
       """
   ```

   Its steps, each a small named function it calls:
   - keep the indexes scoring at or above `threshold`, sorted by score
     with the index as the tie-break, cut to `MAX_MERGE_CANDIDATES`
   - `square_box_to_image(box, width, height)`: multiply by the longer
     side, pass the result to `normalized_box`, and return `None` when
     the clamped box has no area
   - `merge_overlapping(candidates, iou, limit)`: go through the
     candidates in order, keep one unless it overlaps a kept one by
     more than `iou`, and stop at `limit`
8. Three more plain functions:
   - `average_directions(vectors)`: scale each list to length 1, then
     take the element-wise mean. Without the scaling, a long vector
     would count for more than a short one.
   - `square_padding(width, height)`: the side of the square and the
     offset at which a `width`×`height` crop sits centered in it
   - `box_pixels(box, width, height)`: the pixel rectangle for a
     normalized box, or a `RequestError` when it has no area. Read
     `crop_box` in `imageToolsRules.py` first, and call it with no pad
     if it already does this.
9. Tests, extending the `check` helper's `family` type to the two new
   keys:
   - `familyOf` knows both new architectures, and the refusal names all
     four families
   - the default filled in: 0.3 for Florence-2 detections, 0.1 for
     OWLv2 detections, 0.6 for matches, and a limit of 50 for regions
   - each refusal of `boxes`, `examples`, and the regions `limit`, with
     its exact message
   - missing `boxes` and null `boxes` both check to `[WHOLE_IMAGE]`,
     and `[]` checks to `[]`
   - `embeddings` on OWLv2 is a 404 naming the routes it answers
   - `kept_boxes` on a 200×100 image, with boxes written by hand:
     - the result is in score order and carries each box's input index
     - a box below the threshold is left out
     - a box in the top half lands in the right place
     - a box crossing into the padding is clamped
     - a box wholly in the padding is left out
     - with `MERGE_IOU`, two overlapping boxes keep the higher score
     - with `KEEP_OVERLAPS`, both stay
     - `limit` cuts the list
   - `square_padding(300, 100)` gives side 300 and offset `(0, 100)`
   - `average_directions([[2, 0], [0, 1]])` gives `[0.5, 0.5]`
   - the body limit is the new sum, replacing the test that pins it to
     the image limit plus 64 KB
   - the warm-up test's expected lines gain one for each new family
10. Commit: `Vision rules for embeddings, matches, and regions`.

## Task 3: The DINOv2 runner

**Files:** `lib/cli/visionServer.py`, `lib/cli/visionServer.test.ts`.

1. `DINOV2_INPUT_SIZE = 224`, with a comment that it is the size the
   model card crops to.
2. `Dinov2Runner`, loaded like `Florence2Runner`: version check,
   `transformers.BitImageProcessorPil` and `transformers.Dinov2Model`
   with `use_safetensors=True` and `local_files_only=True`, on `mps`
   when available. It reads the padding color once from the
   processor's `image_mean`, scaled to 0..255.

   The processor class is named on purpose. `AutoImageProcessor` picks
   a class that needs torchvision, which the serve environment does
   not install, so the server would fail as it starts. The Pillow class
   needs nothing more than Pillow. A comment in the code says so.
3. Its one torch method:

   ```python
   def _embed(self, crops):
       """One unit-length vector, as a list, per Pillow image."""
       size = {"height": DINOV2_INPUT_SIZE, "width": DINOV2_INPUT_SIZE}
       inputs = self.processor(
           images=crops,
           do_center_crop=False,
           size=size,
           return_tensors="pt",
       ).to(self.device)
       with self.torch.no_grad():
           pooled = self.model(**inputs).pooler_output
       return self.torch.nn.functional.normalize(pooled, dim=-1).tolist()
   ```

   Check in a Python prompt what the processor does with an empty
   list. If it refuses one, `_embed` returns `[]` for an empty list,
   and that guard stays inside `_embed`.
4. `padded_square(image, color)`, a module function beside
   `open_image`: a new square image in `color` with `image` pasted at
   the offset `square_padding` gives.
5. The route method has one path, because the rules already turned "no
   boxes" into `[WHOLE_IMAGE]`:

   ```python
   def embeddings_of(self, image, request):
       width, height = image.size
       crops = [
           padded_square(image.crop(box_pixels(box, width, height)), self.padding)
           for box in request["boxes"]
       ]
       return {"embeddings": self._embed(crops)}
   ```

6. Register the class in `RUNNERS`.
7. Tests. Both need Pillow, so they sit with the Pillow tests and skip
   where it is missing, as `imageTools.test.ts` does:
   - with a fake `_embed` that records the sizes it was given:
     `[WHOLE_IMAGE]` passes one square the size of the image's longer
     side, two boxes pass two squares, and `[]` passes an empty list
   - `padded_square` on a 300×100 image gives 300×300, with the
     original at `(0, 100)` and the corner pixel in the padding color
8. Commit: `Serve DINOv2 image embeddings`.

## Task 4: The OWLv2 runner, and regions on Florence-2

**Files:** `lib/cli/visionServer.py`, `lib/cli/visionServer.test.ts`.

1. The measurement this task started with is done, and it dropped
   `/matches`. It also showed two things the runner must do:
   - `Owlv2ImageProcessorPil` resizes with scipy, which the serve
     environment does not install. The runner pads the image to a
     square on the bottom and the right, in the processor's mid-gray,
     and resizes it to the processor's size with Pillow. It then calls
     the processor with `do_pad=False` and `do_resize=False`, so the
     processor only rescales and normalizes. Detection through this
     path found all four objects in the test photo.
   - Regions come from `model.objectness_predictor` on the image
     features, with no text. Running the whole model with a
     placeholder label gives the same scores and also runs the text
     encoder.
2. `Owlv2Runner`, loaded with `transformers.Owlv2ForObjectDetection`
   and the same flags as the others. Load `Owlv2ImageProcessorPil` and
   the tokenizer by name. `AutoProcessor` reaches the Pillow class
   today only by falling back when torchvision is missing, and the
   family table is meant to decide what is imported.
3. Three torch methods. The two that score boxes return the same
   shape: a list of scores, and a list of boxes as `[x1, y1, x2, y2]`
   in 0..1 of the padded square, made with `center_to_corners_format`.
   The line numbers are in `modeling_owlv2.py` of transformers 5.17.
   Check the tensor shapes there before writing each one.
   - `_features(image)`: `model.image_embedder` (line 1247) on the
     processor's `pixel_values`. Returns the feature map, and the same
     map reshaped to `(1, patches, dim)`. Only the methods below call
     it.
   - `_label_scores(image, labels)`: run the model with the labels as
     text. Returns scores, boxes, and a third list, the index of each
     box's best label. The score is the sigmoid of that label's logit.
   - `_objectness(image)`: `_features`, then
     `model.objectness_predictor` and `model.box_predictor`. Returns
     the sigmoid of each objectness logit, and the boxes.
4. The route methods. Each gets raw boxes from one torch method and
   says what it wants from `kept_boxes`:

   ```python
   def detections_of(self, image, request):
       labels = request["labels"]
       scores, boxes, best_label = self._label_scores(image, labels)
       kept = kept_boxes(scores, boxes, *image.size, request["threshold"], KEEP_OVERLAPS, MAX_REPLY_BOXES)
       return {"detections": [
           {"label": labels[best_label[found["index"]]], "score": found["score"], "box": found["box"]}
           for found in kept
       ]}

   def regions_of(self, image, request):
       scores, boxes = self._objectness(image)
       kept = kept_boxes(scores, boxes, *image.size, 0.0, MERGE_IOU, request["limit"])
       return {"regions": [{"score": found["score"], "box": found["box"]} for found in kept]}
   ```

   The real code breaks the long lines.
5. `Florence2Runner.regions_of`: `_run` with the row's `task_regions`.
   Its boxes are already in pixels, so it uses `normalized_box` as
   `detections_of` does. Each scores 1. It keeps the first `limit`.
6. Register `Owlv2Runner` in `RUNNERS`. Update the module docstring's
   route list.
7. Tests with fakes in place of the torch methods, in the block that
   already fakes Florence-2. `kept_boxes` has its own tests, so these
   check only what each route asks of it:
   - `detections_of` labels each box with the label at its best index,
     and keeps two overlapping boxes
   - `regions_of` returns at most `limit` boxes in score order
   - Florence-2's `regions_of` sends `<REGION_PROPOSAL>` and scores 1
8. Commit: `Serve OWLv2 detections and regions`.

## Task 5: One table for tasks, and the file list

This task changes no behavior either. It gives the client the shape
the new functions need.

**Files:** `lib/stdlib/vision.ts`, `lib/stdlib/vision.test.ts`,
`stdlib/vision.agency`, `lib/cli/serveLog.ts`,
`lib/cli/serveLog.test.ts`, `lib/cli/visionServer.test.ts`.

1. `vision.ts`: `ROUTE_FOR_TASK` becomes a table with a row per task:

   ```ts
   type VisionTaskRow = {
     route: string;
     replyField: string;
     numbered: boolean;
     logNoun: string;
     logBody: boolean;
   };

   export const VISION_TASKS: Record<string, VisionTaskRow> = {
     detections: {
       route: "/vision/detections",
       replyField: "detections",
       numbered: true,
       logNoun: "detection",
       logBody: true,
     },
     // tags and captions likewise
   };
   ```

   `numbered` says whether each item of the reply gets an `id`, its
   index. `logNoun` and `logBody` are for the serve log.
2. `visionCall(name, task, spelling, model, fields)` replaces
   `asResult` and the body of `_detectObjects`. It posts with
   `visionRequest`, takes `reply[row.replyField]`, numbers the items
   when the row says so, and returns a `Result` whose failure starts
   with `name`. Each export becomes one call to it.
3. `approvedBase64(spelling, maxBytes)`: returns the file's base64 or
   the error, from the `try` that is in `visionRequest` today.
   `visionRequest` calls it.
4. `_visionFiles(path, question)`: resolves `path` with `_realTarget`
   and returns

   ```ts
   type VisionAsk = { question: string; dir: string; filename: string };
   type VisionFiles = { image: string; asks: VisionAsk[] };
   ```

   with one ask, for the image.
5. `vision.agency`: the three functions each become the same three
   statements, which is the shape `generateImageLocal` has:

   ```ts
   const files = try _visionFiles(path, "Tag this image with a local model?")
   if (isFailure(files)) {
     return files
   }
   for (ask in files.value.asks) {
     raise std::vision(ask.question, { dir: ask.dir, filename: ask.filename, task: "tags", model: model })
   }
   return try _tagImage(files.value.image, model, threshold, limit)
   ```

   This replaces `return interrupt std::vision(...)` with `raise`
   inside a loop. `docs/site/guide/interrupts.md` says a rejected raise
   halts the function and returns a failure, which is what
   `rejectedIsFailure` in `tests/agency/vision.agency` checks.

   **These three functions are safety code.** Run
   `pnpm run agency test tests/agency/vision.agency` before and after.
   All four existing cases must give the same output. If any differs,
   stop, leave the three functions as they were, and use this shape
   for the new functions only.
6. `serveLog.ts`: `VISION_PATHS` and `describeVision` read
   `VISION_TASKS`. A reply's count is the length of
   `parsed[row.replyField]` when that is a list, and 1 otherwise, with
   `row.logNoun`. When `row.logBody` is false, the summary's body is the
   count alone, such as `<100 embeddings>`, and the JSON is not
   indented. No row
   sets it false yet.
7. Tests:
   - `vision.test.ts` and `serveLog.test.ts` pass unchanged
   - `visionServer.test.ts`: the routes in `VISION_TASKS`, with `/v1`
     in front, equal the paths in `ROUTE_TABLE`
8. Run `make`. Commit: `Describe each vision task in one table`.

## Task 6: The front door's body limit

`agency local serve` puts a front door, `lib/cli/mlxServer.ts`, before
every model process. It reads each request body with a limit. For any
path but the image server's, that limit is the 10 MB default in
`lib/serve/constants.ts`. So a vision request over 10 MB is refused at
the door today, though `vision.ts` and `visionRules.py` both allow a
50 MB image. An 8 MB photo is already too large once it is base64.
This task fixes that.

**Files:** `lib/stdlib/vision.ts`, `lib/cli/mlxServer.ts`,
`lib/cli/mlxServer.test.ts`, `lib/cli/visionServer.test.ts`.

1. `vision.ts` gains `visionBodyBytes()`: the largest body a vision
   request may have, computed the way `MAX_BODY_BYTES` in
   `visionRules.py` is.
2. `bodyLimit` in `mlxServer.ts` becomes a lookup in a small table from
   path to limit: the image path to `localBodyBytes()`, and each path
   in `VISION_TASKS` to `visionBodyBytes()`. A path that is not in the
   table keeps the default.
3. Tests:
   - `mlxServer.test.ts`: a vision request over 10 MB and under the
     vision limit reaches the stand-in server, and one over the vision
     limit is refused
   - `visionServer.test.ts`: `visionBodyBytes()` equals the rules
     module's `MAX_BODY_BYTES`
4. Commit: `Let a vision request be as large as the vision server allows`.
   Say in the PR description that this fixes a bug on main.

## Task 7: The new functions

**Files:** `lib/stdlib/vision.ts`, `lib/stdlib/vision.test.ts`,
`stdlib/vision.agency`, `tests/agency/vision.agency`,
`tests/agency/vision.test.json`, `lib/cli/serveLog.ts`,
`lib/cli/serveLog.test.ts`, and `lib/cli/visionServer.test.ts`.

1. Two rows in `VISION_TASKS`:

   | Task | `replyField` | `numbered` | `logNoun` | `logBody` |
   |---|---|---|---|---|
   | `embeddings` | `embeddings` | no | `embedding` | no |
      | `regions` | `regions` | yes | `region` | yes |

2. `describeRequest` in `serveLog.ts` shows a vision request's `image`
   as a note of its size, as it already does for the image server's
   fields. Without this, one verbose log line could hold 67 MB of
   base64.
3. (Dropped with `findByExample`.)
4. Two exports, each one call to `visionCall`:
   - `_embedImage(spelling, model, boxes)` sends `boxes` as given. A
     null goes as JSON `null`, which the server reads as the whole
     image.
   - `_findRegions(spelling, model, limit)`.
5. `_detectObjects` takes `threshold: number | null` and sends it as
   given. The message in `checkVisionModel` names an embedding model
   as well as detectors and taggers.
6. `vision.agency`:
   - `detectObjects`: `threshold: number | null = null`. The `@param`
     lines for `labels` and `threshold` say which model does what.
   - `Region`, `embedImage`, and `findRegions`, with the spec's
     signatures. Each is the three statements from Task 5.
   - The docstrings follow the spec: three sentences for `embedImage`.
     The longer explanation and the cat example go in the module doc
     comment.
   - The comment above the effect says five functions.
7. Tests:
   - `vision.test.ts`, against the stand-in server: the body each new
     function sends, `boxes` sent as given, null `boxes` sent as
     `null`, a null threshold sent as `null`, and regions numbered
   - `serveLog.test.ts`: a vision request's `image` is shown as a
     note, a regions reply counts regions, and an embeddings reply is
     logged as
     `<2 embeddings>` with no numbers in the body
   - `tests/agency/vision.agency`: a payload node for each new task,
     with a rejecting handler
8. Run `make`, which also regenerates `docs/site/stdlib/vision.md`.
9. Commit: `embedImage and findRegions in std::vision`.

## Task 8: The catalog and the banner

**Files:** `lib/stdlib/modelCatalog.ts`, `lib/stdlib/modelKind.ts`,
`lib/cli/localServe.ts`, `lib/cli/localServe.test.ts`.

1. Two catalog entries after `florence-2`, in the same shape:
   `dinov2-base` (`mlx:facebook/dinov2-base`, `apache-2.0`) and
   `owlv2-base` (`mlx:google/owlv2-base-patch16-ensemble`,
   `apache-2.0`). Take `sizeBytes` from the Hub's file list after
   `visionFiles` has filtered it, as the two existing entries did.
2. `modelKind.ts`: the list of architectures becomes a table, so what
   TypeScript knows about a family is in one place:

   ```ts
   export const VISION_FAMILIES: Record<string, VisionFamily> = {
     Florence2ForConditionalGeneration: { tryIt: "tagImage" },
     Dinov2Model: { tryIt: "embedImage" },
     Owlv2ForObjectDetection: { tryIt: "detectObjects" },
   };
   export const VISION_ARCHITECTURES = Object.keys(VISION_FAMILIES);
   ```

3. `localServe.ts`: a second small table gives the line of code for
   each `tryIt` name, with the model's name filled in. The banner
   looks up the model's architecture in `VISION_FAMILIES`, and uses
   `tagImage` for the ONNX tagger, which has no architecture. Read the
   architecture the way `modulesFor` reads the directory.
4. Tests: the banner line for a DINOv2 model, an OWLv2 model, and the
   tagger.
5. Commit: `Catalog and serve DINOv2 and OWLv2`.

## Task 9: The manual run and the docs

This task needs a Mac, about 1 GB of downloads, and the owner's
drawings. The owner runs it, or provides ten pages and a few photos.

1. `agency local download dinov2-base owlv2-base`, then
   `agency local serve dinov2-base owlv2-base florence-2`. Confirm
   both new models load on `mps`, and that each warm-up passes.
2. Run the photo half and the drawing half from the spec's test list.
   Record every number.
3. Settle from the results:
   - whether white padding beats gray on drawings. If it does, add the
     `padding` field in a follow-up.
   - whether DINOv2 separates the drawings. If it does not, write that
     down. A SigLIP row is a follow-up.
4. Docs:
   - `docs/dev/llm/local-vision.md`: the architecture table at the top
     of this plan, the two families, the three routes, why OWLv2's
     routes read scores and boxes themselves, the body limit, and the
     timings. Its section on adding a route lists the four places.
     Remove OWLv2 from "Not here yet".
   - The one-line entries for that doc in `CLAUDE.md` and in
     `.claude/skills/agency-llm-docs/SKILL.md`.
   - `docs/site/guide/using-local-models.md` and
     `docs/site/cli/local.md`: the two models, and the cat example.
   - The similarity values measured, in the doc comment of
     `embedImage`.
5. Read the prose against `docs/dev/contributing/verbal-tics.md`, and
   the code against `docs/dev/contributing/anti-patterns.md`.
6. Commit: `Document DINOv2 and OWLv2`. Open the PR against main.

## Not in this plan

- Anything in `2026-09-30-std-vectors.md`. The cat example here uses a
  few lines of Agency and does not wait for it.
