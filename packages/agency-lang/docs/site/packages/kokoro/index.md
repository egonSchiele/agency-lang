---
name: "index"
---

# index

## Effects

### kokoro::download

```ts
effect kokoro::download {
  model: string;
  sizeBytes: number;
  source: string;
  dir: string
}
```

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/kokoro/index.agency#L35))

### kokoro::speak

```ts
effect kokoro::speak {
  textLength: number;
  voice: string;
  outputFile: string;
  format: string
}
```

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/kokoro/index.agency#L36))

## Functions

### speak

```ts
speak(
  text: string,
  outputFile: string = "",
  voice: string = "af_heart",
  model: string = "fp32",
  speed: number = 1,
  allowedPaths: string[] = [],
  format: string = "",
  modelsDir: string | null = null,
): string raises <kokoro::download, kokoro::speak>
```

Speak text into an audio file. Returns the file path.

  @param text - The text to speak, at most 50,000 characters
  @param outputFile - Where to write the file. Leave empty for a new temp file. An existing file is never overwritten.
  @param voice - A voice id from voices(), such as "af_heart"
  @param model - "fp32" or "q8"
  @param speed - Speaking speed, from 0.5 to 2
  @param allowedPaths - Directories that outputFile must be inside
  @param format - "wav", "mp3", or "m4a". Leave empty to use the output file's extension, or wav when it has none.
  @param modelsDir - Where models are kept. Leave null for the default.

Text-to-speech that runs on this machine. After the model is downloaded
once, no text is sent over the network. `fp32` is faster. `q8` is a smaller
download: 92 MB instead of 326 MB.

The format comes from `format` when given, otherwise from the output file's
extension, otherwise it is wav. An explicit `format` wins even when the
extension says something else. mp3 and m4a are encoded by `ffmpeg` at 96
kbit/s, and `speak` refuses them before raising any interrupt when `ffmpeg`
is missing.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| text | `string` |  |
| outputFile | `string` | "" |
| voice | `string` | "af_heart" |
| model | `string` | "fp32" |
| speed | `number` | 1 |
| allowedPaths | `string[]` | [] |
| format | `string` | "" |
| modelsDir | `string \| null` | null |

**Returns:** `string`

**Throws:** `kokoro::download`, `kokoro::speak`

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/kokoro/index.agency#L70))

### download

```ts
download(
  model: string = "fp32",
  modelsDir: string | null = null,
): string raises <kokoro::download>
```

Download a Kokoro text-to-speech model. Returns the directory it is in. Does nothing when it is already there.

  @param model - "fp32" (326 MB) or "q8" (92 MB)
  @param modelsDir - Where models are kept. Leave null for the default.

Fetches a model before the first `speak` call needs it. Calling this is
optional: `speak` downloads a missing model itself. The directory is chosen
the same way `speak` chooses it.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| model | `string` | "fp32" |
| modelsDir | `string \| null` | null |

**Returns:** `string`

**Throws:** `kokoro::download`

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/kokoro/index.agency#L118))

### voices

```ts
voices(): Voice[]
```

List the Kokoro voices. Each voice has an id, name, language, gender, and a
  quality grade from A (best) to F.

**Returns:** `Voice[]`

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/kokoro/index.agency#L139))
