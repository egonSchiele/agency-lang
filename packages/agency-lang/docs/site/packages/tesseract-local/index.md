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

**Parameters:**

| Name | Type | Default | Description |
|---|---|---|---|
| filepath | `string` |  | Path to a PNG or JPEG image |
| language | `string` | "eng" | Tesseract language code; only "eng" ships today |

**Returns:** `string`

([source](https://github.com/egonSchiele/agency-lang/blob/main/packages/tesseract-local/index.agency#L29))
