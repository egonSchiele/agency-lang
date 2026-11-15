---
name: "images"
description: "The image tools of the Agency agent's coordinator brain: make or"
---

# images

edit an image and save it to a file, and look at an image file.

## Functions

### resolveEditInputs

```ts
resolveEditInputs(images: string[]): string[]
```

**Parameters:**

| Name | Type | Default |
|---|---|---|
| images | `string[]` |  |

**Returns:** `string[]`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/coordinator/images.agency#L11))

### generateImageFile

```ts
generateImageFile(
  prompt: string,
  path: string,
  size: string = "",
  images: string[] = [],
): string
```

Generate an image from a text prompt and save it to `path`. To MODIFY
  existing images (edit / variation), pass their paths in `images`.
  Returns the saved path on success. Use this when the user asks to
  create, draw, edit, or restyle an image.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| prompt | `string` |  | What to generate, or how to modify the input images. |
| path | `string` |  | Where to save the resulting image (e.g. "diagram.png"). |
| size | `string` | "" | Optional size like "1024x1024". |
| images | `string[]` | [] | Optional input image paths to edit / vary. |

**Returns:** `string`

**Throws:** `std::uploadImage`, `std::writeBinary`

**Needs:** `fileRead`, `llm`, `fileWrite`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/coordinator/images.agency#L25))

### viewImageFile

```ts
viewImageFile(path: string): string
```

Look at an image or PDF file. The file appears in the next message so
  you can read a diagram, a screenshot, or a scanned page. Use this
  before describing or editing an image.

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| path | `string` |  | Path to the image or PDF, relative to the working directory |

**Returns:** `string`

**Throws:** `std::viewFile`

**Needs:** `fileRead`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/agents/brains/coordinator/images.agency#L71))
