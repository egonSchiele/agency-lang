---
name: Image Generation
description: Generate and edit images with a hosted provider or a model on your Mac, style them with LoRA adapters you train yourself, and pose them with ControlNets.
---

# Image Generation

Agency can make images two ways:

1. `generateImage` sends your prompt to a hosted provider such as OpenAI or Google. It can also edit images you give it.
2. `generateImageLocal` runs an open model on your Mac. Nothing leaves the machine.

Both are in `std::image`, and both return the image as base64 in memory. You save it with `writeBinary`.

## Generate an image with a hosted provider

```ts
import { generateImage } from "std::image"

node main() {
  const r = generateImage("a red bicycle in the rain", size: "1024x1024")
  if (isFailure(r)) {
    print("generation failed: ${r.error}")
    return
  }
  writeBinary("bike.png", r.value.base64)
  print("saved bike.png")
}
```

`generateImage` returns a `Result`. On success, its value is `{ base64, mimeType }`. The image is not written to disk until you write it.

By default, `generateImage` uses OpenAI's `gpt-image-1` and reads your key from `OPENAI_API_KEY`.

### Save the image

`writeBinary(filename, base64)` decodes the base64 and writes the bytes. It works for any binary data: images, audio, PDFs. It is built in, so you don't need to import it.

Writing a file asks for approval under the `std::writeBinary` effect. Approve it on the command line:

```bash
agency run --approve std::writeBinary bike.agency
```

`readBinary(filename)` reads a file back as base64.

### Choose a provider and model

The provider comes from the model name, so most of the time you only set `model`:

```ts
// OpenAI (the default)
generateImage("a red bike")

// Google's "nano banana" (Gemini 2.5 Flash Image). Set GEMINI_API_KEY.
generateImage("a red bike", model: "gemini-2.5-flash-image")

// The higher tier, "nano banana pro"
generateImage("a red bike", model: "nano-banana-pro-preview")

// An open model through LiteLLM
generateImage("a red bike", provider: "litellm", model: "flux-pro", baseUrl: "https://your-litellm-host")

// Together AI, through its OpenAI-compatible endpoint
generateImage("a red bike", provider: "openai-compat", model: "black-forest-labs/FLUX.1-schnell", baseUrl: "https://api.together.ai/v1")
```

