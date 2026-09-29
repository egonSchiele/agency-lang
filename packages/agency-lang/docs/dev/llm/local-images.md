# Local image generation

This command serves an image model on this Mac:

    agency local serve --image z-image-turbo

Agency code calls it through `std::image`:

    import { generateImageLocal } from "std::image"

    node main() {
      const r = generateImageLocal("a lighthouse in a storm", "z-image-turbo")
      if (isFailure(r)) { print("failed: ${r.error}"); return }
      writeBinary("lighthouse.png", r.value.base64)
    }

Each `--image` model gets its own process running
`lib/cli/diffusersImageServer.py`, behind the same front door as chat,
embedding, and speech processes. The process loads the model with Hugging
Face's diffusers library on the Mac GPU (torch's `mps` device) and answers
`POST /v1/images/generations` in the OpenAI shape:

    curl -s http://127.0.0.1:8080/v1/images/generations \
      -H 'content-type: application/json' \
      -d '{"model": "Tongyi-MAI/Z-Image-Turbo", "prompt": "a lighthouse in a storm", "seed": 1}'

A success is `{"created", "output_format", "data": [{"b64_json", "seed"}]}`.
A failure is `{"error": {"message": "..."}}`.

## The models

| Catalog name | Repo | Download | Steps | 1024×1024 on an M5 Ultra | Peak GPU memory |
|---|---|---|---|---|---|
| `z-image-turbo` | `Tongyi-MAI/Z-Image-Turbo` | 32.8 GB | 9 | 8.2 s | 29 GB |
| `chroma1-hd` | `lodestones/Chroma1-HD` | 27.5 GB | 40 | 90.5 s | 36 GB |

Both are apache-2.0 and have no content filter in their weights. The times
come from a timing run with diffusers 0.40.0 and torch 2.14.0 in bfloat16,
three images each. Loading took under 3 seconds from a warm file cache, and
the warm-up generation 4 to 6 seconds.

The memory warning `serve` prints adds up download sizes. An image model
uses more than that while it generates: Chroma peaks at 36 GB against
27.5 GB on disk. The warning is left as it is.

A third family, SDXL, is served but not in the catalog. Its finetunes for
illustration (NoobAI-XL, Illustrious) are the models people train LoRA
adapters for, and every one of them declares a restrictive license, so
none qualifies for the catalog's permissive-only rule. Name one by its
repo or directory:

    agency local download diffusers:Laxhar/noobai-XL-1.1
    agency local serve diffusers:Laxhar/noobai-XL-1.1

NoobAI-XL 1.1 downloads 6.9 GB (the repo's 7.1 GB single-file copy is
skipped) and makes a 1024×1024 image at 28 steps in about 6.5 s on an M5
Ultra, or 7.5 s with a LoRA adapter applied.

## The `diffusers` backend

An image model has its own backend, `diffusers`, next to `llama-cpp` and
`mlx`. It is named with a `diffusers:` URI, or by a directory with
`model_index.json` at the top and `.safetensors` weights one level down:

    agency local download diffusers:Tongyi-MAI/Z-Image-Turbo
    agency local serve --image /Volumes/models/hf/hub/models--Tongyi-MAI--Z-Image-Turbo/snapshots/f332072a…

`isDiffusersDir` in `lib/stdlib/modelBackend.ts` is the directory check.
`isModelDir` stays the MLX check, and a diffusers directory has no top-level
`config.json`, so a directory is never both. `servedDirBackend` says which
one a directory is. `modelDirSizeBytes` counts a diffusers model's component
folders too, since its weights are not at the top.

A downloaded diffusers model lives in `<modelsDir>/diffusers/<org>--<repo>/`
with the same `.agency-model.json` record an MLX model has, or in a Hugging
Face cache, where `list` and `serve` find it as they find an MLX snapshot.

What each command does with one:

| Command | A `diffusers` model |
|---|---|
| `agency local download` | Downloads only the files the pipeline reads (see "Downloading") |
| `agency local serve` | Serves it with `--image`, and refuses it without the flag even when the catalog does not know it |
| `agency local remove -f` | Deletes it from `<modelsDir>/diffusers/` |
| `agency run --local`, `agency agent --local` | Refuses: it is an image model |
| `speakLocal` | Refuses |

