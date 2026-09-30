---
name: "image"
description: "Generate images from a text prompt with a hosted provider or a model on this machine, returning base64 you can persist."
---

# image

Generate images from a text prompt. `generateImage` uses a hosted
provider (OpenAI, Google, or an open-source model via LiteLLM / Together),
and can also edit input images. `generateImageLocal` uses a model on this
machine, served by `agency local serve --image`. Both return base64 you can
persist with `writeBinary()` or send onward with `std::thread`'s `image(...)`.

  ```ts
  import { generateImage } from "std::image"

  node main() {
    const r = generateImage("a red bicycle in the rain", size: "1024x1024")
    if (isFailure(r)) { print("failed: ${r.error}"); return }
    writeBinary("bike.png", r.value.base64)

    const local = generateImageLocal("a lighthouse in a storm", "z-image-turbo")
    if (isFailure(local)) { print("failed: ${local.error}"); return }
    writeBinary("lighthouse.png", local.value.base64)
  }
  ```

## Types

### ImageBox

A region of an image, normalized to 0..1 with the origin at the top
left, as std::ocr and std::vision return it.

```ts
/** A region of an image, normalized to 0..1 with the origin at the top
left, as std::ocr and std::vision return it. */
export type ImageBox = {
  x: number;
  y: number;
  width: number;
  height: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L55))

### ImageSize

Width and height in pixels.

```ts
/** Width and height in pixels. */
export type ImageSize = {
  width: number;
  height: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L63))

### GeneratedImage

```ts
export type GeneratedImage = {
  base64: string;
  mimeType: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L68))

### ImageQuality

```ts
export type ImageQuality = "low" | "medium" | "high" | "auto"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L73))

### LocalImage

```ts
export type LocalImage = {
  base64: string;
  mimeType: string;
  seed: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L134))

## Effects

### std::uploadImage

```ts
@alwaysUnder(dir)
@always(model)
effect std::uploadImage {
  dir: string;
  filename: string;
  provider: string;
  model: string;
  baseUrl: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L39))

### std::cropImage

```ts
@alwaysUnder(dir, outDir)
effect std::cropImage {
  dir: string;
  filename: string;
  outDir: string;
  outFilename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L46))

### std::pasteImages

```ts
effect std::pasteImages {
  files: string[];
  outDir: string;
  outFilename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L51))

## Functions

### generateImage

```ts
generateImage(
  prompt: string,
  model: string = "",
  provider: string = "",
  size: string = "",
  quality: ImageQuality = "auto",
  images: string[] = [],
  apiKey: string = "",
  baseUrl: string = "",
): Result<GeneratedImage> raises <std::uploadImage>
```

Generate an image from a text prompt using a hosted provider, optionally
  editing input images. Returns a Result whose success value is
  { base64, mimeType }.

  An input image that is a local file leaves the machine, so each one
  raises std::uploadImage first, naming the file, the provider, and the
  model. Nothing is read or sent until it is approved; a rejection sends
  no request. A URL or a data: URI reads no local file and asks nothing.

  @param prompt - What to generate (or how to edit the input images)
  @param model - Image model (default: the provider's default image model)
  @param provider - Override the provider (normally derived from the model name)
  @param size - Image size, e.g. "1024x1024" (provider-dependent)
  @param quality - Image quality: "low", "medium", "high", or "auto"
  @param images - Input images to edit or vary: a local path (.png, .jpg, .jpeg, .gif, or .webp), an http(s) URL, or a data: URI
  @param apiKey - Override the API key
  @param baseUrl - Base URL for openai-compat / litellm providers

**Parameters:**

| Name | Type | Default |
|---|---|---|
| prompt | `string` |  |
| model | `string` | "" |
| provider | `string` | "" |
| size | `string` | "" |
| quality | [ImageQuality](#imagequality) | "auto" |
| images | `string[]` | [] |
| apiKey | `string` | "" |
| baseUrl | `string` | "" |

**Returns:** `Result<GeneratedImage>`

**Throws:** `std::uploadImage`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L75))

### generateImageLocal

