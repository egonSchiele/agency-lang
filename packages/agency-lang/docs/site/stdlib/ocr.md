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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ocr.agency#L46))

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

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ocr.agency#L54))

## Effects

### std::ocr

```ts
@alwaysUnder(dir)
effect std::ocr {
  dir: string;
  filename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ocr.agency#L31))

### std::ocrCloud

```ts
effect std::ocrCloud {
  requestedProvider: string;
  configuredModel: string;
  dir: string;
  filename: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ocr.agency#L37))

## Functions

### readTextBlocks

```ts
readTextBlocks(
  path: string,
  language: string = "",
  fast: boolean = false,
): Result<TextBlock[]> raises <std::ocr>
```

Read text from an image with confidence scores and bounding boxes.
  Uses macOS Vision locally; requires macOS and does not upload the image.

  @param path - Path to a PNG, JPEG, GIF, or WebP image.
  @param language - Recognition language such as "en-US", or empty for automatic selection.
  @param fast - Use fast recognition instead of accurate recognition.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| path | `string` |  |
| language | `string` | "" |
| fast | `boolean` | false |

**Returns:** `Result<TextBlock[]>`

**Throws:** `std::ocr`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ocr.agency#L63))

### readText

```ts
readText(
  path: string,
  language: string = "",
  fast: boolean = false,
): Result<string>
```

Read text from an image as a string with one recognized line per line.
  Uses macOS Vision locally; requires macOS and does not upload the image.

  @param path - Path to a PNG, JPEG, GIF, or WebP image.
  @param language - Recognition language such as "en-US", or empty for automatic selection.
  @param fast - Use fast recognition instead of accurate recognition.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| path | `string` |  |
| language | `string` | "" |
| fast | `boolean` | false |

**Returns:** `Result<string>`

**Throws:** `std::ocr`

**Needs:** `fileRead`, `fileWrite`, `subprocess`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ocr.agency#L89))

### readTextWithModel

```ts
readTextWithModel(
  path: string,
  model: string = "",
  provider: string = "",
  prompt: string = "",
): Result<string> raises <std::ocrCloud>
```

Send an image to a vision model to transcribe its text. The result may contain
  invented or misread text; use readText for local OCR on macOS.

  @param path - Path to a PNG, JPEG, GIF, or WebP image.
  @param model - Model to use, or empty for the run's default.
  @param provider - Override the provider derived from the model name.
  @param prompt - Additional transcription instructions, such as names or jargon.

Runs in a separate conversation thread, so the image and transcription
instructions do not remain in the caller's conversation. Check the result
against the image when exact transcription matters.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| path | `string` |  |
| model | `string` | "" |
| provider | `string` | "" |
| prompt | `string` | "" |

**Returns:** `Result<string>`

**Throws:** `std::ocrCloud`

**Needs:** `fileRead`, `llm`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/ocr.agency#L118))
