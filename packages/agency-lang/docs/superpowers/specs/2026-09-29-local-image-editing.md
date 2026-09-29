# Editing images on the local image server

An addendum to `2026-09-28-local-models-dx.md` and `2026-09-28-controlnet.md`.
Today `generateImageLocal` makes an image from text only. This spec lets it
take images in, two ways:

- **Reference editing**, the main feature. You give FLUX.2 [klein] a picture
  and an instruction, "add a red top hat to the character", and it draws a new
  image that follows the instruction and copies everything else from the
  picture. This is what the hosted `generateImage(prompt, images: [...])` does
  with OpenAI's or Google's models.
- **Image-to-image**, the second part. The other four families start from your
  picture with some noise added, instead of from pure noise, and a `strength`
  from 0 to 1 says how much of it to redraw. This keeps the exact layout and
  changes the style: "a watercolor painting" at strength 0.6.

They are different operations, so they are different parameters. A caller who
asks for an edit never silently gets image-to-image.

## Why klein, and what the test showed

klein's pipeline, `Flux2KleinPipeline`, already takes an `image` argument (one
image or a list). It does not add noise to the picture. It encodes each picture
separately and puts it next to the new image as extra tokens the model looks at
on every step (`torch.cat([latents, image_latents], dim=1)` in diffusers 0.40),
while the new image starts from pure noise. There is no `strength`. This is the
same approach as FLUX.1 Kontext and Qwen-Image-Edit, and it is why an edit keeps
the character: the model copies from the reference instead of repainting it.

A throwaway test (`/Volumes/adit-agency-models-sept-2026/image-perf/klein_edit.py`,
run 2026-09-29 on the M5 Ultra with the 4B model, `flux2-klein-4b`) drew a
cartoon fox, then gave it five edits at 1024x1024, 4 steps:

| Edit | Result | Seconds |
|---|---|---|
| Add a red top hat | Hat added, fox unchanged | 4.7 |
| Redraw as a watercolor | Same pose and scarf, watercolor style | 4.6 |
| Snowy forest background | Background replaced, fox unchanged | 4.6 |
| Wave with the right hand | Waves, but with both hands | 4.6 |
| Round glasses | Glasses added, fox unchanged | 4.6 |

The model loaded in 4 seconds and peaked at 28 GB of GPU memory. Only the pose
edit missed part of the instruction. klein is good enough, so this spec adds
no edit-only model. Qwen-Image-Edit stays an option if a later test finds edits
klein cannot do.

## One mode per request

A request is in one of four modes. The mode is decided by which image field
the request carries:

| Mode | Image field | Other fields of the mode | Families |
|---|---|---|---|
| plain | none | none | all five |
| control | `control_image` | `controlnet`, `control_scale`, `control_invert` | SDXL |
| reference | `images` | none | FLUX.2 [klein] |
| img2img | `start_image` | `strength` | the other four |

Two tables in the rules module hold everything that differs between the
modes. The code that checks a request, decodes an image, and picks a
pipeline reads the tables and has no branch per mode. ControlNet, which
exists today, moves onto the same tables with no change in behavior.

The first table has one row per image field:

```python
INPUT_IMAGES = {
    "control_image": {"mode": "control",   "max_count": 1, "max_bytes": MAX_IMAGE_BYTES,       "fit": "letterbox", "on_white": False},
    "images":        {"mode": "reference", "max_count": 4, "max_bytes": MAX_INPUT_IMAGE_BYTES, "fit": "shrink",    "on_white": True},
    "start_image":   {"mode": "img2img",   "max_count": 1, "max_bytes": MAX_INPUT_IMAGE_BYTES, "fit": "cover",     "on_white": True},
}
```

A row may also name a step that only its mode needs. The control row names
the invert that runs after decoding, and the `images` row names klein's
check of a reference's shape.

The second table is a key in each family row. It names the diffusers class for
each mode the family takes:

