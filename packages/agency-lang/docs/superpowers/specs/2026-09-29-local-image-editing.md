# Editing images on the local image server

An addendum to `2026-09-28-local-models-dx.md` and `2026-09-28-controlnet.md`.
Today `generateImageLocal` makes an image from text only. This spec lets it
take images in, two ways:

- **Reference editing**, the main feature. You give FLUX.2 [klein] a picture
  and an instruction, "add a red top hat to the character", and it draws a new
  image that follows the instruction and copies everything else from the
  picture. This is what the hosted `generateImage(prompt, images: [...])` does
  with OpenAI's or Google's models.
- **Image-to-image**, the second part. The other four families start from your
  picture with some noise added, instead of from pure noise, and a `strength`
  from 0 to 1 says how much of it to redraw. This keeps the exact layout and
  changes the style: "a watercolor painting" at strength 0.6.

They are different operations, so they are different parameters. A caller who
asks for an edit never silently gets image-to-image.

## Why klein, and what the test showed

klein's pipeline, `Flux2KleinPipeline`, already takes an `image` argument (one
image or a list). It does not add noise to the picture. It encodes each picture
separately and puts it next to the new image as extra tokens the model looks at
on every step (`torch.cat([latents, image_latents], dim=1)` in diffusers 0.40),
while the new image starts from pure noise. There is no `strength`. This is the
same approach as FLUX.1 Kontext and Qwen-Image-Edit, and it is why an edit keeps
the character: the model copies from the reference instead of repainting it.

A throwaway test (`/Volumes/adit-agency-models-sept-2026/image-perf/klein_edit.py`,
run 2026-09-29 on the M5 Ultra) drew a cartoon fox, then gave it five edits at
1024x1024, 4 steps:

| Edit | Result | Seconds |
|---|---|---|
| Add a red top hat | Hat added, fox unchanged | 4.7 |
| Redraw as a watercolor | Same pose and scarf, watercolor style | 4.6 |
| Snowy forest background | Background replaced, fox unchanged | 4.6 |
| Wave with the right hand | Waves, but with both hands | 4.6 |
| Round glasses | Glasses added, fox unchanged | 4.6 |

The model loaded in 4 seconds and peaked at 28 GB of GPU memory. Only the pose
edit missed part of the instruction. klein is good enough, so this spec adds
no edit-only model. Qwen-Image-Edit stays an option if a later test finds edits
klein cannot do.

## What this adds

### Part 1: reference editing (klein)

1. A parameter on `generateImageLocal`: `images: string[] = []`, local paths
   to reference images. The name matches the hosted `generateImage`.
2. A request field on `/v1/images/generations`: `images`, a list of
   base64-encoded image bytes.
3. A family key, `max_reference_images`: 4 for klein, 0 for every other family.
   A request with more images than its family takes is refused with a 400 that
   says which families take references.

### Part 2: image-to-image (the other four families)

1. Parameters on `generateImageLocal`: `startImage: string = ""`, a local path,
   and `strength: number | null = null`.
2. Request fields: `start_image` (base64 bytes) and `strength` (a number
   greater than 0 and at most 1).
3. Family keys: `img2img_pipeline`, the diffusers class name, and
   `default_strength`:

   | Family | `img2img_pipeline` | `default_strength` |
   |---|---|---|
   | Z-Image Turbo | `ZImageImg2ImgPipeline` | 0.6 |
   | Chroma1-HD | `ChromaImg2ImgPipeline` | 0.6 |
   | Qwen-Image | `QwenImageImg2ImgPipeline` | 0.6 |
   | SDXL | `StableDiffusionXLImg2ImgPipeline` | 0.6 |
   | FLUX.2 [klein] | none | none |

   0.6 is a first guess. The implementation plan measures it on each family
   and changes the table if a family needs something else.

   All four classes take `strength` and support being built from another
   pipeline's parts (checked in diffusers 0.40).

The two parts can land as separate PRs. Part 2 needs nothing from Part 1
except the shared image plumbing, which Part 1 builds.

## How much work

Most of this already exists, because ControlNet needed the same pieces:

- **Reading an image safely.** The control image is already read in TypeScript
  after `std::readImage` is approved, with `approvedFileBytes`, which refuses
  symlinks and files over 50 MB. It is sent as base64 bytes and decoded with
  `image_bytes_of`, which lets Pillow open only PNG, JPEG, WebP, and GIF. The
  server never opens a path from a request. Reference images and the start
  image use the same path.
- **A second pipeline over the same weights.** `control_pipeline` in
  `diffusersImageServer.py` builds `pipeline_class(**self.pipe.components,
  controlnet=...)` once and caches it. The image-to-image pipeline is built
  the same way with no extra model, so it costs no extra memory and no extra
  load time.
- **Fitting an image to a size.** The `letterbox` helper already scales an
  image to fit and centers it on a background.

What is new: the family keys, the request checks, the `generate` branch that
picks the pipeline and passes `image` or `image` plus `strength`, and the
stdlib parameters. Part 1 is small, and Part 2 is about the same size again.

## The request rules

All in `diffusersImageRules.py`, so CI tests them with plain python3.

- `images` is a list of at most `max_reference_images` entries. Each is
  decoded with `image_bytes_of`, so each is capped at 50 MB.
- `start_image` is one entry, decoded the same way.
- `strength` without `start_image` is refused, and so is `start_image` on a
  family with no `img2img_pipeline`.
