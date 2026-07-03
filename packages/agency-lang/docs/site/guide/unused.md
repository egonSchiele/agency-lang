## Attachments (images & files)

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

### Limitation: structured output inside block bodies

Any `return llm(...)` inside a block body — anywhere in the block,
not just at the end — falls back to a `string` structured-output
schema. This applies to `fork(...) as item { ... }` branches,
`guard(cost: $X) as { ... }` bodies, and any user-defined function
that takes a block parameter. Agency currently has no way to know
the block's declared return type at codegen time, so the LLM is
asked for a plain string. The block still runs and returns the
LLM's text reply, but you cannot get a typed object out of it.

```ts
type Response = { capital: string }

// ❌ The annotation on `result` is NOT propagated into the block.
// Each branch returns a plain string from the LLM.
const result: Response[] = fork(["France", "Spain"]) as country {
  return llm(`What is the capital of ${country}?`)
}
```

The workaround is to assign the LLM call to a typed local first, then
return it:

```ts
// ✅ The annotation on `reply` controls the LLM's structured output.
const result: Response[] = fork(["France", "Spain"]) as country {
  const reply: Response = llm(`What is the capital of ${country}?`)
  return reply
}
```

Any function defined in Agency can automatically be used as a tool for the LLM. Pass the function in the `tools` option:

```ts
def add(a: number, b: number): number {
  return a + b
}

const result = llm("What is 4 + 5?", { tools: [add] })
print(result)
```

## Streaming

To stream your response back, you will need two things:
1. You will need to set the stream option on the LLM call to true.

```ts
const response = llm("What is the capital of France?", { stream: true })
```

2. You will need to provide an `onStream` callback function to handle the streamed data. Streaming only works when you use your agent through TypeScript or JavaScript, though hopefully this limitation will be resolved soon. When you call a node through TypeScript, provide the callbacks: 

```ts
const callbacks = {
  onStream: console.log
}

const result = await main("some-param", { callbacks })
```

---

how to write a custom llm client

---

## The `safe` keyword
LLMs are often flaky. It's possible that your LLM will call a tool incorrectly for some reason. If this happens, it's possible to get the LLM to retry the tool call.

Some functions are okay to retry and some aren't. If you have a function that has a side effect, like writing to a database, you probably don't want the LLM to retry it automatically. However, if you have a function that doesn't have any side effects, you can make it `safe` to retry:

```ts
safe def add(a: number, b: number): number {
  return a + b
}
```

---