```python
# SDXL
"pipelines": {
    "plain": "StableDiffusionXLPipeline",
    "control": "StableDiffusionXLControlNetPipeline",
    "img2img": "StableDiffusionXLImg2ImgPipeline",
},
# FLUX.2 [klein]. One class does both.
"pipelines": {
    "plain": "Flux2KleinPipeline",
    "reference": "Flux2KleinPipeline",
},
```

A family takes a mode when it has a pipeline for it. `pipelines` replaces
three keys the rows have today: `pipeline`, `takes_controlnet`, and
`controlnet_pipeline`.

## What this adds

### Part 1: reference editing (klein)

1. A parameter on `generateImageLocal`: `images: string[] = []`, local paths
   to reference images. The name matches the hosted `generateImage`. The
   hosted function also takes URLs and data URIs. This one takes paths only
   and refuses anything else before it asks for approval.
2. A request field on `/v1/images/generations`: `images`, a list of
   base64-encoded image bytes.
3. The `images` row of `INPUT_IMAGES`, and a `reference` pipeline in klein's
   family row. A request with references for another family is refused with
   a 400 that says which families take them.

### Part 2: image-to-image (the other four families)

1. Parameters on `generateImageLocal`: `startImage: string = ""`, a local path,
   and `strength: number | null = null`.
2. Request fields: `start_image` (base64 bytes) and `strength` (a number
   greater than 0 and at most 1).
3. The `start_image` row of `INPUT_IMAGES`, an `img2img` pipeline in four
   family rows, and three family keys:

   | Family | `img2img` pipeline | `default_strength` | `img2img_takes_size` | `img2img_steps` |
   |---|---|---|---|---|
   | Z-Image Turbo | `ZImageImg2ImgPipeline` | 0.6 | yes | `"up"` |
   | Chroma1-HD | `ChromaImg2ImgPipeline` | 0.9 | yes | `"up"` |
   | Qwen-Image | `QwenImageImg2ImgPipeline` | 0.6 | yes | `"up"` |
   | SDXL | `StableDiffusionXLImg2ImgPipeline` | 0.6 | no | `"down"` |
   | FLUX.2 [klein] | none | none | none | none |

   The strengths are first guesses. Three are the pipeline's own default in
   diffusers 0.40. SDXL's own default is 0.3, which suits its use after a
   refiner and barely changes a style, so SDXL starts at 0.6. The
   implementation plan measures each family and changes the table if one
   needs something else.

   `img2img_takes_size` and `img2img_steps` are explained under "How
   image-to-image differs by family".

   All four classes take `strength` and support being built from another
   pipeline's parts (checked in diffusers 0.40).

The two parts can land as separate PRs. Part 1 builds the shared image
plumbing, and Part 2 uses it.

## How much work

Most of this already exists, because ControlNet needed the same pieces:

- **Reading an image safely.** The control image is already read in TypeScript
  after `std::readImage` is approved, with `approvedFileBytes`, which refuses
  symlinks and files over a size cap. It is sent as base64 bytes and decoded
  with `image_bytes_of`. Pillow then opens only PNG, JPEG, WebP, and GIF, and
  the server refuses an image over 40 megapixels before it decodes it. The
  server never opens a path from a request. Reference images and the start
  image use the same path and the same limits.
- **A second pipeline over the same weights.** `control_pipeline` in
  `diffusersImageServer.py` builds `pipeline_class(**self.pipe.components,
  controlnet=...)` once and caches it. The image-to-image pipeline is built
  the same way with no extra model, so it costs no extra memory and no extra
  load time.

What is new: the two tables, moving ControlNet onto them, the size and crop
arithmetic, the front door's body limit, and the stdlib parameters. Part 1
carries the tables and the move, so it is the larger part. Part 2 is a table
row, four pipeline names, and three family keys.

## Decoding an input image

One server function decodes every input image. It reads the image's row in
`INPUT_IMAGES` and does these steps in order:

