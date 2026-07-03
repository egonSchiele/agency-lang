---
name: Attachments
description: Explains how to send images and files to the model in an LLM call, using the `image()` and `file()` builders from `std::thread`.
---

# Attachments

`llm()`'s first argument can also be an **array** that mixes text with image and
file attachments. Bare strings in the array are text; use the `image()` and
`file()` builders from `std::thread` for attachments:

```ts
import { image, file } from "std::thread"

node main() {
  const answer = llm([
    "What's in this image, and how does it relate to the report?",
    image("./diagram.png"),               // local path
    image("https://example.com/a.jpg"),   // remote URL (auto-detected)
    file("./report.pdf"),                 // local PDF / file
  ])
  print(answer)
}
```

`image(source)` and `file(source)` accept a local path, an `http(s)` URL, or a
`data:` URI, and figure out which it is. Smoltalk reads the file, fetches the
URL, infers the MIME type, and enforces size limits when the call is sent — you
don't do any file I/O yourself.

Both builders take optional arguments:

- `mimeType` — set an explicit MIME type (overrides inference).
- `base64: true` — treat `source` as raw base64 data. A `mimeType` is then
  required, e.g. `image(data, mimeType: "image/png", base64: true)`. This is
  handy when you already hold base64 in memory — for example the base64 string
  inside the `Result` that `readBinary()` returns.
- `file(source, filename)` — the filename shown to the model; it defaults to the
  source's basename.

The same array form works with `userMessage()` from `std::thread`, so you can
seed a multimodal user turn into the conversation history:

```ts
import { userMessage, image } from "std::thread"

userMessage(["Here's the screenshot I mentioned", image("./screenshot.png")])
```