`size` and `quality` are passed to the provider. `apiKey` overrides the key from the environment. The [stdlib reference](/stdlib/image#generateimage) lists every parameter.

### Edit an image

Pass the images to edit in `images`. Each entry is a local path, an `http(s)` URL, or a `data:` URI.

```ts
const edited = generateImage("make it nighttime", images: ["bike.png"])
```

A local file has to be uploaded to the provider. So before anything is read, `generateImage` raises one `std::uploadImage` interrupt for each local file. The interrupt's data says which file it is and where it is going:

| Field | Example |
|---|---|
| `dir` | `/Users/me/project` |
| `filename` | `bike.png` |
| `provider` | `openai` |
| `model` | `gpt-image-1` |
| `baseUrl` | `""`, or the `baseUrl` you passed |

If you reject it, no request is sent. If you approve it, the file's bytes are sent. A URL or a `data:` URI reads no local file, so it asks nothing.

To approve the upload in your code, add `with approve` to the call:

```ts
const edited = generateImage("make it nighttime", images: ["bike.png"]) with approve
```

`with approve` approves every interrupt the call raises. To be more careful, use a [handler](/guide/handlers). This one approves uploads to OpenAI and rejects everything else:

```ts
import { generateImage } from "std::image"

node main() {
  handle {
    const r = generateImage("make it nighttime", images: ["bike.png"])
    if (isSuccess(r)) {
      print("edited the image")
    }
  } with (intr) {
    if (intr.effect == "std::uploadImage" && intr.data.provider == "openai") {
      return approve()
    }
    return reject()
  }
}
```

A [policy](/guide/policies) can make the same decision from a JSON file. This one approves uploads from one folder to OpenAI:

```json
{
  "std::uploadImage": [
    { "match": { "dir": "/Users/me/photos", "provider": "openai" }, "action": "approve" }
  ]
}
```

`std::uploadImage` is a separate effect from `std::readImage`, so approving local image reads does not approve uploads. It is in the `Network` capability set. It is not in `FileRead`.

### Ask a model about an image you made

A generated image is not added to the message thread. To ask about it, send it with your message:

```ts
import { generateImage } from "std::image"
import { image } from "std::thread"

node main() {
  const r = generateImage("a red bicycle")
  if (isFailure(r)) {
    print("generation failed: ${r.error}")
    return
  }
  const answer = llm([
    "What color is the bicycle in this image?",
    image(r.value.base64, r.value.mimeType, base64: true),
  ])
  print(answer)
}
```

Once it is sent, the image is part of the thread, so you don't need to send it again. Images make a thread's context much larger.

## Generate an image on your Mac

`generateImageLocal` runs an open image model on your Mac's GPU. It needs a Mac with Apple silicon and plenty of memory. An image model uses more memory while it generates than its size on disk.

### The models

The catalog has four image models:

| Model | Good for | Download | 1024×1024 on an M5 Ultra | Peak memory |
|---|---|---|---|---|
| `z-image-turbo` | Fast, photorealistic images | 32.8 GB | about 8 s | 29 GB |
| `chroma1-hd` | Detailed, cinematic pictures | 27.5 GB | about 90 s | 36 GB |
| `qwen-image-2512` | Legible text in the image: signs, posters, diagrams | 57.7 GB | not measured | not measured |
| `flux2-klein-4b` | Macs with less memory; 4 steps per image | 16.0 GB | not measured | not measured |

`z-image-turbo` and `chroma1-hd` have no content filter in their weights. `flux2-klein-4b` is safety fine-tuned.

SDXL models also work, but they are not in the catalog. You name one by its Hugging Face repo, such as `diffusers:Laxhar/noobai-XL-1.1`. NoobAI-XL and Illustrious are SDXL models tuned for illustration. They are the only models that take LoRA adapters and ControlNets. NoobAI-XL 1.1 is a 6.9 GB download and makes a 1024×1024 image in about 6.5 s on an M5 Ultra.

`agency local list --kind image` shows the image models and which ones you have downloaded.

### Set up Python

Image models run on Hugging Face's diffusers library. Install it, with torch, into the Python that `agency local serve` uses:

```bash
~/.agency-agent/mlx-env/bin/pip install torch==2.14.0 diffusers==0.40.0 transformers==5.17.0 accelerate==1.15.0 sentencepiece==0.2.2 protobuf==7.36.2
```

The versions are pinned. The server refuses to start under any other diffusers. To use a different Python, pass `--python <path>` to `agency local serve`.

### Download and serve a model

```bash
agency local download z-image-turbo
agency local serve z-image-turbo
```

`serve` reads what kind of model it is from the download, so it starts an image server without a flag. Leave it running in its own terminal. You can serve several models at once: `agency local serve z-image-turbo chroma1-hd`.

### Generate

```ts
import { generateImageLocal } from "std::image"

node main() {
  const r = generateImageLocal("a lighthouse in a storm", "z-image-turbo", seed: 7)
  if (isFailure(r)) {
    print("failed: ${r.error}")
    return
  }
  writeBinary("lighthouse.png", r.value.base64)
  print("made with seed ${r.value.seed}")
}
```

The result is `{ base64, mimeType, seed }`. The call asks for no approval, because nothing leaves the machine and nothing is written. The one exception is a call with a ControlNet drawing, which reads a file. Saving the image with `writeBinary` still asks for approval.

These are the parameters:

| Parameter | Default | What it does |
|---|---|---|
| `prompt` | required | What to draw. |
| `model` | required | A catalog name, a `diffusers:` URI, or a model folder. |
| `size` | `"1024x1024"` | Width and height, each a multiple of 16 from 256 to 2048. At most 4 million pixels in all. |
| `steps` | the model's own | How many refinement passes. More is slower and usually more detailed. |
| `guidance` | the model's own | How literally to follow the prompt. |
| `seed` | random | Fixes the randomness. The same prompt and seed make the same image. |
| `negativePrompt` | none | What the image should not contain. |
| `format` | `"png"` | `"png"`, `"jpeg"`, or `"webp"`. |
| `lora`, `loraScale` | none, 1 | A LoRA adapter. See [below](#style-images-with-a-lora-adapter). |
| `controlnet`, `controlImage`, `controlScale`, `invertControlImage` | none | A ControlNet. See [below](#pose-an-image-with-a-controlnet). |

Leave `steps` and `guidance` out unless you have a reason to change them. Each model family has its own defaults and limits:

| Model | Default steps | Most steps | Default guidance | Takes guidance and a negative prompt |
|---|---|---|---|---|
| `z-image-turbo` | 9 | 50 | 0 | no |
| `chroma1-hd` | 40 | 80 | 3.0 | yes |
| `qwen-image-2512` | 50 | 80 | 4.0 | yes |
| `flux2-klein-4b` | 4 | 50 | 1.0 | no |
| SDXL (NoobAI-XL, Illustrious) | 28 | 80 | 5.5 | yes |

A model that takes no guidance or negative prompt says so if you pass one. The call fails with a message, and no image is made.

If no server is running for the model, the call fails with the `agency local serve` command to run.

## Style images with a LoRA adapter

A LoRA adapter is a small file that teaches an image model a style or a character from a few dozen example pictures. Only SDXL models take adapters. You can download adapters that other people have trained, or [train your own](#train-your-own-lora-adapter).

First, pick a folder for your adapters in `agency.json`:

```json
{ "client": { "adaptersDir": "./adapters" } }
```

A relative path is taken from the folder that `agency.json` is in. Set it before you start `agency local serve`, because the server reads it when it starts.

Put the adapter in that folder. It must be a `.safetensors` file. Then serve an SDXL model:

```bash
agency local download diffusers:Laxhar/noobai-XL-1.1
agency local serve diffusers:Laxhar/noobai-XL-1.1
```

Name the adapter by its file name without `.safetensors`. This call uses `./adapters/sketch.safetensors`:

```ts
const r = generateImageLocal("sketch, a cat on a chair", "diffusers:Laxhar/noobai-XL-1.1", lora: "sketch", loraScale: 0.9)
```

`loraScale` is how strongly the adapter is applied. 1 is as trained, a smaller number is subtler, and the most is 2. A call without `lora` gets the plain model.

The server loads an adapter the first time a call names it. A file you add to the folder later works without a restart. If you train an adapter again under the same name, the next call uses the new file.

## Train your own LoRA adapter

The `@agency-lang/lora` package trains an adapter on your Mac from a folder of pictures. It trains SDXL models only.

### Install it

The trainer uses the same Python as the image server, with the same packages. Set that up first ([Set up Python](#set-up-python)). Then install the package into your project:

```bash
npm install @agency-lang/lora
```

Import it with the `pkg::` prefix:

```ts
import { trainLora, loraInfo, STYLE_TAGS } from "pkg::@agency-lang/lora"
```

See [Agency packages](/guide/agency-packages) for how `pkg::` imports work.

### Prepare the pictures

Put a few dozen PNG or JPEG pictures in one folder, such as `./drawings`. Each picture can have a caption beside it: `cat.txt` next to `cat.png`. A caption is a list of tags separated by commas, describing what is in the picture:

```
1girl, glasses, reading, book, chair
```

Describe what is in the picture. Leave out how it is drawn. If every caption says `monochrome, sketch`, the model learns that the style belongs to those words, and your trigger word learns nothing. `STYLE_TAGS` lists the tags to leave out when you train a style. Keep them when you train a character.

You can caption the folder automatically with a tagger model from `std::vision`. Serve the tagger:

```bash
agency local download wd14-tagger
agency local serve wd14-tagger
```

Then run this program. It tags each picture, drops the style tags, and writes the caption file:

```ts
import { STYLE_TAGS } from "pkg::@agency-lang/lora"
import { tagImage } from "std::vision"
import { glob } from "std::shell"

node main() {
  const images = glob("*.png", "./drawings")
  if (isFailure(images)) {
    print("could not list ./drawings: ${images.error}")
    return
  }
  for (image in images.value) {
    const tagged = tagImage("./drawings/${image}", "wd14-tagger")
    if (isFailure(tagged)) {
      print("could not tag ${image}: ${tagged.error}")
    } else {
      const kept = filter(tagged.value) as tag {
        return !STYLE_TAGS.includes(tag.tag)
      }
      const names = map(kept) as tag {
        return tag.tag
      }
      write(image.replace(".png", ".txt"), names.join(", "), "./drawings")
    }
  }
}
```

```bash
agency run --approve std::glob --approve std::vision --approve std::write caption.agency
```

Read a few captions before you train. Fix any that are wrong.

### Train

```ts
import { trainLora } from "pkg::@agency-lang/lora"

node main() {
  const r = trainLora(
    "./drawings",
    "pen and ink",
    "diffusers:Laxhar/noobai-XL-1.1",
    "./adapters/sketch.safetensors",
    steps: 1000,
    flip: true,
    samplePrompts: ["pen and ink, a cat sitting on a chair"],
  )
  if (isFailure(r)) {
    print("failed: ${r.error}")
    return
  }
  print("adapter at ${r.value.path} after ${r.value.minutes} minutes")
  print("sample grids: ${r.value.samples.join(", ")}")
}
```

The four required arguments are:

1. The folder of pictures.
2. The trigger word. The adapter answers to it, and it is added to the front of every caption.
3. The SDXL model to train on. It must be downloaded already.
4. The adapter file to write. It must end in `.safetensors` and must not exist yet.

Before it starts, `trainLora` raises a `lora::train` interrupt. The interrupt shows the folder, the base model, the output file, the number of steps, and an estimate of the minutes. Nothing is read or run until you approve it:

```bash
agency run --approve lora::train train.agency
```

On an M5 Ultra, a step takes about 0.8 seconds at 1024×1024. A thousand steps with sample grids takes about 15 minutes. Memory stays under 30 GB, and the adapter is about 93 MB.

These are the settings you are most likely to change:

| Parameter | Default | When to change it |
|---|---|---|
| `steps` | 1000 | Too few and the style is faint. Too many and every picture looks like a training image. |
| `rank` | 16 | 8 for a style, 16 for a character, 32 for a character with many outfits. Doubling it doubles the file. |
| `learningRate` | 0.0001 | Halve it if the sample grids get worse after getting better. |
| `resolution` | 1024 | 768 trains twice as fast, for a first look. |
| `flip` | false | Also trains on mirror images, which doubles a small set. Leave it off for a character who is not symmetrical. |
| `seed` | 1 | Makes a run repeatable. |
| `samplePrompts`, `sampleEvery` | none, 250 | Prompts to draw with and without the adapter every `sampleEvery` steps. |

The sample grids are how you judge a run. They are written to a folder beside the adapter, here `./adapters/sketch-samples/`. Each grid shows the prompt without the adapter and with it. Use the trigger word in your sample prompts.

`loraInfo("./adapters/sketch.safetensors")` reads an adapter's file header. It returns the base model, trigger word, rank, steps, and size.

### Use the adapter

The adapter was written to `./adapters`, the folder `client.adaptersDir` names. Serve the base model and ask for the adapter by name:

```bash
agency local serve diffusers:Laxhar/noobai-XL-1.1
```

```ts
import { generateImageLocal } from "std::image"

node main() {
  const r = generateImageLocal("pen and ink, a cat sitting on a chair, drinking tea", "diffusers:Laxhar/noobai-XL-1.1", seed: 7, lora: "sketch")
  if (isFailure(r)) {
    print("failed: ${r.error}")
    return
  }
  writeBinary("cat.png", r.value.base64)
}
```

To compare, run the same prompt and seed without `lora`. The package's [`previewAdapter.agency`](https://github.com/egonSchiele/agency-lang/tree/main/packages/lora/examples) example does this and puts the two images side by side with `pasteImages`.

The [package README](https://github.com/egonSchiele/agency-lang/tree/main/packages/lora) has more about each setting.

## Pose an image with a ControlNet

A ControlNet makes the image follow a drawing you give it. A stick figure becomes the pose of the character. Only SDXL models take ControlNets.

The catalog has two:

| ControlNet | Takes |
|---|---|
| `controlnet-scribble-sdxl` | A rough line drawing: white lines on black. |
| `controlnet-openpose-sdxl` | A rendered OpenPose skeleton. |

First, pick a folder for them in `agency.json`. As with `adaptersDir`, set it before you start the server:

```json
{ "client": { "controlnetsDir": "./controlnets" } }
```

Then download one. It goes into that folder, and the download fails if the folder is not set:

```bash
agency local download controlnet-scribble-sdxl
```

You don't serve a ControlNet. Serve the SDXL model, and name the ControlNet in the call:

```ts
const r = generateImageLocal("a dancer mid-leap", "diffusers:Laxhar/noobai-XL-1.1",
  controlnet: "controlnet-scribble-sdxl", controlImage: "./poses/jump.png", controlScale: 0.8)
```

`controlnet` and `controlImage` go together. `controlScale` is how strongly the drawing constrains the image, from 0 to 2. The default is 1.

This call reads the drawing from your Mac, so it raises a `std::readImage` interrupt that names the file. The drawing stays on your Mac.

The scribble ControlNet reads white lines on a black background. For dark lines on white paper, pass `invertControlImage: true`:

```ts
const r = generateImageLocal("a dancer mid-leap", "diffusers:Laxhar/noobai-XL-1.1",
  controlnet: "controlnet-scribble-sdxl", controlImage: "./poses/pen-sketch.png", invertControlImage: true)
```

The drawing is scaled to fit `size` without changing its shape, and centered on black. A 4:3 drawing in a square image gets black bands above and below.

You can use a ControlNet and a LoRA adapter in the same call.

## Limitations

- Each call makes one image.
- `generateImage` has no mask-based inpainting yet.
- Local image models need a Mac with Apple silicon.

## See also

- [Using local models](/guide/using-local-models): downloading, serving, and the vision models.
- [`agency local`](/cli/local): every command and flag.
- [`std::image` reference](/stdlib/image) and [`std::vision` reference](/stdlib/vision).
- [Interrupts](/guide/interrupts), [handlers](/guide/handlers), and [policies](/guide/policies).