1. Open the bytes with Pillow, allowing only PNG, JPEG, WebP, and GIF.
2. Refuse an image over 40 megapixels.
3. Apply the EXIF orientation with `ImageOps.exif_transpose`. A phone stores
   a portrait photo as landscape pixels plus a rotation tag. Without this
   step the edit comes back sideways.
4. Convert to RGB. When the row's `on_white` is true, a transparent image is
   pasted onto white first. Converting directly turns a transparent
   background black, and character art is often a PNG with transparency. A
   control image has `on_white` false, because its background must stay as
   drawn.

All of this happens before the generation lock is taken, so a bad image never
waits for the GPU.

## The request rules

All in `diffusersImageRules.py`, so CI tests them with plain python3.

`mode_of(rules, body)` decides the mode and makes three refusals:

1. **Two modes.** A request with image fields of two modes is refused: "a
   request takes one of control_image, images, or start_image." No family
   does two. SDXL has a pipeline for a ControlNet with a start image
   (`StableDiffusionXLControlNetImg2ImgPipeline`), but it is one more
   pipeline to build and test, and nothing asks for it yet.
2. **A field of another mode.** `strength` without `start_image` is refused,
   and so is `control_scale` without `control_image`. The message names the
   image field that the setting goes with.
3. **A mode the family has no pipeline for.** The message names the families
   that do.

The other rules:

- An image field carries at most its row's `max_count` images, each at most
  its row's `max_bytes`.
- `controlnet` and `control_image` go together, as today.
- A LoRA works in every mode. It is loaded into the shared weights, so every
  pipeline of the family sees it. Only SDXL takes a LoRA today, and klein
  takes none.
- A reference with a side under 64 pixels, or a shape more extreme than 8 to
  1, is refused with a 400. klein makes both checks itself, but from inside
  the pipeline call, where a failure is a server error. The server makes them
  when it decodes the image.

### How image-to-image differs by family

The four pipelines disagree on two things, and the family table records both.

**How many steps run.** Image-to-image skips the first part of the schedule,
so a request for 28 steps runs fewer. The families round differently:

```python
# SDXL ("down")
steps_run = min(int(steps * strength), steps)

# Z-Image, Chroma, Qwen-Image ("up")
steps_run = steps - int(max(steps - steps * strength, 0))
```

| Family | Steps | Strength | Steps that run |
|---|---|---|---|
| Z-Image Turbo | 9 | 0.1 | 1 |
| Z-Image Turbo | 9 | 0.6 | 6 |
| SDXL | 28 | 0.03 | 0 |
| SDXL | 28 | 0.6 | 16 |

`steps_run(rules, request)` in the rules module computes the number. In the
other three modes it is the steps the request asked for. A request where it
is 0 is refused: "strength 0.03 with 28 steps runs no steps; raise either."
Only SDXL can reach 0. The `"up"` families always run at least one step for a
strength above 0.

**Whether the pipeline takes a size.** `StableDiffusionXLImg2ImgPipeline` has
no `width` or `height` argument. It draws at the size of the image it is
given. The other three take both. The server always fits the start image to
the output size before the call, so the result is the same for every family.

`pipeline_args` is the one function that knows both differences. It builds
the arguments for a family, a mode, and a size, and for SDXL in img2img mode
it leaves `width` and `height` out.

### Size limits on the inputs

Three limits apply, from the outside in:

| Limit | Value | Where |
|---|---|---|
| One reference or start image | 20 MB | stdlib before approval, server on decode |
| One control image | 50 MB, as today | stdlib, server |
| One request body | 64 KB plus the base64 of 80 MB, about 107 MB | front door and image server |

A request carries one of these and never more: up to 4 references, 1 start
image, or 1 control image. Only klein takes references and klein takes no
ControlNet. A start image with a ControlNet is refused. So the largest body
is 4 references of 20 MB each.

A reference over 20 MB buys nothing. klein shrinks every reference to one
megapixel (`_resize_to_target_area` in its pipeline), and a start image is
scaled to the output size.

