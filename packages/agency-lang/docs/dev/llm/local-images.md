# Local image generation

Local image generation runs a diffusers model on an Apple silicon GPU.
For setup and Agency examples, see the [image generation guide](../../site/guide/image-generation.md).
This document covers the server, provider integration, and constraints to
preserve when changing them.

## Source files

| File | Responsibility |
|---|---|
| `stdlib/image.agency` | Public functions and approval interrupts |
| `lib/stdlib/image.ts` | Input validation, approved file reads, dispatch, and usage accounting |
| `lib/stdlib/localImageInputs.ts` | The stdlib's copy of the input image table, the checks made before approval, and the body limit |
| `lib/stdlib/mlxImage.ts` | The local image provider and request timeouts |
| `lib/cli/diffusersImageServer.py` | Model loading and image generation |
| `lib/cli/diffusersImageRules.py` | Supported families, the input image table, request validation, size arithmetic, and adapter bookkeeping |
| `lib/cli/localServerCommon.py` | Shared HTTP helpers and image byte validation |
| `lib/stdlib/modelBackend.ts` | Recognition of diffusers model directories |
| `lib/stdlib/diffusersFiles.ts` | Selection of files to download |

The rules module must remain usable without torch or diffusers so CI can
test validation without loading a model.

## Serving a model

```bash
agency local serve z-image-turbo
```

Each image model runs in its own `diffusersImageServer.py` process behind
the local model server's shared HTTP endpoint. The process loads one model
on torch's `mps` device and answers `POST /v1/images/generations`.
The shared endpoint routes by model name and returns 404 for an unknown model.

Successful responses contain `created`, `output_format`, and a `data`
array with one `{ b64_json, seed }` entry. Errors use
`{ error: { message } }`.

A diffusers model can be named by its catalog alias, a `diffusers:` URI,
or its directory. `isDiffusersDir` recognizes `model_index.json` and
component weights. `servedDirBackend` selects the backend, and
`modelDirSizeBytes` includes the component folders when counting size.
The image server checks whether the directory contains a supported pipeline.

Downloads live in `<modelsDir>/diffusers/<org>--<repo>/` with an
`.agency-model.json` record. The local commands also discover models in
Hugging Face cache snapshots. Image models cannot be used as the chat
model for `agency run --local` or `agency agent --local`.

## Model loading and request limits

The `FAMILIES` table in `diffusersImageRules.py` defines the supported
pipeline classes and their defaults:

| Pipeline | Default steps | Maximum steps | Default guidance | Accepts guidance and negative prompts |
|---|---|---|---|---|
| `ZImagePipeline` | 9 | 50 | 0.0 | no |
| `ChromaPipeline` | 40 | 80 | 3.0 | yes |
| `QwenImagePipeline` | 50 | 80 | 4.0 | yes |
| `Flux2KleinPipeline` | 4 | 50 | 1.0 | no |
| `StableDiffusionXLPipeline` | 28 | 80 | 5.5 | yes |

Each row lists the component libraries and classes allowed in
`model_index.json`. Most components allow exactly one class. SDXL's
scheduler allows two, `EulerDiscreteScheduler` and
`EulerAncestralDiscreteScheduler`, because many community finetunes
ship the second. The server rejects missing or
extra components and unexpected classes before importing diffusers. It loads the pipeline
class named by the table. It does not let the model file choose imports.

The table also specifies required settings. FLUX.2 klein requires
`is_distilled: true`, which excludes the base model with different
inference requirements. SDXL requires `force_zeros_for_empty_prompt: true`.

`pipeline_args` translates validated requests into pipeline arguments.
Qwen-Image uses `true_cfg_scale` for guidance and needs a negative prompt
to enable it. Its default negative prompt is a single space.

