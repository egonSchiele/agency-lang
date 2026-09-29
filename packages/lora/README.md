# @agency-lang/lora

Train a LoRA adapter for a local SDXL image model from a folder of
pictures, from Agency. A LoRA adapter is a small file, tens of megabytes,
that teaches a model a style or a character from a few dozen examples.
Everything runs on this machine, with Hugging Face offline.

## Installation

```
npm install @agency-lang/lora
```

Training needs the Python `agency local serve` uses, with the image
server's packages installed (torch, diffusers, and safetensors come with
them). The base model must be downloaded already:

```
agency local download diffusers:Laxhar/noobai-XL-1.1
```

## Usage

```ts
import { trainLora, loraInfo, STYLE_TAGS } from "pkg::@agency-lang/lora"

node main() {
  const r = trainLora(
    "./drawings",
    "pen and ink",
    "diffusers:Laxhar/noobai-XL-1.1",
    "./adapters/sketch.safetensors",
    steps: 1000,
    flip: true,
    samplePrompts: ["pen and ink, a cat on a chair"],
  )
  if (isFailure(r)) { print("failed: ${r.error}"); return }
  print("adapter at ${r.value.path} after ${r.value.minutes} minutes")
}
```

`trainLora` raises `lora::train` before it starts, with the folder, the
base model, the output path, the image count, the steps, and the
estimated minutes, so you approve the whole run with the numbers in front
of you. Write the adapter into your `client.adaptersDir` and a running
image server loads it by name the first time a request asks:

```ts
generateImageLocal("pen and ink, a cat on a chair", "diffusers:Laxhar/noobai-XL-1.1", lora: "sketch")
```

## The two functions and the constant

| Export | Job |
|---|---|
| `trainLora(imagesDir, trigger, base, outPath, ...)` | Train one adapter. Minutes. Raises `lora::train`. |
| `loraInfo(path)` | Read an adapter file's header: base model, trigger, rank, steps, size. Raises `lora::info`. |
| `STYLE_TAGS` | The tags a caption should drop so the style binds to the trigger word. |

There is no caption loop and no preview function here on purpose. Both
are a few lines of your own code over tools you already have, and the
`examples/` folder has them: `captionFolder.agency` (`glob`, `tagImage`, a
filter against `STYLE_TAGS`, `write`) and `previewAdapter.agency` (two
`generateImageLocal` calls with one seed, `writeBinary`, `pasteImages`).

## The knobs

Eight settings are parameters, because a person judging the sample grids
would change them. The rest are fixed at the values the first runs used,
in one dictionary at the top of `trainer/rules.py`, with a comment each.

| Parameter | Default | Why you would change it |
|---|---|---|
| `trigger` | required | The word the adapter answers to. A real phrase learns faster and keeps the base model's idea of it; a nonsense word owns the token. |
| `steps` | 1000 | The main dial. Too few, the style is faint; too many, every output is a training image. Judge by the grids. |
| `rank` | 16 | How much the adapter can hold: 8 for a style, 16 for a character, 32 for a character with a wardrobe. The file doubles each step. |
| `learningRate` | 1e-4 | Halve it if the grids get worse after getting better. |
| `resolution` | 1024 | 768 trains twice as fast for a first look. |
| `flip` | false | Doubles a small set with mirror images. Off for an asymmetric character. |
| `seed` | 1 | Repeatability, and a second seed is a cheap second opinion. |
| `samplePrompts`, `sampleEvery` | none, 250 | What to render before and after at each checkpoint. The grids are how a run is judged. |

## Captions

Each image may have a caption beside it, `a.txt` next to `a.png`, with
comma-separated booru tags: what is in the picture, not how it is drawn.
The trigger word goes in front of every caption. If every caption says
`monochrome, sketch`, the model learns the style belongs to those words
and the trigger learns nothing; that is what `STYLE_TAGS` is for.
`std::vision`'s `tagImage` writes tags in this vocabulary.

## Numbers

On an M5 Ultra against NoobAI-XL 1.1 at 1024×1024, rank 16: about 0.8 s a
step, so a thousand steps with sample grids is about 15 minutes, and the
adapter is 93 MB. Memory stays under 30 GB.
