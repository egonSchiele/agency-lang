# `@agency-lang/lora`: training a LoRA adapter from Agency

Depends on `2026-09-28-local-models-dx.md` (the adapters folder, the
`kind` record, one Python environment) and pairs with
`2026-09-28-vision-models.md`, which makes the captions. This package
owns training. The core package owns loading what it produces.

## What this adds

A workspace package, `packages/lora`, in the shape of `kokoro` and
`tesseract-local`: an `index.agency` over a TypeScript implementation
that runs a Python trainer, `trainer/train_lora_sdxl.py`, which is the
spike's script with its conventions kept. Two functions and one
constant:

| Export | Job |
|---|---|
| `trainLora` | Train one adapter from a folder of images and captions. Minutes. Raises `lora::train`. |
| `loraInfo` | Read an adapter file's metadata: base model, trigger, rank, steps. Raises `std::readBinary`. |
| `STYLE_TAGS` | The tags a caption should drop so the style binds to the trigger word. |

Nothing here serves a model. `trainLora` needs the base model's files on
disk and the Python environment; it does not need `agency local serve`
to be running, and it does not talk to it.

Two functions were in an earlier draft and are not here. `captionFolder`
looped `tagImage` over a folder and wrote sidecars; `previewLora`
rendered a prompt with an adapter off and on and pasted the pair. Each
was a loop over tools the user already has (`glob`, `tagImage`, `write`,
`generateImageLocal`, `writeBinary`, `pasteImages` from the vision
spec), each did one thing, and each hid a choice, the drop list and the
seed, inside a function. They are examples in the package now, six to
ten lines each, and the one piece of knowledge they carried,
`STYLE_TAGS`, is exported on its own.

## Why a package

Training pulls in the training half of torch, the trainer's own
dependencies, and a folder of conventions about captions and datasets.
None of that is the language. The core package's contract with an
adapter is one line: it is a `.safetensors` file in the adapters folder.
Everything about how it got there lives here, can version on its own,
and can be skipped by anyone who downloads adapters instead of making
them.

## `trainLora`

```
effect lora::train {
  imagesDir: string,
  base: string,
  outDir: string,
  outFilename: string,
  images: number,
  steps: number,
  estimatedMinutes: number,
}

export def trainLora(
  imagesDir: string,
  trigger: string,
  base: string,
  outPath: string,
  steps: number = 1000,
  rank: number = 16,
  learningRate: number = 0.0001,
  resolution: number = 1024,
  flip: boolean = false,
  seed: number = 1,
  samplePrompts: string[] = [],
  sampleEvery: number = 250,
  pythonPath: string = "",
): Result<TrainedLora> raises <lora::train>

export type TrainedLora = {
  path: string,
  steps: number,
  images: number,
  minutes: number,
  samples: string[],
}
```

Before the interrupt, `trainLora` does everything that can fail cheaply:
resolves `imagesDir` and `outPath` to real spellings, counts the images
and reads their captions, checks that `base` resolves to a downloaded
`image` model of a family the trainer knows (SDXL to start), checks the
Python environment can import torch and diffusers, refuses an `outPath`
that is not `.safetensors` or that exists, and estimates the run from
the image count, the steps, and the resolution. All of that goes in the
payload, so the approver sees "113 images, 1200 steps, about 16 minutes,
writing ./adapters/sketch.safetensors" before anything runs.

After approval it runs the trainer as a child process with the network
disabled at the environment level (`HF_HUB_OFFLINE`, and the script's
own guard), streams its progress lines to the log, and returns the
adapter's real path with the sample grid paths. The child is killed on
Ctrl-C, a `race` loss, or a `guard` timeout, the way `screenshot` and
`say` abort their commands; a killed run leaves no adapter, since the
trainer writes to a temp name and renames at the end.

It is one effect, not one per file it writes. The run writes the
adapter, the sample grids, and a `train.json` beside them, all under
`outPath`'s directory, and the approver is approving the run. The sample
grid paths are returned so the caller can look at them; they are not
separately approved. A caller who wants finer control sets `sampleEvery`
to 0 and gets no grids.

### The knobs, and which are exposed

A trainer has thirty settings. Eight are worth a person's attention; the
rest are set to the values the spike used and are not parameters. The
rule: expose a setting when a person judging the sample grids would
change it, and hide one when only a person reading the loss curve would.

Exposed:

| Parameter | Default | Why a person would change it |
|---|---|---|
| `trigger` | required | The word the adapter answers to. A real phrase learns faster and carries the base model's prior; a nonsense word owns the token. The spike compared both. |
| `steps` | 1000 | The main dial. Too few, the style is faint; too many, every output is a training image. Judge by the grids. |
| `rank` | 16 | How much the adapter can hold. 8 for a style, 16 for a character, 32 for a character with a wardrobe. Doubles the file size each step. |
| `learningRate` | 1e-4 | Halve it if the grids get worse after getting better. Rarely raised. |
| `resolution` | 1024 | 768 trains twice as fast for a first look. Must match what the base was trained at for the final run. |
| `flip` | false | Doubles a small set with mirror images. Off for an asymmetric character. |
| `seed` | 1 | Reproducibility, and a second seed is a cheap second opinion. |
| `samplePrompts`, `sampleEvery` | none, 250 | What to render while training, and how often. The grids are how the run is judged. |

