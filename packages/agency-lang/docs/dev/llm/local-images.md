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
| `lib/stdlib/mlxImage.ts` | The local image provider and request timeouts |
| `lib/cli/diffusersImageServer.py` | Model loading and image generation |
| `lib/cli/diffusersImageRules.py` | Supported families, request validation, and adapter bookkeeping |
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

Each row lists the exact component libraries and classes allowed in
`model_index.json`. The server rejects missing or extra components and
unexpected classes before importing diffusers. It loads the pipeline
class named by the table. It does not let the model file choose imports.

The table also specifies required settings. FLUX.2 klein requires
`is_distilled: true`, which excludes the base model with different
inference requirements. SDXL requires `force_zeros_for_empty_prompt: true`.

`pipeline_args` translates validated requests into pipeline arguments.
Qwen-Image uses `true_cfg_scale` for guidance and needs a negative prompt
to enable it. Its default negative prompt is a single space.

Only SDXL enables `takes_lora` and `takes_controlnet`. Its
`controlnet_pipeline` is `StableDiffusionXLControlNetPipeline`.
When adding a family, define its components, settings, defaults, and
supported options in the table. Verify them against a model's
`model_index.json` and test generation on a Mac before adding a catalog entry.

All components must be available in the model directory. Models that
fetch a component from another repository cannot run on this server.
The downloader also rejects components with only variant weights, such
as fp16 copies, and no plain `.safetensors` weights.

A request generates one image. Width and height must each be a multiple
of 16 between 256 and 2048, with at most 4 million pixels in total.
For example, `2048x1920` is allowed and `2048x2048` is not. The size and
step limits bound how long a request can hold the generation lock.

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
   request fields plus the base64 representation of a 50 MB control image.
8. Requests select adapters and ControlNets by a single name within
   configured folders. They cannot supply arbitrary paths for the server
   to open.
9. Control images reach the server as bytes after stdlib approval.
   `approvedFileBytes` rejects symlinks and files over 50 MB.
   `image_bytes_of` checks the size again on the server. Pillow accepts
   only PNG, JPEG, WebP, and GIF, and images over 40 megapixels are rejected
   before decoding.

The stdlib enforces approval. A process that can reach the local HTTP
endpoint can submit image bytes directly, but the server cannot be asked
to read a control image from a path.

## Approval for input images

### Local generation

`generateImageLocal` returns an image in memory. Without a control image,
it raises no interrupt. Saving the result with `writeBinary` raises that
function's own effect.

A ControlNet call must provide both `controlnet` and `controlImage`.
The Agency function checks that pair and resolves the image path before
raising `std::readImage`. After approval, `image.ts` reads the file through
`approvedFileBytes` and sends its base64 bytes as `control_image`.
Rejection prevents the request.

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

`letterbox` scales the control image to fit the requested output size
while preserving its aspect ratio. The server centers it on black.
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
about 107 minutes at the size and step caps.

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
Error responses remain visible as JSON.

## Tests

The rules tests cover request validation and folder checks without
loading torch. `tests/agency-js/image-upload-approval` covers hosted
upload approval, multiple inputs, rejection, and the bytes sent.
`tests/agency-js/image-generation-local-controlnet` covers control-image
approval and transmission.

The live server test requires a downloaded model and a Mac GPU:

```bash
AGENCY_IMAGE_MODEL_DIR=<a Z-Image or Chroma directory> \
AGENCY_IMAGE_PYTHON=<a Python with the image packages> \
pnpm vitest run lib/cli/diffusersImageServer.live.test.ts
```

It generates a small image and checks cancellation.