## Why Agency ships its own script

The server is ours rather than a third-party image server, for the reasons
`local-speech.md` gives for the speech server. The script defines which
request fields exist, refuses the ones a model cannot use, and keeps the
security properties below.

## Security

The five properties of the speech server hold here too:

1. Nothing in Agency starts a third-party image server.
2. No endpoint chooses a model. The process loads the one directory it was
   started with. The front door rewrites the `model` field and answers 404
   for any other name.
3. `trust_remote_code` and `custom_pipeline` are never passed.
4. Everything binds `127.0.0.1`.
5. Requests carry a JSON body, parsed strictly. A body over 64 KB is refused.

diffusers adds three:

6. **`use_safetensors=True` on every load.** A `.bin` or `.ckpt` weight file
   loads through Python's `pickle`, which runs code. With the flag, diffusers
   refuses a component that has no safetensors weights, and the downloader
   refuses such a repo before it writes anything.
7. **Offline at serve time.** The script sets `HF_HUB_OFFLINE=1` before
   importing diffusers and loads with `local_files_only=True`, so
   `from_pretrained` fetches nothing.
8. **The family table decides what gets imported.** `from_pretrained`
   imports whatever library and class `model_index.json` names. The server
   checks the file against the family table before importing diffusers, and
   loads the pipeline class the table names, never the one in the file.

## The rules module

`lib/cli/diffusersImageRules.py` holds every rule and imports nothing from
torch or diffusers, so CI runs it with plain `python3`
(`lib/cli/diffusersImageServer.test.ts`).

The family table, `FAMILIES`, is keyed by `_class_name` in
`model_index.json`:

| `_class_name` | Default steps | Max steps | Default guidance | Guidance and negative prompt |
|---|---|---|---|---|
| `ZImagePipeline` | 9 | 50 | 0.0 | refused |
| `ChromaPipeline` | 40 | 80 | 3.0 | accepted |
| `StableDiffusionXLPipeline` | 28 | 80 | 5.5 | accepted |

SDXL is the one family with `takes_lora`, and the one whose
`model_index.json` carries a setting that is not a component,
`force_zeros_for_empty_prompt`. A family row lists such settings under
`settings`, each with the one value allowed, and `family_of` refuses a
file that sets a different value or leaves it out, since the pipeline would
then fall back to its own default.

Each row also lists every component its `model_index.json` must name, as
`[library, class]`. A file that names another class, an extra component, or
too few is refused at start-up.

To add a family, add a row: the pipeline class, the model card's steps and
guidance, and the components copied from a real `model_index.json`. Then
time it on a Mac and add it to the catalog.

The size rules: two multiples of 16 joined by `x`, each side from 256 to
2048, and at most 4 million pixels, so `2048x1920` passes and `2048x2048`
does not. `n` must be 1, because the diffusers MPS guide says batched
generation can fail there. The caps bound how long one request holds the
generation lock.

## The version pin

The server refuses to start under any diffusers other than 0.40.0, the
version the rules were written against. `DIFFUSERS_VERSION` in
`localServe.ts` gives the same version to the setup hint, and a test checks
that the two constants match. `localServe.ts` also pins torch, transformers,
and accelerate to the versions the timing run used.

accelerate is optional to diffusers, but without it a model loaded in 10
seconds instead of 2.6 and diffusers warned about memory use, so `serve`
checks for it.

## Readiness

The script loads the model, makes one 512×512 image in two steps, and only
then opens its port. `waitUntilLoaded` probes an image process with
`GET /health`, as it does a speech process.

## Cancellation

diffusers calls `callback_on_step_end` after every step. The server's
callback checks whether the client hung up and, if so, raises an exception
that stops the pipeline. The server logs "Stopped after 4 of 30 steps: the
client hung up." and writes nothing.

The callback calls `torch.mps.synchronize()` before it checks. The GPU runs
behind Python: without the wait, the loop queues every step within the
first second, the check runs before the client could have hung up, and the
whole generation runs anyway. The wait did not change the timings.

A request waiting for the lock is checked once more when it gets the lock,
so a client that left while queued starts nothing.

