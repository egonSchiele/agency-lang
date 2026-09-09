---
name: "ocr"
description: "Read the text in an image, locally with macOS Vision or through a vision model."
---

# ocr

Read the text in an image. `readText` and `readTextBlocks` run macOS
Vision on the machine and never touch the network. `readTextWithModel`
sends the image to a model provider and asks for the text.

  ```ts
  import { readText, readTextBlocks } from "std::ocr"

  // The text, one line per recognized line:
  const text = readText("invoice.png") with approve

  // Each line with its confidence and position:
  const blocks = readTextBlocks("invoice.png") with approve
  ```

The local functions return a Failure on any platform that is not macOS.
They never fall back to a model provider, because an approval that named
a local read must not become an upload. For offline OCR on Linux or
Windows, install `@agency-lang/tesseract-local`.

## Types

### BoundingBox

Normalized to 0..1 with the origin at the top left of the image, so
`y` grows downward.

```ts
/** Normalized to 0..1 with the origin at the top left of the image, so
`y` grows downward. */
export type BoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ocr.agency#L45))

### TextBlock

One recognized line.

```ts
/** One recognized line. */
export type TextBlock = {
  text: string;
  confidence: number;
  box: BoundingBox
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ocr.agency#L53))

## Effects

### std::ocr

```ts
@alwaysUnder(dir)
effect std::ocr {
  dir: string;
  filename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ocr.agency#L30))

### std::ocrCloud

```ts
effect std::ocrCloud {
  requestedProvider: string;
  configuredModel: string;
  dir: string;
  filename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ocr.agency#L36))

## Functions

### readTextBlocks

```ts
readTextBlocks(
  path: string,
  language: string = "",
  fast: boolean = false,
): Result<TextBlock[]>
```

Recognize the text in an image with macOS Vision and return each line
  with its confidence and normalized top-left bounding box. Runs on the
  machine; nothing is uploaded. Fails on any platform that is not macOS.
  Prefer readText unless you need positions.

  @param path - Path to a PNG, JPEG, GIF, or WebP image
  @param language - Recognition language such as "en-US"; empty lets Vision choose
  @param fast - Use Vision's fast recognition level instead of accurate

**Parameters:**

| Name | Type | Default |
|---|---|---|
| path | `string` |  |
| language | `string` | "" |
| fast | `boolean` | false |

**Returns:** `Result<TextBlock[]>`

**Throws:** `std::ocr`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ocr.agency#L61))

### readText

```ts
readText(
  path: string,
  language: string = "",
  fast: boolean = false,
): Result<string>
```

Recognize the text in an image with macOS Vision and return it as one
  string, one recognized line per line. Runs on the machine; nothing is
  uploaded. Fails on any platform that is not macOS.

  @param path - Path to a PNG, JPEG, GIF, or WebP image
  @param language - Recognition language such as "en-US"; empty lets Vision choose
  @param fast - Use Vision's fast recognition level instead of accurate

**Parameters:**

| Name | Type | Default |
|---|---|---|
| path | `string` |  |
| language | `string` | "" |
| fast | `boolean` | false |

**Returns:** `Result<string>`

**Throws:** `std::ocr`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ocr.agency#L89))

### readTextWithModel

```ts
readTextWithModel(
  path: string,
  model: string = "",
  provider: string = "",
  prompt: string = "",
): Result<string>
```

Send an image to a vision model and return the text it reads. The
  image leaves the machine. A model generates text rather than
  recognizing it, so it can return plausible content that is not on the
  page; prefer readText when the output must be trusted, or check the
  result against the image. Runs in its own thread so the image and the
  instruction do not stay in your conversation.

  @param path - Path to a PNG, JPEG, GIF, or WebP image
  @param model - Model to use; empty means the run's default model
  @param provider - Provider override; normally derived from the model name
  @param prompt - Extra instruction, such as jargon or field names to expect

**Parameters:**

| Name | Type | Default |
|---|---|---|
| path | `string` |  |
| model | `string` | "" |
| provider | `string` | "" |
| prompt | `string` | "" |

**Returns:** `Result<string>`

**Throws:** `std::ocrCloud`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ocr.agency#L113))
