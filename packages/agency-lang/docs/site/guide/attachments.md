---
name: Attachments
description: Explains how to send images and files to the model in an LLM call, using the `image()` and `file()` builders from `std::thread`.
---

# Attachments

So far, in all the LLM calls we have made, the first argument has been a string:

```ts
const answer = llm("What is the capital of India?")
```

But `llm()`'s first argument can also be an **array**. Arrays let you mix text with image and
file attachments. To include images and files, use `image()` and `file()` from `std::thread`:

```ts
import { image, file } from "std::thread"

node main() {
  const answer = llm([
    "What's in this image, and how does it relate to the report?",
    image("./diagram.png"),
    file("./report.pdf"),
  ])
  print(answer)
}
```

`image(source)` and `file(source)` accept a local path, an `http(s)` URL, or a
`data:` URI:

```ts
image("./diagram.png")                         // local path
image("https://example.com/a.jpg")             // http(s) URL
image("data:image/png;base64,iVBORw0KGgo...")  // data: URI
```

You can also pass in base64 data directly, but you must set `base64: true` and provide a MIME type:

```ts
image(data, mimeType: "image/png", base64: true)
file(data, mimeType: "application/pdf", base64: true)
```

The `file` function also takes an optional `filename` argument, which is the filename shown to the model. It defaults to the source's basename.



You can also use the array form with functions like `userMessage()` from `std::thread`:

```ts
import { userMessage, image } from "std::thread"

userMessage(["Here's the screenshot I mentioned", image("./screenshot.png")])
```