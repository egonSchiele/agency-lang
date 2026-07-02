---
name: Image Generation
description: Generate images from a prompt with generateImage(), persist them with writeBinary(), and feed them back into multimodal llm() calls.
---

# Image Generation

Agency can generate images from a text prompt using a hosted provider. Import
`generateImage` from `std::image`:

```ts
import { generateImage } from "std::image"

node main() {
  const r = generateImage("a red bicycle in the rain", size: "1024x1024")
  if (isFailure(r)) {
    print("generation failed: ${r.error}")
    return
  }
  const img = r.value          // { base64: string, mimeType: string }
  writeBinary("bike.png", img.base64)
  print("saved bike.png")
}
```

`generateImage` returns a `Result`. On success, its value is a `{ base64,
mimeType }` object — the image is returned in memory as base64, not written to
disk automatically.

## Saving the image

`writeBinary(path, base64)` decodes base64 and writes the raw bytes — use it for
any binary data (images, audio, video, PDFs). It's auto-imported, so no import is
needed. (Plain `write()` writes UTF-8 text and would corrupt binary data.)

```ts
writeBinary("bike.png", r.value.base64)
```

Read a binary file back with `readBinary(path)`, which returns the contents as
base64.

## Sending a generated image to a model

Because `generateImage` returns base64, it composes directly with the multimodal
attachment builder from `std::thread` — generate an image, then describe or edit
it without a disk round-trip:

```ts
import { generateImage } from "std::image"
import { image } from "std::thread"

node main() {
  const r = generateImage("a red bicycle")
  if (isFailure(r)) { return }
  const answer = llm([
    "What color is the bicycle in this image?",
    image(r.value.base64, r.value.mimeType, base64: true),
  ])
  print(answer)
}
```

## Editing / variations

Pass input images to edit or make variations. Each entry is a path, an `http(s)`
URL, or a `data:` URI — the same source forms the attachment builder accepts:

```ts
const edited = generateImage("make it nighttime", images: ["bike.png"])
```

## Choosing a provider and model

By default `generateImage` uses OpenAI's image model. Override the model or
provider per call. Open-source models (FLUX, SDXL, Stable Diffusion, Qwen-Image,
…) are reachable through a proxy — LiteLLM, or Together AI via the OpenAI-compatible
endpoint:

```ts
// OpenAI (default)
generateImage("a red bike")

// An open-source model via LiteLLM
generateImage("a red bike", provider: "litellm", model: "flux-pro",
              baseUrl: "https://your-litellm-host")

// Together AI (OpenAI-compatible images endpoint)
generateImage("a red bike", provider: "openai-compat",
              model: "black-forest-labs/FLUX.1-schnell",
              baseUrl: "https://api.together.ai/v1")
```

Options: `model`, `provider`, `size`, `quality` (`"low"`/`"medium"`/`"high"`/
`"auto"`), `images`, `apiKey`, `baseUrl`.

## Cost and guards

Image generation costs real money, so it participates in Agency's cost tracking:
its cost accrues to `getCost()` and is billed against any enclosing
`guard(cost:)`, which will abort runaway generation.

```ts
import { guard } from "std::thread"

const result = guard(cost: $1.00) as {
  return generateImage("a detailed landscape")
}
```

## Limitations (v1)

- Hosted providers only — local image generation (Stable Diffusion / FLUX on your
  own GPU) is not yet supported; it needs a different runtime than local text models.
- One image per call.
- No mask-based inpainting yet.
