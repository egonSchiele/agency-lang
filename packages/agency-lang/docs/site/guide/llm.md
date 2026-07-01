---
name: LLM Calls
description: How to make LLM calls in Agency, including structured outputs via type annotations, model and provider configuration, streaming, tool use, and memory.
---

# LLM Calls

Agency provides a lot of functionality to make it easier to make LLM calls. Let's look at some of them. To make a basic LLM call, use the LLM built-in function.

```ts
const response = llm("What is the capital of France?")
print(response)
```

To specify a structured output, simply add a type annotation.

```ts
type Response = {
  capital: string
}
const response: Response = llm("What is the capital of France?")
print(response)
```

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

## Other options to llm()

Agency uses the [Smoltalk library](https://github.com/egonSchiele/smoltalk) behind the scenes, and the optional second argument to `llm()` forwards through to it. The typechecker recognizes these options:

| Option | Type |
|---|---|
| `model` | `string` |
| `provider` | `string` |
| `apiKey` | `string` |
| `maxTokens` | `number` |
| `temperature` | `number` |
| `stream` | `boolean` |
| `reasoningEffort` | `"low" \| "medium" \| "high"` |
| `thinking` | `{ enabled: boolean, budgetTokens?: number }` |
| `tools` | `any[]` |
| `metadata` | `any` |

All optional.

For the full list of fields Smoltalk accepts, see the [SmolConfig](https://github.com/egonSchiele/smoltalk#client-options-smolconfig) and [PromptConfig](https://github.com/egonSchiele/smoltalk#request-options-promptconfig) docs.

## Interrupts
Any [interrupts](./interrupts) thrown in tools will just work with no extra work required.

## The `safe` keyword
LLMs are often flaky and it's possible that your LLM will call a tool incorrectly for some reason. If this happens, it's possible to get the LLM to retry the tool call.

Some functions are okay to retry and some aren't. If you have a function that has a side effect, like writing to a database

```ts
def writeToDatabase(data: string) {
  // code to write to database
}
```

and it is called as part of a tool call, you probably don't want the LLM to retry that tool call automatically. However, if you have a function that doesn't have any side effects

```ts
def add(a: number, b: number): number {
  return a + b
}
```

then the LLM can retry the tool call if it fails.

Agency provides functionality to conditionally let LLMs retry tool calls if they fail. Agency keeps track of what code was executed before the tool call failed, and based on that, whether it is okay to retry a tool call or not. This works by using the `safe` keyword. If a function is safe to retry, you can use the `safe` keyword to mark it safe. Let's see a real example.

```ts
def writeToDatabase(data: string) {
  // code to write to database
}

// safe to retry
safe def add(a: number, b: number): number {
  return a + b
}

def myTool() {
  const sum = add(4, 5)
  writeToDatabase(sum)
  print("Done!")
}
```

Suppose `myTool` fails while being called as a tool. If it fails after the call to add, we know it's safe to retry this tool call. 

```ts
def myTool() {
  const sum = add(4, 5)
  // if it fails here, we can retry
  writeToDatabase(sum)
  print("Done!")
}
```

However, if the tool call fails after writing to the database, then we can't retry this tool call.

```ts
def myTool() {
  const sum = add(4, 5)
  writeToDatabase(sum)
  // if it past this point, we can't retry
  // because we don't want to write to the database twice
  print("Done!")
}
```

## Where you can call `llm`

`llm(...)` participates in the same message history as the rest of your agent, so it can only be called from places where a message thread exists. That means anywhere inside a `node` or `def` body, and inside callback bodies that fire while a node is running.

It does **not** work at module top level, inside a `callback(...)` registration block, or inside the `onAgentStart` lifecycle hook — those scopes run before any agent has started and have no conversation to append to. If you call `llm` from one of them you'll get a runtime error like *"Message threads are not available in this scope."* Move the call inside a `node` or `def` body to fix it.

See [Message history and threads](./message-history-and-threads.md) for the full picture.
## Resilience: retries and timeouts

Transient LLM failures — a dropped connection, a `429` rate limit, a `5xx`, or a call that simply hangs — are common and usually self-heal. `llm()` retries them automatically with exponential backoff and an optional per-call deadline, so your happy path stays clean and you don't have to check every call.

```ts
llm("Summarize this", {
  retries: 2,                                  // max retry attempts (default 2; 0 disables)
  timeout: 30s,                                // per-attempt deadline (default 10min; 0 disables)
  backoff: { initial: 500ms, factor: 2, max: 10s },   // exponential, capped (these are the defaults)
})
```

- **What's retried:** connection drops (ECONNRESET, fetch failed, …), `5xx`, `429` (honoring the server's `retry-after`), and `529` overloaded. A `429`'s `retry-after` overrides the computed backoff.
- **What's not:** `400`/auth/content-policy/context-window errors (terminal — no point retrying), and user cancels / guard trips (those propagate immediately and are never swallowed by the retry loop). A guard's time budget keeps ticking through backoff, so a `guard(time:)` still wins.
- **After retries exhaust** (or with `retries: 0`), the call surfaces a normal `Failure` you can handle with `try` / `isFailure` — it does not abort the run.
- **Cancellation:** pressing Esc during a backoff wait cancels the whole loop.

Set defaults for a whole branch with `setLlmOptions({ retries, timeout, backoff })` (per-call options still win). Classification is provider-neutral — it reads HTTP status from the LLM client adapter, so a custom (non-smoltalk) client works too, falling back to message matching.

To be notified of retries/timeouts (for a status line, logging, etc.), use the [`onLLMRetry` and `onLLMTimeout` callbacks](../appendix/callbacks.md).