- `images` together with `start_image` is refused: no family does both.
- `start_image` together with `controlnet` is refused for now. SDXL has a
  pipeline for both (`StableDiffusionXLControlNetImg2ImgPipeline`), but it is
  a third pipeline to build and test, and nothing asks for it yet.
- A LoRA works with both. It is loaded into the shared weights, so the
  image-to-image pipeline sees it. Only SDXL takes a LoRA today, and klein
  takes none.
- Image-to-image runs `int(steps * strength)` of its steps. A request where
  that is 0 is refused: "strength 0.1 with 9 steps runs no steps; raise
  either."
- The body limit, `MAX_BODY_BYTES`, grows from one image to five: 4
  references or 1 start image, plus the ControlNet image. At 50 MB per image
  that is about 340 MB of base64. That is too much to accept by default, so
  the cap per reference image drops to 20 MB. klein shrinks every reference
  to one megapixel anyway (`_resize_to_target_area` in its pipeline), so a
  larger file buys nothing.

## Size

`size` defaults to `"1024x1024"` today. That default can't tell "the caller
asked for 1024x1024" from "the caller said nothing", and an edit should keep
its picture's shape. So:

- The default becomes `""`, meaning 1024x1024 for plain generation, as before.
- With `images`, `""` means the first reference's size. klein does this itself
  when no size is passed: it scales the reference to at most one megapixel and
  rounds each side down to a multiple of 16.
- With `startImage`, `""` means the start image's size, rounded the same way
  and capped at the family's largest size.
- A size the caller gives always wins. The start image is letterboxed into it,
  as the control image is. klein's references can stay any shape: the model
  only looks at them.

## Approval

Each path in `images`, and `startImage`, raises `std::readImage` with the file's
folder and name, before anything is read. This is the same effect the control
image raises. The file stays on this machine, so it is a local read, not
`std::uploadImage`.

Every path is checked first (real path, regular file, image extension), so a
bad path fails before any prompt, as in `pasteImages` and `generateImage`.

## The stdlib signature

```ts
export def generateImageLocal(
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
): Result<LocalImage> raises <std::readImage>
```

The new parameters go last so existing positional calls keep working. The
docstring is also the tool description an LLM sees, so it says, in plain
words, which to use:

- `images`: "Pictures to edit. The prompt says what to change: 'add a hat to
  the character'. Only FLUX.2 [klein] takes them."
- `startImage`: "A picture to redraw. The layout stays and the style changes.
  Goes with strength. Every model but FLUX.2 [klein] takes one."
- `strength`: "How much of startImage to redraw, from 0 to 1. Low keeps it
  close, high changes more. Null uses the model's default."

## The agent this makes possible

```ts
import { image } from "std::thread"
import { generateImageLocal } from "std::image"

node main(request: string, picture: string) {
  const reply = llm([request, image(picture)], tools: [generateImageLocal])
  print(reply)
}
```

The user's request and picture go to the model. It calls `generateImageLocal`
with the picture's path in `images` and `model: "flux2-klein-4b"`, and the
approval shows which file is read. With a local chat model everything stays
on the machine.

`image(picture)` itself raises no interrupt today, and sends the file to a
hosted model without asking. That is a separate fix, listed in the "Not in
this PR" section of #1154.

## Tests

- Rules (python3, no torch): each refusal above, the family table's keys (every
  row has `max_reference_images`, `img2img_pipeline`, and `default_strength`),
  the size rules, the zero-steps check, and the body limit.
- Server (`diffusersImageServer.test.ts`, with the fake pipeline the existing
  tests use): references reach the pipeline as `image`; image-to-image uses the
  image-to-image pipeline, built once, with `strength`; a plain request after
  an image-to-image one uses the plain pipeline.
- Stdlib (`image.test.ts`): the request carries bytes, never a path; a
  symlinked or oversized file is refused before any request.
- agency-js (`image-generation-local-edit`, like `-controlnet`): one
  `std::readImage` per file with the right folder and name; a rejection sends
  no request; approval sends the bytes; a bad path asks nothing.
- A manual check on the M5 Ultra, recorded in the PR: the klein test again
  through `generateImageLocal`, and one image-to-image run per family at
  strengths 0.3, 0.6, and 0.9, to set `default_strength`.

## Docs

- `docs/site/guide/image-generation.md`: an "Edit an image on your Mac"
  section with a klein example and an image-to-image example, and the agent
  above.
- `docs/dev/llm/local-images.md`: the new family keys, why references and
  image-to-image are separate parameters, and the body limit.
- The `generateImageLocal` docstring, then `make` to regenerate
  `docs/site/stdlib/image.md`.

## Not in this spec

- Inpainting (redraw only a masked area). diffusers has pipelines for it,
  including `Flux2KleinInpaintPipeline`, but someone has to draw the mask.
- Qwen-Image-Edit, unless klein proves not good enough.
- ControlNet together with image-to-image.
- klein's base (not step-distilled) checkpoint.

## Open questions

1. Is 4 the right cap on klein references? Each reference adds about 4,000
   tokens at one megapixel, so time and memory grow with each one. The plan
   measures 1, 2, and 4 references and picks the cap from that.
2. Do 8 steps fix instructions klein half-follows, like the one-hand wave?
   The test script takes `--steps 8`.
