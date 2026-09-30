---
name: Image Generation
description: Generate and edit images, run image models on your Mac, and use LoRA adapters and ControlNets.
---

# Image Generation

You can generate images with a hosted provider such as OpenAI or with a
model running on your Mac. Both options use functions from `std::image`:

- `generateImage` sends a prompt to a hosted provider. You can also give
  it images to edit.
- `generateImageLocal` uses a local model. Your prompt and images stay
  on your machine.

Both functions return image data in memory. Use `writeBinary` to save
that data as a file.

## Generate an image with a hosted provider

Save this program as `bike.agency`:

```ts
import { generateImage } from "std::image"

node main() {
  const result = generateImage("a red bicycle in the rain", size: "1024x1024")
  if (isFailure(result)) {
    print("generation failed: ${result.error}")
    return
  }
  writeBinary("bike.png", result.value.base64)
}
```

By default, `generateImage` uses OpenAI's `gpt-image-1` model. Set your
`OPENAI_API_KEY` environment variable before running the program.

```bash
agency run --approve std::writeBinary bike.agency
```

The command approves writing the result to disk. `generateImage` returns
a `Result` whose success value contains `base64` and `mimeType`.
`writeBinary` decodes the base64 data and saves the image as `bike.png`.
It is a built-in function, so you do not need to import it.

### Choose a provider and model

```ts
generateImage("a red bike", model: "gemini-2.5-flash-image")
```

Agency normally chooses the provider from the model name. This example
uses Google's Gemini image model and requires `GEMINI_API_KEY`.

For a service with an OpenAI-compatible API, specify its provider and URL:

```ts
generateImage(
  "a red bike",
  provider: "openai-compat",
  model: "black-forest-labs/FLUX.1-schnell",
  baseUrl: "https://api.together.ai/v1",
)
```

You can also use `provider: "litellm"` with your LiteLLM server's model
name and URL. Pass `apiKey` to override the key from the environment.