The hung-up check, `client_gone`, and the `fail` helper live in
`lib/cli/localServerCommon.py`, which the speech server imports too.

## The `mlx` image provider

smoltalk's `image()` has no provider for the local server, so Agency
registers one with smoltalk's `registerImageProvider`, under the name `mlx`
(`lib/stdlib/mlxImage.ts`). `loadProviderModules` registers it at start-up,
before any user provider module, so `provider: "mlx"` works from the first
image call.

The name `mlx` is the server's, not the model's. `MLX_BASE_URL` and
`client.baseUrl.mlx` point at the front door `agency local serve` runs, and
every kind of model sits behind it. The provider sends no key, never retries
(a retry would queue behind the request that just failed), sends `steps`,
`guidance`, `seed`, and `negative_prompt` from `config.metadata`, reads the
seed back onto the image, and reports a cost of zero.

Its timeout scales with the request (`localImageTimeoutMs`): the slowest
family's measured rate per step per megapixel, doubled for attention's
growth, times the steps and size asked for, times two for a request that
may be queued ahead. A request that leaves steps to the model is budgeted
at the most any family allows, 80, which a test checks against the rules
module. At the caps the timeout is about 53 minutes. It is there to catch a
server that has stopped answering, not to bound a slow one; the caps on
steps and size do that.

## generateImageLocal

`_generateImageLocal` in `lib/stdlib/image.ts` refuses an empty prompt, a
format other than png, jpeg, or webp, and any model that is not a
`diffusers` model, before any request. It then goes through `generateOne`,
the accounting `generateImage` also uses: `meteredDispatch`, `recordUsage`,
the `imageGeneration` statelog event, and the guards.

It raises no interrupt. A local generation spends no money, sends nothing
off the machine, and writes nothing. Saving the image goes through
`writeBinary`, which raises its own effect.

## LoRA adapters

A LoRA adapter is a small file, tens of megabytes, that changes an SDXL
model's attention weights to draw a style or a character it was not
trained on. Training one is not the core package's job (see
`docs/superpowers/specs/2026-09-28-lora-package.md`). Using one is a
folder and a name. The folder is `client.adaptersDir` in `agency.json`:

    { "client": { "adaptersDir": "./adapters" } }

Every `.safetensors` file in it is an adapter, named by its file name
without the extension. A request names one with the `lora` field, and
says how strongly with `lora_scale`, from 0 to 2 with 1 as trained:

    generateImageLocal("sketch, a cat on a chair", "diffusers:Laxhar/noobai-XL-1.1", lora: "sketch")

`serve` passes the folder to every image process as `--adapters-dir`. The
process loads `sketch.safetensors` the first time a request names
`sketch`, under the generation lock, and keeps it loaded. Dropping a new
file into the folder makes it usable with no restart, which is the
train-try-adjust loop a person training adapters is in.

Three decisions:

1. **A request names a file only by its stem.** `adapter_path` in the
   rules module joins the name to the folder and refuses a name that is
   not one plain file name: empty, `.` or `..`, anything with a path
   separator, or one that already ends in `.safetensors`. So a program, or
   a model calling `generateImageLocal` as a tool, can pick from the
   folder the user configured and nothing else, and the server never
   opens a path a request wrote. The folder itself is refused at start-up
   when it is a symlink or not a directory.
2. **Only `.safetensors`.** A `.bin` or `.pt` adapter loads through
   `pickle`, which runs code. The extension is fixed by `adapter_path`, so
   no request can ask for another format, and a symlink at the file is
   refused when it is loaded. `load_lora_weights` reads tensors from the
   file and nothing else.
3. **Only the request that asks gets it.** An adapter changes every image,
   so `apply_lora` sets the pipeline to the request's adapter at its scale,
   or to none, under the generation lock, before every generation. The
   warm-up request names none.

A request naming an adapter when no folder is configured, or a family
that takes none, is refused with the config key or the family named. A
name the folder does not hold is a 400 listing what it does hold, read
fresh each time. `GET /health` lists the folder's adapter names the same
way.

## ControlNets