`image_bytes_of` takes the cap as an argument. Today it is fixed at 50 MB.

The stdlib needs the same numbers before it asks for approval, so
`lib/stdlib/image.ts` has a table with the same fields, counts, and byte
caps. The body limit on each side is computed from its table, and a test
compares the two tables and the two limits.

**The front door.** `agency local serve` puts one HTTP front door in front of
every model process. It reads each request body with `parseJsonBody`, which
refuses a body over 10 MB (`MAX_BODY_BYTES` in `lib/serve/constants.ts`).
That limit is shared with `agency serve`. It means a control image over about
7.5 MB already fails today with a 413, although the image server documents 50
MB. This spec gives the front door a second limit, equal to the image
server's body limit. It applies only to a request for
`/v1/images/generations`. The front door knows the path before it reads the
body. Every other route keeps 10 MB, and so does `agency serve`.

**The log.** With `--verbose`, the front door prints each request body.
`describeRequest` in `lib/cli/serveLog.ts` prints it whole, so a control
image is printed as megabytes of base64 today. The logged request replaces
each image field with a note such as `<3 images, 4.2 MB>`, the way an image
reply is already summarized.

The front door holds the body in memory, and so does the image server while
it parses and decodes it. At the largest body that is a few hundred megabytes
for the length of one request, next to a model of 16 GB or more.

## Size

`size` defaults to `"1024x1024"` today. That default can't tell "the caller
asked for 1024x1024" from "the caller said nothing", and an edit should keep
its picture's shape. So the default becomes `""`.

| Call | What `""` means |
|---|---|
| No input image | 1024x1024, as before |
| With `images` | The first reference's shape, at one megapixel or less |
| With `startImage` | The start image's shape, at one megapixel or less |

### The size taken from a picture

`derived_size(width, height)` in the rules module turns a picture's size into
an output size:

1. If the picture has more than 1,048,576 pixels, scale it down to that many,
   keeping its shape. A picture is never scaled up.
2. If a side is still over 2048, scale down again until it is 2048.
3. Round each side down to a multiple of 16.
4. If a side is now under 256, refuse: "the picture is 200x1000, which is
   too small or too narrow to take a size from. Pass size."

| Picture | Output size |
|---|---|
| 1024x1024 | 1024x1024 |
| 4000x3000 phone photo | 1168x880 |
| 300x300 | 288x288 |
| 2896x362 | 2048x256 |
| 200x1000 | refused |

One megapixel is the pixel budget of the default size, so an edit of a large
photo takes about as long as a plain generation. A caller who wants more
passes `size`.

### A size the caller gives

A size the caller gives always wins.

Each image is then fitted to the output size the way its row's `fit` says:

- **`shrink`, for references.** They can stay any shape, because the model
  only looks at them. One over a megapixel is scaled down to a megapixel,
  which klein would do itself under the generation lock.
- **`cover`, for the start image.** It is scaled to cover the output size,
  and the overflow is cropped evenly from both sides. A 4:3 photo redrawn at
  1024x1024 loses a strip from its left and right edges.
- **`letterbox`, for the control image**, as today.

`fit_box(fit, source_width, source_height, width, height)` in the rules
module does the arithmetic for all three.

The start image is not letterboxed the way a control image is. For a control
image, black means "no lines here". For a start image, black bands are part
of the picture, and the model would redraw them as black bars.

### When the size is known

`check_request` returns `width` and `height` today, from the `size` string
alone. With an empty `size` and an input image, they depend on the picture,
and the rules module cannot open a picture: it must run without Pillow or
torch.

So `check_request` no longer returns a width and a height. It returns
`size`: the size the caller gave, or `None`. The server decodes the input
images and then calls one function:

```python
width, height = output_size(request["size"], first_image_size)
```

| Caller's size | Input image | Result |
|---|---|---|
| given | any | the caller's size |
| none | yes | `derived_size` of the first image |
| none | no | 1024x1024 |

