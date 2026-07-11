---
name: "image"
---

# image

Generate images from a text prompt (or edit input images) using a
hosted provider (OpenAI, Google, or an open-source model via LiteLLM / Together).
Returns base64 you can persist with `writeBinary()` or send onward with
`std::thread`'s `image(...)`.

  ```ts
  import { generateImage } from "std::image"

  node main() {
    const r = generateImage("a red bicycle in the rain", size: "1024x1024")
    if (isFailure(r)) { print("failed: ${r.error}"); return }
    writeBinary("bike.png", r.value.base64)
  }
  ```

## Functions

### generateImage

```ts
generateImage(
  prompt: string,
  model: string = "",
  provider: string = "",
  size: string = "",
  quality: string = "",
  images: string[] = [],
  apiKey: string = "",
  baseUrl: string = "",
): Result
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
| quality | `string` | "" |
| images | `string[]` | [] |
| apiKey | `string` | "" |
| baseUrl | `string` | "" |

**Returns:** `Result`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/image.agency#L19))
