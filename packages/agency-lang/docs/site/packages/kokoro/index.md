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
  source: string
}
```

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/kokoro/index.agency#L30))

### kokoro::speak

```ts
effect kokoro::speak {
  textLength: number;
  voice: string;
  outputFile: string
}
```

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/kokoro/index.agency#L31))

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
): string raises <kokoro::download, kokoro::speak>
```

Speak text into a WAV file. Returns the file path.

  @param text - The text to speak, at most 50,000 characters
  @param outputFile - Where to write the WAV file. Leave empty for a new temp file. An existing file is never overwritten.
  @param voice - A voice id from voices(), such as "af_heart"
  @param model - "fp32" or "q8"
  @param speed - Speaking speed, from 0.5 to 2
  @param allowedPaths - Directories that outputFile must be inside

Text-to-speech that runs on this machine. After the model is downloaded
once, no text is sent over the network. `fp32` is faster. `q8` is a smaller
download: 92 MB instead of 326 MB.

**Parameters:**

| Name | Type | Default |
|---|---|---|
| text | `string` |  |
| outputFile | `string` | "" |
| voice | `string` | "af_heart" |
| model | `string` | "fp32" |
| speed | `number` | 1 |
| allowedPaths | `string[]` | [] |

**Returns:** `string`

**Throws:** `kokoro::download`, `kokoro::speak`

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/kokoro/index.agency#L59))

### voices

```ts
voices(): Voice[]
```

List the Kokoro voices. Each voice has an id, name, language, gender, and a
  quality grade from A (best) to F.

**Returns:** `Voice[]`

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/kokoro/index.agency#L96))