A ControlNet constrains a generation to a drawing: a stick figure becomes
the pose, a line drawing the composition. It is an inference-time input,
loaded like a LoRA adapter, so it lives here beside adapter loading and
not in the training package. The folder is `client.controlnetsDir`; each
entry is a diffusers ControlNet directory (`config.json` and its
`.safetensors`), named by its folder name. `agency local download
controlnet-scribble-sdxl` puts a catalog ControlNet there, keeping the
config and the one weights file, and refuses when the folder is not
configured, since there is nowhere else a ControlNet is useful.

A request names one with `controlnet` and the drawing with
`control_image`, an absolute path the server reads once after the checks
in `localServerCommon.check_image_path`, the same read the vision server
makes; `control_scale` is how strongly, 0 to 2 with 1 as the model card
says. The stdlib raises `std::readImage` for that drawing before the
request, so a call with a control image is the one local generation that
raises anything. One without the other is refused; the pair is refused
for Z-Image and Chroma; the name goes through `folder_entry`, the same
one-segment rule adapters use.

    generateImageLocal("pen and ink, zxq_girl, surprised", "diffusers:Laxhar/noobai-XL-1.1",
      lora: "zxq", controlnet: "controlnet-scribble-sdxl", controlImage: "./poses/jump.png")

On first use the server loads the ControlNet and builds
`StableDiffusionXLControlNetPipeline` from the base pipeline's
components plus it, so the UNet and encoders are shared and a LoRA
applied to the UNet applies to both. The control image is resized to
the request's size; a scribble whose mean brightness is above half is
inverted, since the scribble ControlNet was trained on white lines over
black. Nothing else is preprocessed: edges, depth, and pose extraction
are the vision server's job. `serve` refuses to plan a ControlNet, by
catalog kind or by its `config.json`, and says where it is loaded from.

Measured on an M5 Ultra against NoobAI-XL 1.1 with a LoRA applied: 8.4 s
for a 1024×1024 image without a ControlNet, 11.4 s for the first request
with the scribble ControlNet, which included loading it.

## Downloading

A diffusers repo often holds more than the pipeline reads. Chroma1-HD has
a 17.8 GB single-file copy of its transformer at the top. Other repos carry
`.bin` copies, fp16 variants, and README images.

`diffusersFiles` in `lib/stdlib/diffusersFiles.ts` keeps `model_index.json`
and the files directly inside the component folders it names, and drops
other weight formats and variant copies. A component folder with weights
but no plain `.safetensors` file fails the download, naming the component.

It needs the contents of `model_index.json` to know the folders, so the
download reads that one file into memory first with `fetchHubFileText`, then
filters the list, then downloads. Nothing is written until the list is
known, so an interrupted download never leaves a record that says a model
of one file is complete.

## The front door's log

A reply from an image process holds about a megabyte of base64. The door
never parses it. It knows the request path, the request's `output_format`,
and how many bytes went back, and every request makes one image:

    POST /v1/images/generations  Tongyi-MAI/Z-Image-Turbo  200  8.6s  1 image, 1.6 MB png

With `--verbose`, the reply shows as `<image reply, 1.6 MB>`. A failed reply
on that path is small JSON and is shown as any other.

## Python

Image processes use the Python `serve` chooses for every kind: `--python`,
`client.mlx.python`, `AGENCY_MLX_PYTHON`, then
`~/.agency-agent/mlx-env/bin/python`. `serve` imports only the modules the
requested kinds need, so an image-only user installs the image packages and
no MLX:

    ~/.agency-agent/mlx-env/bin/pip install torch==2.14.0 diffusers==0.40.0 transformers==5.17.0 accelerate==1.15.0 sentencepiece==0.2.2 protobuf==7.36.2

The packages install and run under Python 3.14 as well as 3.12.

## The opt-in test

`lib/cli/diffusersImageServer.live.test.ts` starts the real server, makes a
small image, and checks a cancelled request. It needs a model and a Mac GPU,
so it runs only with both variables set:

    AGENCY_IMAGE_MODEL_DIR=<a Z-Image or Chroma directory> \
    AGENCY_IMAGE_PYTHON=<a Python with the packages above> \
    pnpm vitest run lib/cli/diffusersImageServer.live.test.ts
