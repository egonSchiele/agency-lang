---
name: "index"
---

# index

## Functions

### readText

```ts
readText(filepath: string, language: string = "eng"): string
```

Recognize the text in an image locally with Tesseract. Nothing is
  uploaded. Slower and less accurate than macOS Vision, but runs on any
  platform.

  @param filepath - Path to a PNG or JPEG image
  @param language - Tesseract language code; only "eng" ships today

**Parameters:**

| Name | Type | Default |
|---|---|---|
| filepath | `string` |  |
| language | `string` | "eng" |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/tesseract-local/index.agency#L29))