Only SDXL enables `takes_lora`. Each row's `pipelines` key names the
diffusers class for each mode the family takes, as described in
[Modes](#modes). When adding a family, define its components, settings,
defaults, pipelines, and supported options in the table. Verify them against a model's
`model_index.json` and test generation on a Mac before adding a catalog entry.

All components must be available in the model directory. Models that
fetch a component from another repository cannot run on this server.
The downloader also rejects components with only variant weights, such
as fp16 copies, and no plain `.safetensors` weights.

A request generates one image. Width and height must each be a multiple
of 16 between 256 and 2048, with at most 4 million pixels in total.
For example, `2048x1920` is allowed and `2048x2048` is not. The size and
step limits bound how long a request can hold the generation lock.
[Output size](#output-size) covers a request that gives no size.

## Modes

A request is in one of four modes. The image field it carries decides
which:

| Mode | Image field | Other fields of the mode | Families |
|---|---|---|---|
| plain | none | none | all five |
| control | `control_image` | `controlnet`, `control_scale`, `control_invert` | SDXL |
| reference | `images` | none | FLUX.2 [klein] |
| img2img | `start_image` | `strength` | the other four |

In reference mode, klein draws a new image from pure noise and reads
each reference as extra tokens on every step. It copies from the
reference instead of repainting it, so an edit keeps the character.
There is no `strength`.

In img2img mode, the model starts from the start image with noise added,
instead of from pure noise. `strength` says how much noise, and so how
much of the picture is redrawn. The layout stays and the style changes.

Reference editing and image-to-image are different operations, so they
are different parameters: `images` and `startImage`. A caller who asks
klein for an edit never silently gets image-to-image from another
family. The request is refused instead, with a message naming the
families that take the mode.

`mode_of` in the rules module decides the mode and makes three
refusals:

1. Image fields of two modes: "a request takes one of control_image,
   images, or start_image." SDXL has a pipeline for a ControlNet with a
   start image, but nothing asks for it yet.
2. A field of a mode the request is not in, such as `control_scale`
   without `control_image`. The message names the image field the
   setting goes with. `MODE_FIELDS` lists each mode's fields.
3. A mode the family has no pipeline for. The message comes from the
   image field's `refusal` and names the families that take the mode.

A LoRA works in every mode. It is loaded into the shared weights, so
every pipeline of the family sees it.

### The input image table

`INPUT_IMAGES` in the rules module has one row per image field. The code
that checks a request, decodes an image, fits it, and picks a pipeline
reads the row. It has no branch per mode. `pipeline_args` is the one
exception: it adds `controlnet_conditioning_scale` in control mode, and
`strength` in img2img mode, where it also leaves out the size for SDXL.

| Key | Meaning | `control_image` | `images` | `start_image` |
|---|---|---|---|---|
| `mode` | The mode the field puts a request in | `control` | `reference` | `img2img` |
| `max_count` | How many images the field takes. One is a base64 string, more is a list | 1 | 4 | 1 |
| `max_bytes` | The largest image, in bytes | 50 MB | 20 MB | 20 MB |
| `fit` | How a decoded image is fitted to the output size | `letterbox` | `shrink` | `cover` |
| `on_white` | Paste a transparent image onto white before converting it to RGB | false | true | true |
| `sets_size` | With no size in the request, take the output's shape from the first image | false | true | true |
| `prepare` | Optional. A step in the server's `PREPARES` run on the decoded image before fitting | `invert` | none | none |
| `check` | Optional. A check in the rules module's `CHECKS` run on the decoded image's size | none | `reference_problem` | `start_image_problem` |
| `refusal` | The message for a family with no pipeline for the mode, with `{label}` and `{families}` | "does not take a ControlNet" | "does not take reference images" | "does not redraw a start image" |

A control image has `on_white` false because its background must stay
as drawn. A reference has it true because character art is often a PNG
with a transparent background, and converting it directly turns that
background black. `reference_problem` refuses a reference with a side
under 64 pixels or a shape more extreme than 8 to 1. klein makes both
checks itself, but from inside the pipeline call, where a failure is a
server error.

`start_image_problem` makes the same two checks on a start image, for
another reason. A start image is cropped to the output's shape, and a
tiny or thin picture has too little left after the crop to redraw. A
100x5000 picture cropped to a square keeps a fiftieth of itself.

`LOCAL_IMAGE_FIELDS` in `lib/stdlib/localImageInputs.ts` is the same
table for the stdlib, with the parameter name and the approval question
for each field. A test in `diffusersImageServer.test.ts` checks that
both tables have the same fields, counts, and byte caps.

### The pipelines table

The `pipelines` key of each family row names a diffusers class per mode.
A family takes a mode when it has a class for it:

| Family | `plain` | `control` | `reference` | `img2img` |
|---|---|---|---|---|
| Z-Image Turbo | `ZImagePipeline` | | | `ZImageImg2ImgPipeline` |
| Chroma | `ChromaPipeline` | | | `ChromaImg2ImgPipeline` |
| Qwen-Image | `QwenImagePipeline` | | | `QwenImageImg2ImgPipeline` |
| FLUX.2 [klein] | `Flux2KleinPipeline` | | `Flux2KleinPipeline` | |
| SDXL | `StableDiffusionXLPipeline` | `StableDiffusionXLControlNetPipeline` | | `StableDiffusionXLImg2ImgPipeline` |

The server loads the `plain` class. `pipeline_for` returns the loaded
pipeline when a mode's class is the plain class, as klein's reference
class is. Otherwise it builds the mode's class once from the loaded
pipeline's components and keeps it. The two pipelines share weights, so
the second one costs no extra memory or load time. A mode that needs a
model on top of those components names its request fields in the
server's `MODE_MODELS`. Control mode names `controlnet`, which
`load_controlnet` loads. Img2img mode needs no extra model.

### Image-to-image

The four img2img pipelines disagree on three things, and each family row
records them in three keys. klein has no img2img pipeline, so its three
are `None`.

| Family | `default_strength` | `img2img_takes_size` | `img2img_steps` |
|---|---|---|---|
| Z-Image Turbo | 0.6 | true | `"up"` |
| Chroma | 0.9 | true | `"up"` |
| Qwen-Image | 0.6 | true | `"up"` |
| SDXL | 0.6 | false | `"down"` |

`default_strength` is the strength a request gets when it gives none.
Three are the pipeline's own default in diffusers 0.40. SDXL's own
default is 0.3, which suits its use after a refiner and barely changes
a style, so SDXL starts at 0.6. These are first guesses, to be checked
by redrawing one picture with each family at 0.3, 0.6, and 0.9.

`img2img_takes_size` is false for SDXL because
`StableDiffusionXLImg2ImgPipeline` has no `width` or `height` argument.
It draws at the size of the image it is given. The other three take
both. The server fits the start image to the output size before the
call either way, so every family returns an image of the output size.

`img2img_steps` names how the pipeline counts the steps it runs.
Image-to-image skips the start of the schedule, so a request for 28
steps runs fewer. The families round the skipped part differently, and
`STEP_FORMULAS` in the rules module holds both formulas:

```python
# "down": SDXL rounds the steps it runs down
init_timestep = min(int(steps * strength), steps)
t_start = max(steps - init_timestep, 0)

# "up": the flow-matching pipelines round the steps they skip down,
# which rounds the steps they run up
init_timestep = min(steps * strength, steps)
t_start = int(max(steps - init_timestep, 0))

steps_run = steps - t_start
```

| Family | Steps | Strength | Steps that run |
|---|---|---|---|
| Z-Image Turbo | 9 | 0.1 | 1 |
| Z-Image Turbo | 9 | 0.6 | 6 |
| SDXL | 28 | 0.03 | 0 |
| SDXL | 28 | 0.6 | 16 |

Each formula is written as diffusers writes it, so floating point rounds
the same way. `9 * 0.6` is `5.3999999999999995` in floating point, and
the "up" formula runs 6 steps where a rounded-down count would say 5.
For a strength a person would pass, only "down" can reach 0 steps. "up"
reaches 0 only when the strength is too small for floating point to
count: `9 - 9 * 1e-20` is exactly `9.0`. `check_request` refuses a
request that runs no steps with either formula, "strength 0.03 with 28
steps runs no steps; raise either", instead of letting the pipeline fail
under the lock.

`check_request` returns the count as `steps_run`, and the server's
"Stopped after N of M steps" message uses it for M.

The img2img pipeline is built from the loaded pipeline's components,
scheduler included. In diffusers 0.40, `set_timesteps` resets the
scheduler's `_begin_index` on both schedulers these families use, so an
img2img request does not change the next plain one. The live test
checks this: a plain request after an img2img request makes the same
image as the same request made before it.

### Adding a mode

1. Add a row to `INPUT_IMAGES` and to `LOCAL_IMAGE_FIELDS`, with the
   same field name, mode, count, and byte cap.
2. Add the image field and the mode's other fields to `MODE_FIELDS`, to
   `FIELDS`, and to `SETTINGS` in `mlxImage.ts`.
3. Add the mode's class to the `pipelines` key of each family that takes
   it. Check in the diffusers source that the class can be built from
   the plain pipeline's components.
4. Add a fit to `FITS`, a step to `PREPARES`, or a check to `CHECKS` if
   the existing ones do not fit the mode.
5. Add the parameter to `generateImageLocal` and `_localImageInputs`.
   The body limits on both sides follow from the tables.
6. Add rules tests for the refusals, and an agency-js test for the
   approval, like `image-generation-local-edit`.

## Decoding an input image

`decode_image` in the server decodes every input image. It reads the
image's row and does these steps in order:

1. Open the bytes with Pillow, allowing only PNG, JPEG, WebP, and GIF.
2. Refuse an image over 40 megapixels before decoding its pixels.
3. Decode the pixels with `image.load()`. `Image.open` reads the header
   only, so a file that is cut short or damaged fails here. The server
   answers 400 and prints Pillow's error to stderr.
4. Apply the EXIF orientation with `ImageOps.exif_transpose`. A phone
   stores a portrait photo as landscape pixels plus a rotation tag.
   Without this step, an edit of a portrait photo comes back sideways.
5. When the row's `on_white` is true, paste a transparent image onto
   white. An image is transparent when it has an alpha band, or when it
   marks one color as transparent, as a palette or RGB PNG can.
6. Run the row's `check` on the upright image's size.
7. Convert to RGB.

After decoding, `prepared` runs the row's `prepare` step, and `fitted`
fits the image to the output size. All of this happens before the
generation lock is taken, so a bad image never waits for the GPU or
loads a ControlNet.

## Output size

`check_request` returns `size` as the request gave it, or `None`. The
server decodes the input images and then calls `output_size`:

| Request's size | Row's `sets_size` | Result |
|---|---|---|
| given | any | the request's size |
| none | true | `derived_size` of the first image |
| none | false, or no image | 1024x1024 |

A control request with no size still makes a 1024x1024 image. Its
drawing is letterboxed into that size.

`derived_size` turns a picture's size into an output size:

1. If the picture has more than 1,048,576 pixels, scale it down to that
   many, keeping its shape. A picture is never scaled up.
2. If a side is still over 2048, scale down again until it is 2048.
3. Round each side down to a multiple of 16.
4. If a side is now under 256, refuse and ask for a size.

| Picture | Output size |
|---|---|
| 1024x1024 | 1024x1024 |
| 4000x3000 | 1168x880 |
| 300x300 | 288x288 |
| 2896x362 | 2048x256 |
| 200x1000 | refused |

One megapixel is the pixel budget of the default size, so an edit of a
large photo takes about as long as a plain generation.

The size is computed once and passed to `fit_box` and `pipeline_args`.
The checked request is never changed after `check_request` returns it.
`fit_box` scales an image the way the row's `fit` says. The `FITS` table
in the rules module has one row per fit:

| Fit | What it does | Goes on a canvas of the output size |
|---|---|---|
| `letterbox` | Scales the image to fit inside the output and centers it | Yes, on black |
| `shrink` | Scales an image over one megapixel down to one megapixel | No |
| `cover` | Scales the image until it covers the output, and centers it. The overflow is cut off evenly from both sides | Yes, and the image covers all of it |

A start image is cropped with `cover`, not letterboxed. For a control
image, black bands mean "no lines here". For a start image, black bands
would be part of the picture, and the model would redraw them as black
bars. `cover` returns a negative `left` or `top`: a 400x300 picture
covering a 1024x1024 output would be 1365x1024 at left -171, so a strip
of about 170 scaled pixels is lost from each side.

The server never scales the whole picture. `visible_part` in the rules
module turns the box into the part of the picture that shows on the
canvas, here the middle 300 of its 400 columns, and `fitted` scales that
part alone with Pillow's `resize(size, box=...)`. Scaled whole, a 64x512
picture covering a 2048x256 output would be 2048x16384, about 100 MB,
to keep a 2048x256 strip of it.

klein shrinks a reference to one megapixel itself, but inside the
pipeline call, under the generation lock. The server shrinks it first.
Four references of 40 megapixels are about 480 MB as RGB, and with
`shrink` the server holds them only while it decodes.

## Size limits on the inputs

Three limits apply, from the outside in:

| Limit | Value | Where |
|---|---|---|
| One reference or start image | 20 MB | `_localImageInputs` before approval, `approvedFileBytes` after it, `image_bytes_of` on the server |
| One control image | 50 MB | the same three places |
| One request body | 64 KB plus the base64 of 80 MB, 106,732,204 bytes | the local front door and the image server |

A request carries one image field. The largest field is 4 references of
20 MB each, so the body limit is computed from that. `MAX_BODY_BYTES` in
the rules module and `localBodyBytes()` in `localImageInputs.ts` each
compute it from their own table, and the same test checks that they
are equal.
The front door holds requests for `/v1/images/generations` to it, as
`mlx-local-models.md` describes.

A reference over 20 MB buys nothing, because klein shrinks every
reference to one megapixel. A start image is scaled to the output size,
which is at most 4 megapixels.

## Security constraints

Preserve these constraints when changing loading or request handling:

1. The server loads only the model directory selected at startup.
2. All servers bind to `127.0.0.1`.
3. Model loads use `use_safetensors=True`. Pickle-based weight formats
   can execute code and must not be loaded.
4. The server sets `HF_HUB_OFFLINE=1` before importing diffusers and
   loads with `local_files_only=True`.
5. Loads do not pass `trust_remote_code` or `custom_pipeline`.
6. The family table controls pipeline imports and permitted components.
7. Requests use strictly parsed JSON. The body limit allows 64 KB of
   request fields plus the base64 of the most image bytes one image
   field may carry, from `INPUT_IMAGES`. Today that is 4 references of
   20 MB each.
8. Requests select adapters and ControlNets by a single name within
   configured folders. They cannot supply arbitrary paths for the server
   to open.
9. Every input image, in any image field, reaches the server as bytes
   after stdlib approval. `approvedFileBytes` rejects symlinks and files
   over the field's `max_bytes`. `image_bytes_of` checks the size again
   on the server against the same row. Pillow accepts only PNG, JPEG,
   WebP, and GIF, and images over 40 megapixels are rejected before
   decoding.

The stdlib enforces approval. A process that can reach the local HTTP
endpoint can submit image bytes directly, but the server cannot be asked
to read an input image from a path.

## Approval for input images

### Local generation

`generateImageLocal` returns an image in memory. Without an input image,
it raises no interrupt. Saving the result with `writeBinary` raises that
function's own effect.

A call with input images keeps this order:

1. `_localImageInputs` makes every check that can fail. It refuses a
   `controlnet` without a `controlImage` and the reverse, a `strength`
   without a `startImage`, a `strength` that is not above 0 and at most
   1, input images of two modes, more images than the field's `maxCount`, a URL or data URI,
   and any path that is not a regular image file under the field's
   `maxBytes`. It reads no bytes. A call that is going to fail asks for
   nothing.
2. The Agency function raises one `std::readImage` per file, with the
   file's `dir` and `filename` and the field's question. The control
   image asks "Read this drawing to condition the image on?", each
   reference asks "Read this picture to edit it?", and the start image
   asks "Read this picture to redraw it?". Every file is
   approved before any is read.
3. `image.ts` reads each file through `approvedFileBytes` and sends the
   base64 bytes in the field's request field.

A rejection of any one file returns before the request is sent. A
reference or a start image stays on this machine, so it raises `std::readImage` and not
`std::uploadImage`.

### Hosted generation

`generateImage` accepts local paths, HTTP(S) URLs, and data URIs in its
`images` argument. Each local file raises `std::uploadImage` before its
contents are read or sent. URLs and data URIs do not raise this effect.

`std::uploadImage` belongs to the `Network` capability set. It is separate
from `std::readImage`, so approving `FileRead` does not authorize uploads.
Its payload contains `dir`, `filename`, `provider`, `model`, and `baseUrl`.
An interactive "always" approval covers the selected model and files
under the selected directory.

`_imageDestination` reports the model and provider that the default
client would select. It uses `gpt-image-1` when no model is specified and
`"unknown"` when it cannot determine the provider. A custom client can
route differently. `baseUrl` contains the caller's explicit argument,
or an empty string when omitted.

Keep the following order in `generateImage`:

1. `_imageSources` resolves every local path through `_realTarget` and
   checks the extension, file type, and size without reading its contents.
   Invalid input fails before the first interrupt.
2. The Agency function raises one `std::uploadImage` interrupt per local
   file. Each payload describes one directory and filename for policy
   matching. All files must be approved before any contents are read.
3. `buildInput` reads through `approvedFileBytes` after approval. This
   checks again for symlinks and the size limit. It passes bytes and a MIME
   type to smoltalk, so the provider library never opens a local path.

A rejection returns before `_generateImage` runs and sends no request.
See [contained files](../stdlib/contained-files.md) for the path checks.

## LoRA adapters

`client.adaptersDir` in `agency.json` selects the adapter folder.
Relative paths resolve from the directory containing that config file.
`serve` passes the folder to image processes with `--adapters-dir`.

A request selects a `.safetensors` file by its name without the extension.
`lora_scale` ranges from 0 to 2 and defaults to 1. The server rejects
unsupported families, missing configuration, and invalid names.

The rules module owns folder validation and adapter bookkeeping through
`check_folder`, `existing_adapter`, `adapter_names`, and `LoadedAdapters`.
The loading code must preserve these behaviors:

- Accept only a single filename stem. Reject path separators, empty
  names, `.` and `..`, and names ending in `.safetensors`.
- Reject a configured folder that is a symlink or not a directory.
  Reject symlinked adapter files and load with `use_safetensors=True`.
- Apply the requested adapter and scale under the generation lock.
  Disable adapters for a request that names none.
- Assign a fresh internal name, such as `adapter_0`, to each load.
  Torch module names cannot contain dots, even though filenames can.
- Keep at most two adapters loaded. Evict the least recently used adapter
  before loading another.
- Reload a file when its modification time or size changes.
- Undo partial loads with `delete_adapters` before returning an error.
  SDXL can load the UNet adapter before failing on a text encoder.
  For a plain request, inspect `get_list_adapters` to disable any weights
  still held by the pipeline.

`GET /health` and missing-adapter errors list loadable files from the
folder. Files added after startup are available without a restart.

## ControlNets

`client.controlnetsDir` selects the ControlNet folder. Catalog downloads,
such as `controlnet-scribble-sdxl`, require this setting and write into it.
A ControlNet runs as part of an SDXL image request and cannot be served
as a standalone model.

Each ControlNet occupies a subdirectory containing regular
`config.json` and `diffusion_pytorch_model.safetensors` files.
`controlnet_problem` rejects symlinks anywhere inside that directory.
`controlnet_names` lists only directories that pass these checks.
Requests select a directory through the same single-segment name check
used for adapters. `control_scale` ranges from 0 to 2 and defaults to 1.

On first use, the server loads the ControlNet and builds a
`StableDiffusionXLControlNetPipeline` using the base pipeline's components.
The pipelines share the UNet and encoders, so a LoRA applied to the UNet
also affects ControlNet generation. `ControlNetModel.from_pretrained`
loads that fixed class without allowing `config.json` to choose an import.

`letterbox` scales the control image to fit the output size while
preserving its aspect ratio. With no size in the request, the output is
1024x1024, because the control row's `sets_size` is false. The server centers it on black.
The caller can invert the image with `invertControlImage`, sent as
`control_invert`, before fitting. The server does not infer inversion
from the filename or image brightness. It does not extract edges, depth,
or poses from the input.

## Provider integration

Agency registers the `mlx` image provider in `lib/stdlib/mlxImage.ts`.
`loadProviderModules` registers it before user provider modules.
`MLX_BASE_URL` and `client.baseUrl.mlx` select the shared local server
endpoint, including its diffusers processes.

The provider sends no API key and reports zero cost. It does not retry
failed requests. It reads generation options from `config.metadata` and
returns the server's seed with the image.

Both public image functions dispatch through `generateOne` in
`lib/stdlib/image.ts`. This shares usage accounting, the `imageGeneration`
statelog event, and guard enforcement.

`localImageTimeoutMs` scales the timeout with the requested steps and
pixel count, with allowances for attention cost and a queued request.
When steps are omitted, it budgets for 80, the largest family limit.
Keep that allowance in sync when changing the table. The timeout reaches
about 107 minutes at the size and step caps. An empty size is budgeted as
1024x1024, since a size taken from a picture is never larger.

Each reference adds about 4,000 tokens to every step, as much work as one
more megapixel of output. So the timeout adds one megapixel per
reference. The stdlib passes the count as `metadata.references`, from
`referenceCount`, which counts the images of a field whose
`readEachStep` is true. The provider does not look inside the request's
image fields.

A start image's `readEachStep` is false: the model starts from it once
and does not read it again. The timeout budgets the steps the request
asks for, which is more than an img2img request runs.

## Startup and cancellation

The server requires diffusers 0.40.0. `DIFFUSERS_VERSION` in
`localServe.ts` must agree with the Python constant. The setup instructions
also pin torch, transformers, and accelerate. `serve` checks that the
required packages are installed.

Image processes use the Python selected by `--python`, `client.mlx.python`,
`AGENCY_MLX_PYTHON`, or the default `~/.agency-agent/mlx-env/bin/python`,
in that order.

Before opening its port, the server loads the model and generates a
512×512 warm-up image in two steps. `waitUntilLoaded` probes `GET /health`.

The generation callback checks for a disconnected client after every
step. It calls `torch.mps.synchronize()` first so the GPU finishes the
step before Python queues more work. Removing that wait can allow the
entire generation to be queued before cancellation is detected.
A request also checks for disconnection after acquiring the generation lock.

`client_gone` and the HTTP error helper live in `localServerCommon.py`.
The speech server shares them.

## Downloading and logging

`diffusersFiles` keeps `model_index.json` and files directly inside the
component folders it names. It excludes alternative weight formats,
variant copies, and unrelated files. A component with weights but no
plain `.safetensors` file fails validation.

The downloader reads `model_index.json` into memory with
`fetchHubFileText` and validates the file list before writing downloads.

The shared HTTP server streams image replies without parsing their base64.
It logs the request path, format, response size, and duration. Verbose
logging replaces a successful response body with an image-size summary.
Error responses remain visible as JSON. In a logged request, each image
field is replaced with a note such as `<3 images, 4.2 MB>`.

## Tests

The rules tests cover request validation and folder checks without
loading torch. `tests/agency-js/image-upload-approval` covers hosted
upload approval, multiple inputs, rejection, and the bytes sent.
`tests/agency-js/image-generation-local-controlnet` covers control-image
approval and transmission. `tests/agency-js/image-generation-local-edit`
covers one `std::readImage` per reference and one for a start image, a
rejection that sends no request, and a bad path that asks nothing. Both agency-js tests start
their stand-in server in `server.js`, which `test.js` imports before the
program, so the environment is set before the program loads.

`decode_image`, `prepared`, and `fitted` need Pillow and no torch. Their
tests are the last block of `diffusersImageServer.test.ts`. The block
runs with `AGENCY_IMAGE_PYTHON` when it is set and with `python3`
otherwise, and it is skipped when that Python has no Pillow:

```bash
AGENCY_IMAGE_PYTHON=<a Python with Pillow> \
pnpm vitest run lib/cli/diffusersImageServer.test.ts
```

The live server test requires a downloaded model and a Mac GPU:

```bash
AGENCY_IMAGE_MODEL_DIR=<a Z-Image or Chroma directory> \
AGENCY_IMAGE_PYTHON=<a Python with the image packages> \
pnpm vitest run lib/cli/diffusersImageServer.live.test.ts
```

It generates a small image, checks cancellation, and redraws a start
image, then checks that the next plain request makes the same image as
before. Set
`AGENCY_KLEIN_MODEL_DIR` to a FLUX.2 [klein] directory to also run an
edit with one reference.
