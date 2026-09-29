---
name: "vision"
description: "Find objects, tags, or a caption in an image with a vision model on this machine."
---

# vision

Ask a local vision model about an image: which objects are where, which
booru tags describe it, or a caption. The model must be running: start
it with `agency local serve <model>`. The image never leaves the machine.

  ```ts
  import { detectObjects, tagImage } from "std::vision"
  import { cropImage } from "std::image"

  node main() {
    handle {
      const found = detectObjects("page.png", ["person", "desk", "chair"], "florence-2") catch []
      for (hit in found) {
        cropImage("page.png", hit.box, "crops/${hit.label}_${hit.id}.png", pad: 0.05)
      }
      const tags = tagImage("crops/person_0.png", "wd14-tagger") catch []
      const names = map(tags) as t {
        return t.tag
      }
      print(names.join(", "))
    } with approve
  }
  ```

Each function is one job with a `Result`, so a labeling loop is a few
lines of your own code over them, and partial application narrows each:
`detectObjects.partial(labels: ["person"], model: "florence-2")` is a
person-finder.

## Types

### BoundingBox

Normalized to 0..1 with the origin at the top left of the image, so
`y` grows downward. The same shape std::ocr returns, so a box from
either can go to cropImage.

```ts
/** Normalized to 0..1 with the origin at the top left of the image, so
`y` grows downward. The same shape std::ocr returns, so a box from
either can go to cropImage. */
export type BoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/vision.agency#L44))

### Detection

One thing a detector found. `id` is its index in the reply, so crops
can be named after it. The box is normalized 0..1 from the top left.

```ts
/** One thing a detector found. `id` is its index in the reply, so crops
can be named after it. The box is normalized 0..1 from the top left. */
export type Detection = {
  id: number;
  label: string;
  score: number;
  box: BoundingBox
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/vision.agency#L53))

### Tag

One tag a tagger gave, with how sure it was, 0..1.

```ts
/** One tag a tagger gave, with how sure it was, 0..1. */
export type Tag = {
  tag: string;
  score: number
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/vision.agency#L61))

## Effects

### std::vision

```ts
@alwaysUnder(dir)
effect std::vision {
  dir: string;
  filename: string;
  task: string;
  model: string
}
```

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/vision.agency#L39))

## Functions

### detectObjects

```ts
detectObjects(
  path: string,
  labels: string[],
  model: string,
  threshold: number = 0.3,
): Result<Detection[]> raises <std::vision>
```

Find the named things in an image with a local detector and return
  each one's label, score, and bounding box. The box is normalized to
  0..1 with the origin at the top left, the shape cropImage takes. Runs
  on this machine; nothing is uploaded.

  @param path - Path to a PNG, JPEG, WebP, or GIF image
  @param labels - What to look for, in words: ["person", "desk", "chair"]. A detector with no labels finds whatever it likes, so at least one is required. Florence-2 looks for each label in its own pass, so each label adds to the time
  @param model - A local vision model that detects, such as "florence-2"
  @param threshold - Drop detections scoring below this, 0 to 1. Florence-2 gives no scores: every box it finds scores 1, so the threshold drops nothing

**Parameters:**

| Name | Type | Default |
|---|---|---|
| path | `string` |  |
| labels | `string[]` |  |
| model | `string` |  |
| threshold | `number` | 0.3 |

**Returns:** `Result<Detection[]>`

**Throws:** `std::vision`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/vision.agency#L66))

### tagImage

```ts
tagImage(
  path: string,
  model: string,
  threshold: number = 0.35,
  limit: number = 30,
): Result<Tag[]> raises <std::vision>
```

Describe an image as booru tags with a local tagger: "1girl, glasses,
  reading, book". Each tag comes with its score, best first. This is the
  vocabulary illustration models such as NoobAI-XL take in a prompt, so
  the tags can go straight into a caption file. Runs on this machine;
  nothing is uploaded.

  @param path - Path to a PNG, JPEG, WebP, or GIF image
  @param model - A local vision model that tags, such as "wd14-tagger" or "florence-2"
  @param threshold - Drop tags scoring below this, 0 to 1
  @param limit - At most this many tags, 1 to 500

**Parameters:**

| Name | Type | Default |
|---|---|---|
| path | `string` |  |
| model | `string` |  |
| threshold | `number` | 0.35 |
| limit | `number` | 30 |

**Returns:** `Result<Tag[]>`

**Throws:** `std::vision`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/vision.agency#L96))

### captionImage

```ts
captionImage(
  path: string,
  model: string,
  detail: string = "short",
): Result<string> raises <std::vision>
```

Write a sentence about an image with a local model. Runs on this
  machine; nothing is uploaded.

  @param path - Path to a PNG, JPEG, WebP, or GIF image
  @param model - A local vision model that captions, such as "florence-2"
  @param detail - "short" for one sentence, "long" for a paragraph

**Parameters:**

| Name | Type | Default |
|---|---|---|
| path | `string` |  |
| model | `string` |  |
| detail | `string` | "short" |

**Returns:** `Result<string>`

**Throws:** `std::vision`

([source](https://github.com/egonSchiele/agency-lang/tree/main/packages/agency-lang/stdlib/vision.agency#L127))