```ts
generateImageLocal(
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
  mask: string = "",
): Result<LocalImage> raises <std::readImage>
```

Generate an image on this machine with a local image model. The model
  must be running: start it with `agency local serve --image <model>`.
  Nothing leaves the machine and
  nothing is written; save the image with writeBinary. Returns a Result
  whose success value is { base64, mimeType, seed }.

  A LoRA adapter is a small file that teaches an SDXL model a style or a
  character. Put the file in your adapters folder (`client.adaptersDir`
  in agency.json) and pass its file name without .safetensors:
  `lora: "sketch"` for sketch.safetensors. Only the request that names it
  gets it.

  A ControlNet constrains the image to a drawing you give it: a stick
  figure becomes the pose. Download one into client.controlnetsDir and
  name it with `controlnet: "controlnet-scribble-sdxl"` and the drawing
  with `controlImage`. The drawing is read from this machine, under
  std::readImage, and never uploaded. It is scaled to fit `size` with its
  shape kept, and centered on black: a 4:3 drawing in a square image
  gets black bands above and below, and is never stretched.

  The scribble ControlNet reads white lines on black. For a drawing made
  with dark lines on white paper, pass `invertControlImage: true`.

  FLUX.2 [klein] edits pictures. Pass up to 4 paths in `images` and say in
  the prompt what to change: `generateImageLocal("add a hat to the
  character", "flux2-klein-4b", images: ["cat.png"])`. Each picture is read
  from this machine, under std::readImage, and never uploaded. With `size`
  left empty, the result keeps the first picture's shape.

  Every other model redraws a picture instead: pass its path in
  `startImage` and say in the prompt what it should become,
  `generateImageLocal("a watercolor painting", "z-image-turbo", startImage:
  "photo.png")`. The layout stays and the style changes; `strength` says
  how much changes. The picture is read under std::readImage too. It is
  scaled to cover `size` and the overflow is cropped from both sides, so a
  4:3 photo redrawn as a square loses a strip at its left and right.

  To redraw only part of the picture, also pass a `mask`: white is
  redrawn and black is kept.

  @param prompt - What to draw
  @param model - The image model: a catalog name such as "z-image-turbo", a diffusers: URI, or a model directory
  @param size - Width and height joined by "x", each a multiple of 16, such as "1024x1024" or "1344x768". Empty is 1024x1024. Leave it empty when editing or redrawing a picture, and the result keeps the picture's shape
  @param steps - How many refinement passes to make. More is slower and usually more detailed. Null uses the model's own default
  @param guidance - How closely to follow the prompt; higher sticks to it more literally. Leave it null unless asked: null uses the model's own default, and some models refuse any guidance
  @param seed - A number that fixes the randomness, so the same prompt and seed make the same image. Null picks one; the result says which
  @param negativePrompt - What the image should not contain. Leave it empty unless asked; some models refuse one
  @param format - "png", "jpeg", or "webp"
  @param lora - The file name, without .safetensors, of an adapter in the adapters folder (client.adaptersDir). Empty applies none
  @param loraScale - How strongly to apply the adapter, from 0 to 2. Null is 1, as trained
  @param controlnet - The name of a ControlNet in client.controlnetsDir, its folder name. Empty applies none. Goes with controlImage
  @param controlImage - The drawing the ControlNet conditions on: a scribble for a scribble ControlNet, a pose skeleton for openpose. Goes with controlnet
  @param controlScale - How strongly the ControlNet constrains the image, from 0 to 2. Null is 1
  @param invertControlImage - Swap black and white in the drawing before using it. Set it for dark lines on white with the scribble ControlNet, which reads white lines on black
  @param images - Pictures to edit, as paths to files on this machine. The prompt says what to change: 'add a hat to the character'. Only FLUX.2 [klein] takes them, and at most 4
  @param startImage - A picture to redraw, as a path to a file on this machine. The layout stays and the style changes. Goes with strength. Every model but FLUX.2 [klein] takes one
  @param strength - How much of startImage to redraw, above 0 and up to 1. Low keeps it close, high changes more. Null uses the model's default, which can change when a mask is added: for Z-Image Turbo it goes from 0.6 to 1.0, which redraws the white part from scratch
  @param mask - A black-and-white picture the same size as startImage, as a path to a file on this machine. White is redrawn and black is kept. Goes with startImage. Every model but FLUX.2 [klein] takes one

