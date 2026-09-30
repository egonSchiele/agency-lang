---
name: "index"
---

# index

## Types

### TrainedLora

What a finished run produced.

```ts
/** What a finished run produced. */
export type TrainedLora = {
  path: string;
  steps: number;
  images: number;
  minutes: number;
  samples: string[]
}
```

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/lora/index.agency#L74))

### LoraInfo

What an adapter's file says about how it was trained.

```ts
/** What an adapter's file says about how it was trained. */
export type LoraInfo = {
  base: string;
  trigger: string;
  rank: number;
  steps: number;
  sizeBytes: number
}
```

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/lora/index.agency#L83))

## Effects

### lora::train

```ts
@alwaysUnder(outDir, imagesDir)
effect lora::train {
  imagesDir: string;
  base: string;
  outDir: string;
  outFilename: string;
  steps: number;
  estimatedMinutes: number
}
```

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/lora/index.agency#L42))

### lora::info

```ts
@alwaysUnder(dir)
effect lora::info {
  dir: string;
  filename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/lora/index.agency#L53))

## Constants

### STYLE_TAGS

```ts
export static const STYLE_TAGS = [
  "monochrome",
  "greyscale",
  "white background",
  "simple background",
  "traditional media",
  "sketch",
  "lineart",
  "signature",
  "text focus",
  "no humans",
]
```

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/lora/index.agency#L60))

## Functions

### trainLora

```ts
trainLora(
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
): Result<TrainedLora> raises <lora::train>
```

Train a LoRA adapter for an SDXL image model from a folder of images,
  each with an optional caption file (`a.txt` beside `a.png`, comma-separated
  tags). The trigger word is put in front of every caption. Takes minutes
  on a Mac GPU and writes the adapter as a .safetensors file, plus a
  before-and-after sample grid at every sampleEvery steps beside it.
  Everything runs on this machine, with the Python agency local serve
  uses. Returns the adapter's path and the sample grids.

  @param imagesDir - The folder of training images, PNG or JPEG, with optional .txt captions beside them
  @param trigger - The word the adapter answers to. A real phrase learns faster and keeps the base model's idea of it; a nonsense word owns the token
  @param base - The SDXL model to train on: a catalog name, a diffusers: URI, or a model directory, already downloaded
  @param outPath - The .safetensors file to write. It must not exist yet
  @param steps - How long to train. Too few and the style is faint; too many and every output is a training image. Judge by the sample grids
  @param rank - How much the adapter can hold: 8 for a style, 16 for a character, 32 for a character with a wardrobe. Doubling the rank doubles the file
  @param learningRate - Halve it if the grids get worse after getting better
  @param resolution - The training size. 768 trains twice as fast for a first look; 1024 for the real run
  @param flip - Also train on mirrored copies, which doubles a small set. Off for an asymmetric character
  @param seed - Fixes the randomness, so a run is repeatable
  @param samplePrompts - Prompts to render before and after at each checkpoint, to judge the run. Use the trigger word in them
  @param sampleEvery - Steps between sample grids. 0 for none

**Parameters:**

| Name | Type | Default |
|---|---|---|
| imagesDir | `string` |  |
| trigger | `string` |  |
| base | `string` |  |
| outPath | `string` |  |
| steps | `number` | 1000 |
| rank | `number` | 16 |
| learningRate | `number` | 0.0001 |
| resolution | `number` | 1024 |
| flip | `boolean` | false |
| seed | `number` | 1 |
| samplePrompts | `string[]` | [] |
| sampleEvery | `number` | 250 |

**Returns:** `Result<TrainedLora>`

**Throws:** `lora::train`

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/lora/index.agency#L91))

### loraInfo

```ts
loraInfo(path: string): Result<LoraInfo> raises <lora::info>
```

What an adapter file says about itself: the base model it was trained
  for, its trigger word, its rank, the steps it trained, and its size.
  Reads the file's header only.

  @param path - A .safetensors adapter written by trainLora

**Parameters:**

| Name | Type | Default |
|---|---|---|
| path | `string` |  |

**Returns:** `Result<LoraInfo>`

**Throws:** `lora::info`

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/lora/index.agency#L142))