The size is computed once and passed to `fit_box` and `pipeline_args`. The
checked request is never changed after `check_request` returns it.

`output_size`, `derived_size`, `fit_box`, and `steps_run` are functions of
numbers, so the rules tests cover them without an image.

## The timeout

`localImageTimeoutMs` budgets from the steps and the output size. Each
reference adds about 4,000 tokens to every step, as much as one more
megapixel of output. So the provider budgets one extra megapixel per
reference. The stdlib passes the number of references to the provider, which
does not look inside the request's fields.

An empty `size` is budgeted as 1024x1024. That is the size of a plain call
with no size, and a size taken from a picture is never more than one
megapixel. A size the provider cannot parse is budgeted at the largest size,
as today.

The plan's measurements of 1, 2, and 4 references check that
the budget holds.

## Approval

Each path in `images`, and `startImage`, raises `std::readImage` with the file's
folder and name, before anything is read. This is the same effect the control
image raises. The file stays on this machine, so it is a local read, not
`std::uploadImage`.

Every check runs before the first prompt, so a call that is going to fail
asks for nothing, as in `pasteImages` and `generateImage`. One TypeScript
function, `_localImageInputs`, makes all the checks and returns the files to
approve:

```ts
const inputs = try _localImageInputs(
  controlnet,
  controlImage,
  controlScale,
  invertControlImage,
  images,
  startImage,
  strength,
)
if (isFailure(inputs)) {
  return inputs
}
for (file in inputs.value.files) {
  raise std::readImage(file.question, { dir: file.dir, filename: file.filename })
}
```

The function refuses two modes in one call, a setting of another mode, too
many images, and any path that is not a local image file under its size cap.
It replaces the ControlNet checks that `generateImageLocal` makes in Agency
code today, with the same messages.

## The stdlib signature

```ts
export def generateImageLocal(
  prompt: string,
  model: string,
  size: string = "",
  steps: number | null = null,
  guidance: number | null = null,
  seed: number | null = null,
  negativePrompt: string = "",
  format: string = "png",
  lora: string = "",
  loraScale: number | null = null,
  controlnet: string = "",
  controlImage: string = "",
  controlScale: number | null = null,
  invertControlImage: boolean = false,
  images: string[] = [],
  startImage: string = "",
  strength: number | null = null,
): Result<LocalImage> raises <std::readImage>
```

The new parameters go last so existing positional calls keep working. The
docstring is also the tool description an LLM sees, so it says, in plain
words, which to use:

- `images`: "Pictures to edit, as paths to files on this machine. The prompt
  says what to change: 'add a hat to the character'. Only FLUX.2 [klein]
  takes them, and at most 4."
- `startImage`: "A picture to redraw, as a path to a file on this machine.
  The layout stays and the style changes. Goes with strength. Every model
  but FLUX.2 [klein] takes one."
- `strength`: "How much of startImage to redraw, from 0 to 1. Low keeps it
  close, high changes more. Null uses the model's default."
- `size`: adds "Leave it empty when editing or redrawing a picture, and the
  result keeps the picture's shape."

## The agent this makes possible

```ts
import { generateImageLocal } from "std::image"

def editPicture(instruction: string, picture: string, outPath: string): string {
  """
  Edit a picture on this machine and save the result. Returns the path
  written.

  @param instruction - What to change, such as "add a red top hat"
  @param picture - The path of the picture to edit
  @param outPath - Where to save the edited picture, ending in .png
  """
  const edited = generateImageLocal(instruction, "flux2-klein-4b", images: [picture])
  if (isFailure(edited)) {
    return "The edit failed: ${edited.error}"
  }
  const written = writeBinary(outPath, edited.value.base64)
  if (isFailure(written)) {
    return "The edit could not be saved: ${written.error}"
  }
  return outPath
}

node main(request: string, picture: string) {
  const reply = llm(
    "${request}\n\nThe picture is at ${picture}.",
    tools: [editPicture],
  )
  print(reply)
}
```