Redrawing part of a picture: pass a `mask` with `startImage`. The mask
is a picture the same size as the start image. White marks the part to
redraw and black the part to keep, so a white shape over a vase changes
only the vase:

  ```ts
  generateImageLocal("a vase of sunflowers", "z-image-turbo",
    startImage: "photo.png", mask: "vase-mask.png")
  ```

Grey redraws partly, so a mask whose edge fades from white to black
blends the new part in, where a hard edge can leave a faint seam. A
transparent part of a mask counts as black. The mask is read from this
machine under std::readImage, like the start image.

Each model has its own default strength with a mask, which can differ
from its default without one. Z-Image Turbo's goes from 0.6 to 1.0, and
1.0 draws the white part from scratch, keeping nothing of what was
there. Pass a lower strength to keep some of it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| prompt | `string` |  |
| model | `string` |  |
| size | `string` | "" |
| steps | `number \| null` | null |
| guidance | `number \| null` | null |
| seed | `number \| null` | null |
| negativePrompt | `string` | "" |
| format | `string` | "png" |
| lora | `string` | "" |
| loraScale | `number \| null` | null |
| controlnet | `string` | "" |
| controlImage | `string` | "" |
| controlScale | `number \| null` | null |
| invertControlImage | `boolean` | false |
| images | `string[]` | [] |
| startImage | `string` | "" |
| strength | `number \| null` | null |
| mask | `string` | "" |

**Returns:** `Result<LocalImage>`

**Throws:** `std::readImage`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L159))

### cropImage

```ts
cropImage(
  path: string,
  box: ImageBox,
  outPath: string,
  pad: number = 0,
  square: boolean = false,
): Result<string> raises <std::cropImage>
```

Cut a box out of an image and write it as a new image. Returns the path
  written. The box is normalized 0..1 from the top left, the shape
  detectObjects and readTextBlocks return. An existing output file is never
  overwritten.

  @param path - The image to cut from: PNG, JPEG, or WebP
  @param box - The region, as { x, y, width, height } in 0..1
  @param outPath - Where to write the cut. The extension picks the format
  @param pad - Grow the box by this fraction of its size on every side, so a tight detection keeps a margin. 0.05 is a small one
  @param square - Pad the cut to a square with its edge color, so a wide crop keeps its whole width in a square training image

**Parameters:**

| Name | Type | Default |
|---|---|---|
| path | `string` |  |
| box | [ImageBox](#imagebox) |  |
| outPath | `string` |  |
| pad | `number` | 0 |
| square | `boolean` | false |

**Returns:** `Result<string>`

**Throws:** `std::cropImage`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L272))

### imageSize

```ts
imageSize(path: string): Result<ImageSize> raises <std::readImage>
```

The width and height of an image in pixels.

  @param path - The image: PNG, JPEG, WebP, or GIF

**Parameters:**

| Name | Type | Default |
|---|---|---|
| path | `string` |  |

**Returns:** `Result<ImageSize>`

**Throws:** `std::readImage`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L308))

### pasteImages

```ts
pasteImages(
  paths: string[],
  outPath: string,
  columns: number = 2,
): Result<string> raises <std::pasteImages>
```

Lay images out on one white canvas, in rows of `columns`, each at its own
  size, and write the result. Two images side by side is a before and
  after; a folder in rows of eight is a contact sheet. Returns the path
  written. An existing output file is never overwritten.

  @param paths - The images, in reading order
  @param outPath - Where to write the canvas. The extension picks the format
  @param columns - How many images per row

**Parameters:**

| Name | Type | Default |
|---|---|---|
| paths | `string[]` |  |
| outPath | `string` |  |
| columns | `number` | 2 |

**Returns:** `Result<string>`

**Throws:** `std::pasteImages`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L325))