Hidden, fixed at the spike's values, with the reason:

- **alpha = rank**, so the adapter's scale is 1 and `loraScale` in
  `generateImageLocal` means what it says.
- **batch size 1**, gradient accumulation none. Larger batches need the
  learning rate retuned and gain little on one GPU with cached latents.
- **AdamW, weight decay 0.01, gradient clip 1.0.** Optimizer choice
  changes nothing a person can see in a grid.
- **The four attention projections** (`to_q`, `to_k`, `to_v`,
  `to_out.0`) in self- and cross-attention. Adding the feed-forward
  layers is what "LoRA on the whole UNet" means and mostly adds size.
- **Text encoder frozen.** Training it is how a trigger word can be made
  stronger, at the cost of the base model's vocabulary drifting. Not
  until someone shows a case that needs it.
- **No noise offset, no min-SNR weighting, no aspect buckets.** Each is
  a real improvement in a large trainer, and each is a paragraph of
  explanation for a number a person cannot judge. Buckets are the one to
  add first, when a set has many wide images that padding wastes.
- **Captions from sidecar files, style tags stripped by the caller.**
  The trainer prepends the trigger and nothing else.

The hidden values are in one dictionary at the top of the trainer with a
comment each, so changing one is a one-line edit for someone who has
read the doc, and not a parameter for someone who has not.

## `STYLE_TAGS`

```
export static const STYLE_TAGS = ["monochrome", "greyscale", "white background", "simple background", "traditional media", "sketch", "lineart", "signature", "text focus", "no humans"]
```

A caption that names the style teaches the model that the style belongs
to those words and not to the trigger word. A caption loop filters them
out before writing the sidecar:

    const kept = filter(tags, \tag -> !STYLE_TAGS.includes(tag.tag))

A caller training a character rather than a style keeps them.

## `loraInfo`

```
export idempotent def loraInfo(path: string): Result<LoraInfo> raises <std::readBinary>
export type LoraInfo = { base: string, trigger: string, rank: number, steps: number, sizeBytes: number }
```

Reads the safetensors header, which is JSON at the front of the file,
and returns the metadata the trainer wrote. No tensor is loaded. This is
how a program tells which adapter in the folder goes with which base
model before it asks the server for one.

## The trainer

`trainer/train_lora_sdxl.py`, the spike's script, with three changes:

1. Writes to `<outPath>.partial` and renames on completion, so a killed
   run leaves nothing that looks finished.
2. Prints one JSON line per progress event (`{"step", "loss",
   "secondsPerStep"}`, `{"sample": path}`) so the TypeScript side can
   log and return them without parsing prose.
3. Takes every hidden setting from the one dictionary described above.

It keeps: caching latents and text embeddings once; the hand-rolled
`LoRALinear` with the class-level off switch that renders the "before"
half of a grid from the same process; float32 adapter weights cast in
the forward pass; the VAE in float32; white padding rather than
cropping; the diffusers key format on save; and `HF_HUB_OFFLINE` and
`HF_HUB_DISABLE_TELEMETRY` set before torch is imported. It needs torch,
diffusers, and safetensors, which the image server's setup already
installs, and not `peft`.

The Python is chosen the way `serve` chooses it: `pythonPath`, then
`client.mlx.python`, then `AGENCY_MLX_PYTHON`, then
`~/.agency-agent/mlx-env/bin/python`. The package imports that resolver
from `agency-lang/stdlib-lib/`, as `kokoro` imports `_realTarget`.

## What an agent gets

`trainLora` is a tool like any other. Handed to a model as is, it can
train from any folder to any path, each run gated by `lora::train`,
which a person approves per run or by policy under a directory. Handed
partially applied, it is narrower:

    const trainSketch = trainLora.partial(base: "noobai-xl", imagesDir: "./dataset").rename("trainSketch")

That tool can only train from that folder on that base; the model
chooses the trigger, the steps, and the output name. `.preapprove()` on
top makes it run unattended, which is a choice the person makes with
the effect's payload in front of them, not a default.

## Tests

- The TypeScript half against a fake trainer script that prints the
  JSON lines and writes an empty `.safetensors`: argument checking, the
  payload, the rename on completion, the kill on abort, the Python
  resolution order.
- `loraInfo` against a checked-in 2 KB safetensors file with metadata
  and one tiny tensor.
- An Agency test that trains nothing: it calls `trainLora` with a fake
  Python and checks the interrupt payload's numbers.
- An opt-in live test, gated on a base model directory and a Python,
  that trains 20 steps at 512 on four fixture drawings and loads the
  result through diffusers' loader. Under a minute on a Mac.

## Not in this spec

- Training for Chroma, Flux, or Z-Image. The trainer is SDXL only; a
  flow-matching trainer is a second script behind the same `trainLora`
  with a `base` of another family, once one is written and measured.
- Training a ControlNet, or a detector. Both are days of GPU time and a
  different loop.
- A GUI, a queue, or a scheduler. `trainLora` runs one job in the
  foreground under the caller's guard; the caller decides what to do
  with the result.
