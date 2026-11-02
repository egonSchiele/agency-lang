---
name: "image"
description: "Generate, edit, crop, and combine images."
---

# image

Generate images from a text prompt. `generateImage` uses a hosted
provider (OpenAI, Google, or an open-source model via LiteLLM / Together),
and can also edit input images. `generateImageLocal` uses a model on this
machine, served by `agency local serve --image`. Both return base64 you can
persist with `writeBinary()` or send onward with `std::thread`'s `image(...)`.

  ```ts
  import { generateImage, generateImageLocal } from "std::image"

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

Image bytes encoded as base64, with their MIME type.

```ts
/** Image bytes encoded as base64, with their MIME type. */
export type GeneratedImage = {
  base64: string;
  mimeType: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L69))

### ImageQuality

```ts
export type ImageQuality = "low" | "medium" | "high" | "auto"
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L74))

### LocalImage

Generated image data and the seed used for reproducibility.

```ts
/** Generated image data and the seed used for reproducibility. */
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

Generate or edit an image with a hosted provider. Local input images are uploaded.

Use a hosted image model for generation or editing. Each local input file
requires upload approval. URL and data-URI inputs do not read a local file.
Save the returned base64 with `writeBinary` when you need a file.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| prompt | `string` |  | What to generate or how to edit the inputs. |
| model | `string` | "" | Image model, or empty for the provider default. |
| provider | `string` | "" | Override the provider derived from the model name. |
| size | `string` | "" | Provider-supported size such as "1024x1024". |
| quality | [ImageQuality](#imagequality) | "auto" |  |
| images | `string[]` | [] | Input images as local PNG/JPEG/GIF/WebP paths, HTTP(S) URLs, or data URIs. |
| apiKey | `string` | "" | Override the API key. |
| baseUrl | `string` | "" | Custom endpoint for openai-compat or litellm. |

**Returns:** `Result<GeneratedImage>`

**Throws:** `std::uploadImage`

**Needs:** `fileRead`, `llm`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L82))

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

Generate or edit an image with a running local model. Returns image data
  for saving with writeBinary.

Start the model with `agency local serve --image <model>`. Save the returned
base64 with `writeBinary`.

For SDXL, a LoRA adapter changes the style or character. Put its
`.safetensors` file in `client.adaptersDir` and pass the filename without
that extension. A ControlNet uses a drawing to guide the composition. Put
it in `client.controlnetsDir` and pair `controlnet` with `controlImage`.
The drawing is scaled to fit and centered on black. Scribble ControlNets
expect white lines on black; invert a dark-on-white drawing.

FLUX.2 [klein] and Qwen-Image-Edit accept reference pictures in `images`.
Other models use `startImage` to redraw a picture. Its image is scaled to
cover the requested size, cropping any overflow. Leave `size` empty to
preserve the input's aspect ratio.

```ts
generateImageLocal("a vase of sunflowers", "z-image-turbo",
  startImage: "photo.png", mask: "vase-mask.png")
```

A mask selects the part to redraw: white changes, black stays, and grey
blends the two. Transparency counts as black. The mask must match the
start image's dimensions. Strength defaults can differ with a mask;
Z-Image Turbo uses 1.0 with one and 0.6 without one.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| prompt | `string` |  |  |
| model | `string` |  | Catalog name, diffusers: URI, or model directory. |
| size | `string` | "" | WxH with each side a multiple of 16 from 256 to 2048 and at most 4 million pixels; empty uses the input aspect ratio or 1024x1024. |
| steps | `number \| null` | null | Refinement passes, or null for the model default. |
| guidance | `number \| null` | null | Prompt adherence; leave null for the model default since some models reject overrides. |
| seed | `number \| null` | null | Random seed, or null to choose one and return it with the image. |
| negativePrompt | `string` | "" | Unwanted content; leave empty unless the model supports it. |
| format | `string` | "png" | Output format: png, jpeg, or webp. |
| lora | `string` | "" | SDXL adapter name in client.adaptersDir, without .safetensors. |
| loraScale | `number \| null` | null | Adapter strength from 0 to 2, or null for 1. |
| controlnet | `string` | "" | SDXL ControlNet folder in client.controlnetsDir, paired with controlImage. |
| controlImage | `string` | "" | Local conditioning drawing, paired with controlnet. |
| controlScale | `number \| null` | null | ControlNet strength from 0 to 2, or null for 1. |
| invertControlImage | `boolean` | false | Invert dark lines on white for a scribble ControlNet. |
| images | `string[]` | [] | Up to four local references for FLUX.2 [klein] or Qwen-Image-Edit; Qwen-Image-Edit requires at least one. |
| startImage | `string` | "" | Local picture to redraw; unsupported by FLUX.2 [klein] and Qwen-Image-Edit. |
| strength | `number \| null` | null | Fraction of startImage to redraw, greater than 0 and at most 1, or null for the model default. |
| mask | `string` | "" | Local mask matching startImage dimensions, with white to redraw and black to keep. |

**Returns:** `Result<LocalImage>`

**Throws:** `std::readImage`

**Needs:** `fileRead`, `subprocess`, `env`, `llm`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L167))

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

Crop an image into a new file without overwriting an existing output.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| path | `string` |  | Input PNG, JPEG, or WebP file. |
| box | [ImageBox](#imagebox) |  | Region normalized to 0..1 from the top left. |
| outPath | `string` |  | Output path whose extension selects the format. |
| pad | `number` | 0 | Expand each side by this fraction of the box size. |
| square | `boolean` | false | Pad to a square using the edge color. |

**Returns:** `Result<string>`

**Throws:** `std::cropImage`

**Needs:** `fileRead`, `fileWrite`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L243))

### imageSize

```ts
imageSize(path: string): Result<ImageSize> raises <std::readImage>
```

The width and height of an image in pixels.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| path | `string` |  | The image: PNG, JPEG, WebP, or GIF |

**Returns:** `Result<ImageSize>`

**Throws:** `std::readImage`

**Needs:** `fileRead`, `subprocess`, `env`, `llm`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L277))

### pasteImages

```ts
pasteImages(
  paths: string[],
  outPath: string,
  columns: number = 2,
): Result<string> raises <std::pasteImages>
```

Arrange images in rows and write a new file without overwriting existing output.

Use two columns for a before-and-after comparison, or more columns for a
contact sheet. Images keep their original sizes on a white canvas.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| paths | `string[]` |  | Input images in reading order. |
| outPath | `string` |  | Output path whose extension selects the format. |
| columns | `number` | 2 | Number of images per row. |

**Returns:** `Result<string>`

**Throws:** `std::pasteImages`

**Needs:** `fileRead`, `fileWrite`, `subprocess`, `env`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L299))