The model gets the request and the picture's path, and calls `editPicture`.
The approval shows which file is read and which is written. With a local chat
model everything stays on the machine.

The agent gives the model a wrapper and not `generateImageLocal` itself, for
two reasons. `generateImageLocal` returns the image as base64, and as a tool
result that is megabytes of text the model cannot read as a picture. It also
writes nothing, so the image would be lost. The coding agent's
`generateImageFile` has the same shape as `editPicture`.

The model is told the path in words. It could also be shown the picture with
`image(picture)` from `std::thread`, but that sends pixels and no path.
`image(picture)` raises no interrupt today, and sends the file to a hosted
model without asking. That is a separate fix, listed in the "Not in this PR"
section of #1154.

## Tests

- Rules (python3, no torch): the three refusals of `mode_of`, the count and
  byte caps of each row, the family table's keys (every row has the same
  keys, and every pipeline named is for a known mode), `output_size` and
  `derived_size` with the tables above, `fit_box` for each fit, `steps_run`
  with the table above, the reference shape checks, and the body limit.
- ControlNet: the existing rules tests and the existing agency-js test pass
  with no change to what they expect.
- Server (`diffusersImageServer.test.ts`): the rules cases, and that the
  script is valid Python. The pipeline branches are covered by the live test.
- Live (`diffusersImageServer.live.test.ts`, needs a model and a Mac GPU):
  a klein edit with one reference, and an image-to-image request followed by
  a plain request on the same server.
- Front door (`mlxServer.test.ts`): a body of 20 MB is forwarded, and one
  over the limit gets a 413.
- Provider (`mlxImage` tests): the timeout grows by one megapixel per
  reference.
- Both tables: the TypeScript table and the Python table have the same
  fields, counts, and byte caps, and the two body limits are equal.
- Stdlib (`image.test.ts`): the request carries bytes, never a path; a
  symlinked file, a file over 20 MB, and a URL are each refused before any
  request.
- agency-js (`image-generation-local-edit`, like `-controlnet`): one
  `std::readImage` per file with the right folder and name; a rejection sends
  no request; approval sends the bytes; a bad path asks nothing.
- A manual check on the M5 Ultra, recorded in the PR: the klein test again
  through `generateImageLocal`, a portrait phone photo to check the
  orientation, and one image-to-image run per family at strengths 0.3, 0.6,
  and 0.9, to set `default_strength`.

## Docs

- `docs/site/guide/image-generation.md`: an "Edit an image on your Mac"
  section with a klein example and an image-to-image example, and the agent
  above.
- `docs/dev/llm/local-images.md`: the new family keys, why references and
  image-to-image are separate parameters, the decode steps, the size rules,
  and the three size limits. Security constraints 7 and 9 name the control
  image only, and both change.
- `docs/dev/llm/mlx-local-models.md`: the front door's body limit.
- The `generateImageLocal` docstring, then `make` to regenerate
  `docs/site/stdlib/image.md`.

## Not in this spec

- Inpainting (redraw only a masked area). diffusers has pipelines for it,
  including `Flux2KleinInpaintPipeline`, but someone has to draw the mask.
- Qwen-Image-Edit, unless klein proves not good enough.
- ControlNet together with image-to-image.
- klein's base (not step-distilled) checkpoint.
- A separate `editImageLocal` function. `generateImageLocal` now has 17
  parameters, and three of them apply to some families only. One function
  matches how LoRA and ControlNet were added. Splitting it is a change to
  make for all of them at once.

## Open questions

1. Is 4 the right cap on klein references? Each reference adds about 4,000
   tokens at one megapixel, so time and memory grow with each one. The plan
   measures seconds and peak memory for 1, 2, and 4 references and picks the
   cap from that. The catalog describes this model as being for Macs with
   less memory, and one reference already peaked at 28 GB.
2. Do 8 steps fix instructions klein half-follows, like the one-hand wave?
   The test script takes `--steps 8`. If they do, the `steps` docstring says
   so.
