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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L41))

### ImageSize

Width and height in pixels.

```ts
/** Width and height in pixels. */
export type ImageSize = {
  width: number;
  height: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L49))

### GeneratedImage

```ts
export type GeneratedImage = {
  base64: string;
  mimeType: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L54))

### ImageQuality

```ts
export type ImageQuality = "low" | "medium" | "high" | "auto"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L59))

### LocalImage

```ts
export type LocalImage = {
  base64: string;
  mimeType: string;
  seed: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L97))

## Effects

### std::cropImage

```ts
@alwaysUnder(outDir)
effect std::cropImage {
  dir: string;
  filename: string;
  outDir: string;
  outFilename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L32))

### std::pasteImages

```ts
@alwaysUnder(outDir)
effect std::pasteImages {
  files: string[];
  outDir: string;
  outFilename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L37))

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
): Result<GeneratedImage>
```

Generate an image from a text prompt using a hosted provider, optionally
  editing input images. Returns a Result whose success value is
  { base64, mimeType }.

  @param prompt - What to generate (or how to edit the input images)
  @param model - Image model (default: the provider's default image model)
  @param provider - Override the provider (normally derived from the model name)
  @param size - Image size, e.g. "1024x1024" (provider-dependent)
  @param quality - Image quality: "low", "medium", "high", or "auto"
  @param images - Input images to edit/vary, as path / URL / data-URI strings
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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L61))

### generateImageLocal

```ts
generateImageLocal(
  prompt: string,
  model: string,
  size: string = "1024x1024",
  steps: number | null = null,
  guidance: number | null = null,
  seed: number | null = null,
  negativePrompt: string = "",
  format: string = "png",
  lora: string = "",
  loraScale: number | null = null,
): Result<LocalImage>
```

Generate an image on this machine with a local image model, such as
  z-image-turbo, chroma1-hd, or an SDXL finetune named by its diffusers:
  URI. The model must be running: start it with
  `agency local serve --image <model>`. Nothing leaves the machine and
  nothing is written; save the image with writeBinary. Returns a Result
  whose success value is { base64, mimeType, seed }.

  A LoRA adapter is a small file that teaches an SDXL model a style or a
  character. Load one when serving, `--lora sketch=./sketch.safetensors`,
  and name it here with `lora: "sketch"`. Only the request that names it
  gets it.

  @param prompt - What to draw
  @param model - The image model: a catalog name such as "z-image-turbo", a diffusers: URI, or a model directory
  @param size - Width and height joined by "x", each a multiple of 16, such as "1024x1024" or "1344x768"
  @param steps - How many refinement passes to make. More is slower and usually more detailed. Null uses the model's own default (9 for z-image-turbo, 40 for chroma1-hd, 28 for SDXL)
  @param guidance - How closely to follow the prompt; higher sticks to it more literally. Null uses the model's own default. z-image-turbo takes none
  @param seed - A number that fixes the randomness, so the same prompt and seed make the same image. Null picks one; the result says which
  @param negativePrompt - What the image should not contain. z-image-turbo takes none
  @param format - "png", "jpeg", or "webp"
  @param lora - The name of a LoRA adapter the server loaded with --lora. Empty applies none
  @param loraScale - How strongly to apply the adapter, from 0 to 2. Null is 1, as trained

**Parameters:**

| Name | Type | Default |
|---|---|---|
| prompt | `string` |  |
| model | `string` |  |
| size | `string` | "1024x1024" |
| steps | `number \| null` | null |
| guidance | `number \| null` | null |
| seed | `number \| null` | null |
| negativePrompt | `string` | "" |
| format | `string` | "png" |
| lora | `string` | "" |
| loraScale | `number \| null` | null |

**Returns:** `Result<LocalImage>`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L103))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L153))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L189))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L206))