The provider determines which `size` and `quality` values it supports.
See the [stdlib reference](/stdlib/image#generateimage) for all parameters.

### Edit an image

```ts
const edited = generateImage("make it nighttime", images: ["bike.png"])
```

Use `images` to supply one or more images to edit. Each entry can be a
local file path, an HTTP(S) URL, or a data URI.

Editing a local file requires sending its contents to the provider.
`generateImage` raises a `std::uploadImage` interrupt for each local file
before reading or sending any image data. If you reject an upload, the
function returns a failure without sending the request. URLs and data
URIs do not require approval to read a local file.

To review each upload in the terminal, save your editing program as
`edit.agency` and run:

```bash
agency run --interactive edit.agency
```

The interrupt identifies the file and the requested destination:

| Field | Example |
|---|---|
| `dir` | `/Users/me/project` |
| `filename` | `bike.png` |
| `provider` | `openai` |
| `model` | `gpt-image-1` |
| `baseUrl` | The URL you supplied, or `""` if you omitted it |

You can also approve uploads in code:

```ts
const edited = generateImage("make it nighttime", images: ["bike.png"]) with approve
```

`with approve` approves the interrupts raised by this call. Enclosing
handlers can still reject them. For approval based on the file or
provider, use a [handler](/guide/handlers):

```ts
import { generateImage } from "std::image"

node main() {
  handle {
    const edited = generateImage("make it nighttime", images: ["bike.png"])
    if (isFailure(edited)) {
      print("editing failed: ${edited.error}")
      return
    }
    print("edited the image")
  } with (intr) {
    if (intr.effect == "std::uploadImage" && intr.data.provider == "openai") {
      return approve()
    }
    return reject()
  }
}
```

This handler approves uploads to OpenAI and rejects other effects.
The edited image remains in memory until you save it.

You can express approval rules in a [policy](/guide/policies) file too:

```json
{
  "std::uploadImage": [
    {
      "match": { "dir": "/Users/me/photos", "provider": "openai" },
      "action": "approve"
    }
  ]
}
```

This rule approves uploads from `/Users/me/photos` to OpenAI. Save it as
`image-policy.json`, then apply it when running your program:

```bash
agency run --policy ./image-policy.json --interactive edit.agency
```

Uploads belong to the `Network` capability set. Permission to read
images locally, through `std::readImage` or `FileRead`, does not grant
permission to upload them.

### Ask a model about an image you made

```ts
import { generateImage } from "std::image"
import { image } from "std::thread"

node main() {
  const result = generateImage("a red bicycle")
  if (isFailure(result)) {
    print("generation failed: ${result.error}")
    return
  }
  const answer = llm([
    "What color is the bicycle in this image?",
    image(result.value.base64, result.value.mimeType, base64: true),
  ])
  print(answer)
}
```

Generating an image does not add it to the conversation. This example
attaches the result to an `llm` message using `image` from `std::thread`.
The image then stays in the thread for later messages. Images can use a
large part of the model's context window.

## Generate an image on your Mac

Local generation requires a Mac with Apple silicon and enough memory
for the model. Memory use during generation can exceed the model's
download size.

### Choose a model

```bash
agency local list --kind image
```

This command lists image models and shows which ones you have downloaded.
The catalog includes:

| Model | Intended use | Download |
|---|---|---|
| `z-image-turbo` | Fast, photorealistic images | 32.8 GB |
| `chroma1-hd` | Detailed, cinematic images | 27.5 GB |
| `qwen-image-2512` | Images containing text, such as signs and posters | 57.7 GB |
| `flux2-klein-4b` | Generation in four steps, with a smaller download. Also edits pictures. | 16.0 GB |

For a sense of speed, a 1024×1024 image took about 8 seconds with
Z-Image Turbo and 90 seconds with Chroma on an M5 Ultra. Peak memory use
was about 29 GB and 36 GB respectively. These measurements do not include
loading the model. Your results will depend on your hardware and settings.

You can also use SDXL models, including illustration models such as
NoobAI-XL and Illustrious. Specify these by their Hugging Face repository
because they are not in the catalog. Agency supports LoRA adapters and
ControlNets with SDXL models only.

### Set up Python

The local image server uses Hugging Face's diffusers library. Install
the required packages into the Python environment used by
`agency local serve`:

```bash
~/.agency-agent/mlx-env/bin/pip install torch==2.14.0 diffusers==0.40.0 transformers==5.17.0 accelerate==1.15.0 sentencepiece==0.2.2 protobuf==7.36.2
```

These are the package versions used by the server. It requires diffusers
0.40.0 and refuses to start with another version. If you use a different
Python environment, pass its Python path with `--python` when serving a model.
See [using local models](/guide/using-local-models) for environment setup.

### Download and serve a model

```bash
agency local download z-image-turbo
agency local serve z-image-turbo
```

Leave the server running in its own terminal. You can serve more than one
model by listing their names after `serve`:

```bash
agency local serve z-image-turbo chroma1-hd
```

Every model you serve stays in memory, so their memory use adds up.
Serving Z-Image Turbo, Chroma, and an SDXL model together used about
80 GB on an M5 Ultra once each had made an image. Check that your Mac
has room before you serve several: a Mac that runs out of memory slows
to a halt instead of reporting an error.

### Generate and save an image

Save this program as `lighthouse.agency`:

```ts
import { generateImageLocal } from "std::image"

node main() {
  const result = generateImageLocal("a lighthouse in a storm", "z-image-turbo", seed: 7)
  if (isFailure(result)) {
    print("generation failed: ${result.error}")
    return
  }
  writeBinary("lighthouse.png", result.value.base64)
  print("made with seed ${result.value.seed}")
}
```

Run it in a second terminal:

```bash
agency run --approve std::writeBinary lighthouse.agency
```

`generateImageLocal` returns a `Result` containing `base64`, `mimeType`,
and `seed` on success. This generation call needs no approval. Saving
the image requires `std::writeBinary` approval, which the command grants.
A call that reads a ControlNet drawing or a picture to edit also requires
`std::readImage` approval, as described in
[Pose an image with a ControlNet](#pose-an-image-with-a-controlnet) and
[Edit an image on your Mac](#edit-an-image-on-your-mac).

If the model is not running, the failure message includes the
`agency local serve` command you need.

### Adjust the result

```ts
const result = generateImageLocal(
  "a lighthouse in a storm",
  "chroma1-hd",
  size: "1344x768",
  seed: 7,
  negativePrompt: "text, watermark",
)
```

This example requests a wide image and names things to exclude from it.
Keeping the seed fixed lets you compare changes to the other settings.
To reproduce an image, keep the model, prompt, seed, and generation
settings the same.

| Parameter | Default | Purpose |
|---|---|---|
| `prompt` | Required | Describe the image to generate. |
| `model` | Required | Choose a catalog name, a `diffusers:` URI, or a model directory. |
| `size` | Empty | Set the width and height in pixels. Empty makes a 1024x1024 image, or keeps the shape of a picture you are editing. |
| `steps` | Model default | Set the number of refinement passes. More steps take longer. |
| `guidance` | Model default | Adjust how closely the image follows the prompt. |
| `seed` | Random | Control the randomness used for generation. The result includes the seed used. |
| `negativePrompt` | Empty | Describe things to exclude from the image. |
| `format` | `"png"` | Choose `"png"`, `"jpeg"`, or `"webp"`. |

Width and height must each be a multiple of 16 between 256 and 2048.
The image can contain at most 4 million pixels. For example, `2048x1920`
is allowed, but `2048x2048` exceeds the limit.

Start with the model's defaults for steps and guidance:

| Model | Default steps | Maximum steps | Default guidance | Accepts guidance and negative prompts |
|---|---|---|---|---|
| `z-image-turbo` | 9 | 50 | 0 | no |
| `chroma1-hd` | 40 | 80 | 3.0 | yes |
| `qwen-image-2512` | 50 | 80 | 4.0 | yes |
| `flux2-klein-4b` | 4 | 50 | 1.0 | no |
| SDXL | 28 | 80 | 5.5 | yes |

Z-Image Turbo and FLUX.2 klein reject requests that specify guidance or a
nonempty negative prompt. Leave those arguments out when using either model.

The following sections cover the additional parameters for LoRA adapters,
ControlNets, and editing pictures.

## Style images with a LoRA adapter

A LoRA adapter lets you apply a learned style or character to an image
model. You can download an adapter someone else has trained, or
[train your own](#train-your-own-lora-adapter). Agency supports adapters
for SDXL models.

Choose an adapter folder in `agency.json` before starting the server:

```json
{ "client": { "adaptersDir": "./adapters" } }
```

This path is relative to the directory containing `agency.json`.
Put your adapter's `.safetensors` file in that folder.

Download and serve the SDXL model the adapter was trained for. For example:

```bash
agency local download diffusers:Laxhar/noobai-XL-1.1
agency local serve diffusers:Laxhar/noobai-XL-1.1
```

Then select the adapter in a generation call:

```ts
const result = generateImageLocal(
  "sketch, a cat on a chair",
  "diffusers:Laxhar/noobai-XL-1.1",
  lora: "sketch",
  loraScale: 0.9,
)
```

This call uses `sketch.safetensors` from your adapter folder.
`loraScale` controls the strength of the adapter, from 0 to 2.
The default is 1. Lower values reduce its influence.
A call without `lora` uses the base model without an adapter.

You can add adapter files while the server is running. It loads each one
when first requested. If you replace an adapter file after training,
the next request reloads it.

## Train your own LoRA adapter

The `@agency-lang/lora` package trains an SDXL adapter on your Mac from
a folder of example images. Training uses the same Python environment
as the image server.

### Install the package

```bash
npm install @agency-lang/lora
```

Complete the [Python setup](#set-up-python) and download your SDXL base
model before training. Agency imports installed packages through the
[`pkg::` prefix](/guide/agency-packages):

```ts
import { trainLora, loraInfo, STYLE_TAGS } from "pkg::@agency-lang/lora"
```

### Prepare the images and captions

Put a few dozen PNG or JPEG images in a folder such as `./drawings`.
You can add a caption file beside each image: `cat.txt` for `cat.png`.
Write captions as comma-separated tags:

```text
cat, sitting, chair, window
```

For a style adapter, describe the objects and actions in each picture.
Leave style descriptions such as `monochrome` and `sketch` out of the
captions. This helps training associate the style with your chosen
trigger phrase. `STYLE_TAGS` lists tags to omit for style training.
Keep those tags when training a character adapter.

You can generate captions with a local tagger. Start it in a separate terminal:

```bash
agency local download wd14-tagger
agency local serve wd14-tagger
```

Save this program as `caption.agency`:

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

The program tags each PNG image, removes style tags, and writes a caption
beside the image. Run it with approval to list the folder, analyze the
images, and write captions:

```bash
agency run --approve std::glob --approve std::vision --approve std::write caption.agency
```

Review the captions and correct inaccurate tags before training.

### Train the adapter

Save this program as `train.agency`:

```ts
import { trainLora } from "pkg::@agency-lang/lora"

node main() {
  const result = trainLora(
    "./drawings",
    "pen and ink",
    "diffusers:Laxhar/noobai-XL-1.1",
    "./adapters/sketch.safetensors",
    steps: 1000,
    flip: true,
    samplePrompts: ["pen and ink, a cat sitting on a chair"],
  )
  if (isFailure(result)) {
    print("training failed: ${result.error}")
    return
  }
  print("adapter at ${result.value.path} after ${result.value.minutes} minutes")
  print("sample grids: ${result.value.samples.join(", ")}")
}
```

The four required arguments specify:

1. The folder of training images.
2. A trigger word or phrase to use in prompts, here `pen and ink`.
   Training adds it to the beginning of each caption.
3. The downloaded SDXL base model.
4. The output file. It must end in `.safetensors` and must not already exist.

Before training, `trainLora` raises a `lora::train` interrupt. It reports
the image folder, base model, output file, step count, and estimated
duration. To review and approve the run in your terminal:

```bash
agency run --interactive train.agency
```

You can instead approve training with `--approve lora::train`.
The trainer reads the images and starts training only after approval.

As a reference, training NoobAI-XL 1.1 for 1,000 steps at 1024×1024 with
sample grids took about 15 minutes on an M5 Ultra. The run used less
than 30 GB of memory and produced an adapter of about 93 MB at rank 16.

### Review samples and adjust training

The training example writes sample grids to `./adapters/sketch-samples/`.
Each grid compares an image made with the adapter to one made without it.
Include the trigger phrase in your sample prompts so you can judge how
well the adapter has learned the style.

| Parameter | Default | What to adjust |
|---|---|---|
| `steps` | 1000 | Increase for a faint style. Reduce if outputs copy the training images too closely. |
| `rank` | 16 | Controls adapter capacity and file size. Try 8 for a style or 16 for a character. |
| `learningRate` | 0.0001 | Try a lower value if samples improve at first and then get worse. |
| `resolution` | 1024 | Use 768 for a faster trial run. |
| `flip` | false | Include mirrored training images. Leave off for characters with asymmetric features. |
| `seed` | 1 | Keep fixed when comparing training settings. |
| `samplePrompts` | None | Supply prompts for sample grids. |
| `sampleEvery` | 250 | Set how many training steps pass between sample grids. |

You can inspect a trained adapter's metadata:

```ts
const info = loraInfo("./adapters/sketch.safetensors")
```

On success, the result includes the base model, trigger phrase, rank,
training steps, and file size.

### Use the trained adapter

Set `client.adaptersDir` to `./adapters` as shown in the
[adapter setup](#style-images-with-a-lora-adapter), then serve the base model:

```bash
agency local serve diffusers:Laxhar/noobai-XL-1.1
```

Use the trigger phrase in your prompt and select the adapter by name:

```ts
import { generateImageLocal } from "std::image"

node main() {
  const result = generateImageLocal(
    "pen and ink, a cat sitting on a chair, drinking tea",
    "diffusers:Laxhar/noobai-XL-1.1",
    seed: 7,
    lora: "sketch",
  )
  if (isFailure(result)) {
    print("generation failed: ${result.error}")
    return
  }
  writeBinary("cat.png", result.value.base64)
}
```

Compare the result with the same prompt and seed without `lora`.
The package's [`previewAdapter.agency` example](https://github.com/egonSchiele/agency-lang/tree/main/packages/lora/examples)
uses `pasteImages` to put the two results side by side.
See the [package README](https://github.com/egonSchiele/agency-lang/tree/main/packages/lora)
for more detail about training settings.

## Pose an image with a ControlNet

A ControlNet uses a drawing to guide an image's composition or pose.
For example, you can use a rough sketch to place a character in a scene.
Agency supports ControlNets with SDXL models.

| ControlNet | Input |
|---|---|
| `controlnet-scribble-sdxl` | A rough drawing with white lines on a black background |
| `controlnet-openpose-sdxl` | A rendered OpenPose skeleton |

Set the ControlNet folder in `agency.json` before starting the image server:

```json
{ "client": { "controlnetsDir": "./controlnets" } }
```

Then download a ControlNet and serve your SDXL model:

```bash
agency local download controlnet-scribble-sdxl
agency local serve diffusers:Laxhar/noobai-XL-1.1
```

The download uses the configured ControlNet folder. The image server
loads the ControlNet when you request it during generation:

```ts
const result = generateImageLocal(
  "a dancer mid-leap",
  "diffusers:Laxhar/noobai-XL-1.1",
  controlnet: "controlnet-scribble-sdxl",
  controlImage: "./poses/jump.png",
  controlScale: 0.8,
)
```

Provide both `controlnet` and `controlImage`. `controlScale` controls how
strongly the drawing influences the result, from 0 to 2, with a default of 1.

Reading the drawing requires `std::readImage` approval. Use
`--interactive` to review the request or `--approve std::readImage` to
approve it when running your program. The drawing stays on your Mac.

For dark lines on white paper, invert the drawing before using it:

```ts
const result = generateImageLocal(
  "a dancer mid-leap",
  "diffusers:Laxhar/noobai-XL-1.1",
  controlnet: "controlnet-scribble-sdxl",
  controlImage: "./poses/pen-sketch.png",
  invertControlImage: true,
)
```

`invertControlImage` swaps black and white to match the scribble
ControlNet's expected input. The server scales the drawing to fit the
output size while preserving its proportions. It fills any remaining
space with black, so a 4:3 drawing in a square image has bands above and below.

You can combine a ControlNet with a LoRA adapter by passing both
`controlnet` and `lora` in the same call.

## Edit an image on your Mac

FLUX.2 [klein] can edit a picture from an instruction. You give it a
picture and say what to change, such as "add a red top hat to the fox".
It draws a new image that follows the instruction and copies the rest
from your picture. Your picture stays on your Mac.

Download and serve the model:

```bash
agency local download flux2-klein-4b
agency local serve flux2-klein-4b
```

Save this program as `edit-fox.agency`:

```ts
import { generateImageLocal } from "std::image"

node main() {
  const result = generateImageLocal(
    "add a red top hat to the fox",
    "flux2-klein-4b",
    images: ["fox.png"],
    seed: 7,
  )
  if (isFailure(result)) {
    print("editing failed: ${result.error}")
    return
  }
  writeBinary("fox-hat.png", result.value.base64)
  print("made with seed ${result.value.seed}")
}
```

Run it in a second terminal:

```bash
agency run --approve std::readImage --approve std::writeBinary edit-fox.agency
```

Reading `fox.png` requires `std::readImage` approval, and saving the
result requires `std::writeBinary` approval. The command grants both.
Use `--interactive` instead to review each file. If you reject the read,
the function returns a failure and sends nothing to the image server.

### Choose the size

Leave `size` empty and the result keeps the shape of the first picture,
at one megapixel or less. A 4000x3000 photo from a phone becomes a
1168x880 image. A small picture is never scaled up, so a 300x300 picture
becomes a 288x288 image. Pass `size` to choose the width and height
yourself. The call fails without one when the picture is too small or
too narrow to take a shape from, such as a 200x1000 picture.

A picture must be at least 64 pixels on each side, and at most 8 times
as long as it is wide.

### Edit with more than one picture

You can pass up to 4 pictures. The prompt can refer to each one:

```ts
const result = generateImageLocal(
  "put the fox from the first picture in the forest from the second",
  "flux2-klein-4b",
  images: ["fox.png", "forest.png"],
  size: "1344x768",
)
```

Each picture raises its own `std::readImage` interrupt. Every picture is
approved before any of them is read. Each extra picture makes the edit
slower and uses more memory.

Only FLUX.2 [klein] takes `images`. Another model refuses the request
with a message naming the models that take them. You cannot combine
`images` with a ControlNet in one call.

### Redraw a picture in a new style

The other models can't follow an edit instruction, but they can redraw
a picture. Pass the picture in `startImage`, and describe the result in
the prompt. The model starts from your picture instead of from noise, so
the layout stays and the style changes:

```ts
const result = generateImageLocal(
  "a watercolor painting of a fox in a forest",
  "z-image-turbo",
  startImage: "fox.png",
  strength: 0.7,
)
```

`strength` says how much of the picture to redraw. It must be above 0
and can be at most 1. Leave it out to use the model's default.

The useful values are at the high end. In a test that redrew a cartoon
fox as a watercolor, a strength of 0.5 or less changed nothing you could
see, with every model. The style started to change around 0.7. Past a
certain strength the model stops following the layout and draws its own:

| Model | Default strength | Style starts to change | Layout is lost |
|---|---|---|---|
| `z-image-turbo` | 0.6 | 0.7 | 0.8 |
| `chroma1-hd` | 0.9 | 0.8 | Kept at 0.9 |
| SDXL | 0.6 | 0.8 | Kept at 0.9 |

These numbers come from one picture and one prompt, so use them as a
place to start. Keep the seed fixed and try a few strengths to find the
one that suits your picture.

Use `images` with FLUX.2 [klein] to change one thing and keep the rest,
such as "add a hat to the fox". Use `startImage` with any other model to
keep the layout and change everything else, such as turning a photo into
a watercolor. Only FLUX.2 [klein] takes `images`, and every other model
takes `startImage`.

As with `images`, leaving `size` empty keeps the picture's shape. When
you pass a size of another shape, the picture is scaled to cover it and
the extra is cropped evenly from both sides. For example, a 4:3 photo
redrawn at `"1024x1024"` loses a strip from its left and right edges.
The picture must be at least 64 pixels on each side and at most 8 times
as long as it is wide. Reading it raises a `std::readImage` interrupt,
and you cannot combine `startImage` with `images` or a ControlNet.

A lower strength runs fewer steps, so it is also faster. With SDXL at 28
steps, a strength of 0.6 runs 16 of them. A strength so low that no step
runs is refused.

### Let an agent edit pictures

This agent gives a model a tool that edits a picture and saves the
result:

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

node main() {
  const request = "Give the fox a red top hat and save it as fox-hat.png."
  const picture = "fox.png"
  const reply = llm(
    "${request}\n\nThe picture is at ${picture}.",
    tools: [editPicture],
  )
  print(reply)
}
```

The model reads the request and the picture's path, then calls
`editPicture`. Run it with `--interactive` to see which file the tool
reads and which file it writes before either happens. With a local chat
model, such as `agency run --local qwen3.5-2b --interactive edit-agent.agency`,
nothing leaves your Mac.

The tool saves the image and returns its path. If the model called
`generateImageLocal` directly, the tool result would be megabytes of
base64 text that the model cannot view as a picture, and nothing would
save the image.

## Limitations

- Each call generates one image.
- `generateImage` does not support mask-based inpainting.
- Local image generation requires Apple silicon.

## See also

- [Using local models](/guide/using-local-models) for model setup and local vision tools.
- [`agency local`](/cli/local) for commands and flags.
- [`std::image`](/stdlib/image) and [`std::vision`](/stdlib/vision) for the full API references.
- [Interrupts](/guide/interrupts), [handlers](/guide/handlers), and [policies](/guide/policies) for approval options.
