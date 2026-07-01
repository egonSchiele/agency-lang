---
name: Multimodal LLM Attachments
description: Let Agency's llm() and std::thread.userMessage() accept image and file attachments alongside text, via two smart builder functions, backed by smoltalk 0.7.1's multimodal user-message content.
status: design
date: 2026-07-01
---

# Multimodal LLM Attachments

## Summary

smoltalk 0.7.x (commit `0badbb2`) changed a user message's content from a plain
`string` to `string | Array<string | UserContentPart>`, where a part is a typed
`text` / `image` / `file` object. This lets a user turn carry image and PDF/file
attachments. This spec brings that capability into Agency.

The user-facing change is small and additive:

1. `llm()`'s first argument accepts an **array** of text strings and attachments,
   in addition to a plain string.
2. Two **smart builder** functions — `image(...)` and `file(...)` — construct
   attachments from a path, URL, data URI, or raw base64.
3. `std::thread.userMessage()` is widened the same way, so multimodal user turns
   can be seeded into history.
4. Statelog logging is made attachment-safe: base64 payloads are redacted so a
   logged message never carries a large media blob.

```ts
import { image, file } from "std::thread"

node main() {
  // Unchanged: a plain string still works exactly as today.
  llm("What is the capital of France?")

  // New: an array of text + attachments. Plain strings ARE the text; there is
  // no text() builder — Agency expresses text as a bare string element.
  const answer = llm([
    "What's in this image, and how does it relate to the attached report?",
    image("./diagram.png"),         // local path
    image("https://x.com/a.jpg"),   // auto-detected URL
    file("./report.pdf"),           // local PDF/file
  ])
}
```

## Background: how this works end-to-end today

- **`llm()` is a compiler primitive**, not a stdlib wrapper. Its signature lives in
  `lib/typeChecker/builtins.ts` (`BUILTIN_FUNCTION_TYPES.llm`); its codegen lives in
  `processLlmCall` (`lib/backends/typescriptBuilder.ts:2981`). The first argument is
  extracted as `node.arguments[0]`, compiled as an ordinary expression, and passed
  as `prompt` to the runtime's `runPrompt`.
- **The runtime constructs the user message at one line:** `lib/runtime/prompt.ts:815`
  — `messages.push(smoltalk.userMessage(prompt))`.
- **smoltalk 0.7.x already does all attachment resolution** inside its client:
  reading files from a `path`, fetching a `url`, MIME inference (by extension /
  Content-Type), a 20 MB default size cap, and per-provider remote-URL passthrough.
  Agency performs **no** file I/O — it only constructs the part objects.
- **The builders return plain data objects** matching smoltalk's `UserContentPart`
  / `ImageRef` shapes, so they flow straight into `smoltalk.userMessage(...)` with
  no adapter layer.

## Design

### 1. Builder functions (`stdlib/thread.agency` + `lib/stdlib/thread.ts`)

The builders live in `std::thread`, next to `userMessage` / `assistantMessage` /
`systemMessage`, and are imported explicitly:

```ts
import { image, file } from "std::thread"
```

Each Agency `def` is a thin wrapper over a `_`-prefixed TS helper in
`lib/stdlib/thread.ts` — the same pattern `userMessage`/`systemMessage` already use.
**Why TS-backed rather than pure-Agency object literals:** Agency user code has no
general `throw` (only `raise`, which is interrupt/effect machinery), so the
validation error for `base64: true` with no `mimeType` cannot be raised from Agency.
The TS helper also centralizes the source-string classification (path / URL /
data-URI / raw-base64) where it is easy to unit-test.

Signatures (Agency side):

```ts
export safe def image(
  source: string,
  mimeType: string = "",      // explicit MIME; overrides inference
  base64: boolean = false,    // treat `source` as raw base64 data
): Attachment {
  return _imageAttachment(source, mimeType, base64)
}

export safe def file(
  source: string,
  filename: string = "",      // shown to the model; defaults to the basename
  mimeType: string = "",
  base64: boolean = false,
): Attachment {
  return _fileAttachment(source, filename, mimeType, base64)
}
```

`_imageAttachment` / `_fileAttachment` (TS) return the plain part object and own all
classification and validation.

**Source-string classification** (single string, in the TS helper):

| `source` looks like             | Resolved `kind` | Notes                                                   |
|---------------------------------|-----------------|---------------------------------------------------------|
| `http://…` / `https://…`        | `url`           | smoltalk fetches it                                     |
| `data:<mime>;base64,<data>`     | `base64`        | MIME parsed from the data URI (overrides `mimeType`)    |
| anything else                   | `path`          | local file; smoltalk reads it                           |
| (path/URL string) + `base64: true` | `base64`     | raw base64 — **requires `mimeType`** (else throws)      |

**Normalization rules (resolve the review's ambiguities):**

- **`base64: true` + a `data:` source.** The helper detects the `data:` prefix first
  and treats the value as a data URI regardless of the `base64` flag: it strips the
  `data:<mime>;base64,` prefix, uses the URI's MIME (unless `mimeType` overrides), and
  uses the trailing base64. This prevents the "raw-forward a full data URI as base64"
  garbage-on-the-wire case.
- **`base64: true` without `mimeType`.** The TS helper throws a clear `Error`
  ("image()/file(): base64 sources require an explicit mimeType"). Because `image`/
  `file` are pure constructors that return `Attachment` (not `Result`), a thrown
  Error — surfaced as a normal Agency runtime error — is the right signal for a
  programming mistake; returning a `Result` would force every inline
  `llm([image(...)])` to unwrap.
- **Extensionless URL / path for `file()`.** The helper does **not** try to infer a
  filename or MIME for these; it delegates entirely to smoltalk, which defaults the
  filename to `attachment.pdf` and infers MIME from the Content-Type. If the caller
  needs control, they pass `filename` and/or `mimeType`. (Chosen rule: delegate to
  smoltalk, do not require `mimeType` for extensionless sources.)
- **`filename` derivation.** When `filename` is empty, the helper derives it from the
  last path segment of the path/URL; if that is empty it leaves `filename` unset and
  lets smoltalk default it.

**`mimeType`** is emitted onto the `source` object only when non-empty, so smoltalk's
inference still runs by default for path/URL sources.

**Deliberate subset of smoltalk (v1 scope — state explicitly):**

- Agency's `image`/`file` cover only smoltalk source kinds `path` / `url` / `base64`.
  smoltalk also has `bytes` and `providerFile` kinds; Agency omits them (no
  first-class bytes type; provider-file uploads deserve their own builder later).
  Future smoltalk source kinds are **not** automatically reachable through these
  builders.
- Agency's `url` source deliberately omits smoltalk's `timeoutMs`; smoltalk's 60s
  fetch default applies. Non-breaking to add later.
- No `detail` / resolution hint. smoltalk currently emits a fixed `detail: "auto"`
  for images (in `UserMessage.toOpenAIResponseInputItem`) and does not carry `detail`
  on the part, so exposing it needs a smoltalk change first.

### 2. Type model (`stdlib/thread.agency` + `lib/typeChecker/builtins.ts`)

New Agency types, co-located with the builders:

```ts
export type AttachmentSource =
  | { kind: "path", path: string, mimeType?: string }
  | { kind: "url", url: string, mimeType?: string }
  | { kind: "base64", base64: string, mimeType: string }

export type Attachment =
  | { type: "image", source: AttachmentSource }
  | { type: "file", source: AttachmentSource, filename?: string }
```

`Attachment` is a **strict subset** of smoltalk's `UserContentPart`: smoltalk also
allows `{ type: "text", text }`, but Agency expresses text as a bare string element
in the array, so `Attachment` intentionally omits the text variant. The `llm`
element union `string | Attachment` is therefore slightly narrower than what smoltalk
would accept — which is correct, and is called out here so it is not a surprise.

**`llm()` first-param tightening** (`builtins.ts`): today it is `"any"`. Tighten to:

```
string | (string | Attachment)[]
```

expressed structurally with the existing type primitives (`unionType`, `arrayType`,
`objectType`, `stringLiteralType`, `optional()`). The `llm()` **return** type is
unchanged (`string`, overridden by the call-site annotation → Zod structured-output
schema).

**Mirror is guarded by a test, not just a comment.** `Attachment` is declared in two
universes — the `.agency` type (for builder return types + docs) and the TS
structural mirror in `builtins.ts` (for the `llm` signature). Following the existing
`LlmDefaults`⇄`RetryConfig` precedent (which is comment-only and has *no* test), we
improve on it: add a typechecker test that compiles representative programs and
asserts accept/reject, so drift between the two definitions fails CI rather than
rotting silently:

```ts
llm("s")                          // ok
llm(["s", image("x")])            // ok
llm([42])                         // rejected
userMessage(["s", image("x")])    // ok
userMessage([42])                 // rejected
```

**Feasibility check to run FIRST (before any impl)** — the tightened param requires
three checker capabilities in one expression; exercise all three explicitly by
binding the literal to a name first (so inference, not just call-arg checking, is
tested):

```ts
let arr = ["hi", image("x"), file("y")]   // must infer (string | Attachment)[]
llm(arr)                                   // must accept
```

1. heterogeneous-array-literal element-union inference,
2. function-call return types (`image(...) : Attachment`) flowing into the element
   union,
3. the union `string | Attachment` accepting either arm.

Prove it with `pnpm run ast` / typecheck before committing to the strict signature.
Tightening never *breaks* valid code — the element type stays assignable in every
case — so the worst outcome of weak inference is that it catches *less*, in which
case fall back to a looser param.

### 3. Runtime & codegen

- **Codegen — expected no change.** `processLlmCall` compiles `arguments[0]` as an
  expression; an Agency array literal produces a JS array of the builders' object
  literals. Add a codegen test to lock this in.
- **Runtime user-message construction — no change at the push site.**
  `prompt.ts:815` already calls `smoltalk.userMessage(prompt)`, and smoltalk accepts
  `string | array`.
- **`std::thread.userMessage()` widening.** Widen `userMessage(msg: string)` to
  `string | (string | Attachment)[]` and forward to `smoltalk.userMessage` via
  `_userMessage` (`lib/stdlib/thread.ts`), whose param widens to smoltalk's
  `UserContentInput`.
- **TS facade parity.** `lib/runtime/agencyLlm.ts` (lines ~68–73) types the prompt
  param as `string`. Widen it to the same `string | (string | Attachment)[]` union,
  **and** update its JSDoc, the doc examples, and any Zod/runtime validation of the
  arg, so TS callers get the same type experience as Agency callers.

#### 3a. The `prompt` string-assumption audit (Risk #1 — now a hard requirement)

Between `runPrompt`'s entry and line 815, `prompt` is threaded through several
functions typed `prompt: string`. Once it can be an array, two classes of site break:
type declarations, and string-only *consumers*.

**One shared text-flattening helper.** Add `promptText(p)` to `lib/runtime/prompt.ts`
(or a small util) and route every consumer that needs a plain string through it:

```ts
function promptText(p: string | UserContentInput): string {
  if (typeof p === "string") return p;
  return p
    .map((x) => (typeof x === "string" ? x : x.type === "text" ? x.text : ""))
    .join(" ");
}
```

Enumerated sites (from a grep of `prompt.ts` + `streaming.ts`):

- **Type declarations to widen** `string → string | UserContentInput`:
  `prompt.ts:60` (`dispatchLLMRequest`), `:301` (`dispatchWithRetry`), `:369`
  (`_runPrompt`), `:583` (`runPrompt` inner), and `streaming.ts:17`
  (`handleStreamingResponse`).
- **String consumer that MUST flatten:** `recallManager.recallForInjection(prompt)`
  at `prompt.ts:801` → `recallForInjection(promptText(prompt))`. This is the memory
  path and the single highest-risk site — an array prompt would otherwise recall
  against `[object Object]`.
- **Any `.length` / `.substring` / `.slice` preview reads** of `prompt` → route
  through `promptText(prompt)`. (Current grep shows none other than the memory path,
  but the rule stands so future previews are safe.)
- Note the distinction from logging: statelog keeps the *structured* prompt (redacted;
  see §4), it does NOT flatten to text — `promptText` is only for consumers that
  genuinely need a `string`.

### 4. Statelog redaction

Statelog serializes the whole event with `JSON.stringify` at POST time
(`statelogClient.ts:1059`), invoking each `Message.toJSON()`; a base64 attachment
payload would be encoded into the wire body — the blow-up. Make every statelog site
that carries messages or the prompt attachment-safe using smoltalk's
`redactAttachments` (now re-exported from smoltalk's top-level index in 0.7.1):

```
messages: redactAttachments(messages.toJSON().messages)
prompt:   redactAttachments(prompt)
```

**All four sites (verified against the code):**

1. `lib/runtime/prompt.ts:406` — `onLLMCallStart` hook data (`messages` + `prompt`).
2. `lib/runtime/prompt.ts:485` — `promptCompletion` (`messages`). Switch from
   `messages.getMessages()` to `messages.toJSON().messages`. **Verified safe:**
   `statelogClient.promptCompletion` only stores `messages` and serializes later; it
   never inspects `Message` instance methods, and `wireAccessors.userMessageOf` reads
   `.role`/`.content` off the plain JSON form (identical shape either way, since
   `JSON.stringify` already calls `toJSON()`).
3. `lib/runtime/prompt.ts:574` — this is the **`onLLMCallEnd` hook** (the spec's
   earlier "streaming completion" label was wrong), carrying `messages`.
4. `lib/runtime/streaming.ts:~28` — `ctx.statelogClient.debug("…", { prompt })` in
   the no-`onStream` branch. Redact `prompt` here. (This is the fourth site the
   original spec missed.)

`redactAttachments` deep-copies and replaces only base64 / data-URI blobs with
`[redacted N base64 chars]`, keeping structure (`kind`, `mimeType`, `filename`, path,
URL). Observability still shows *what* was attached, just not the bytes.

## Non-goals

- `assistantMessage` / `systemMessage` stay string-only. Providers do not accept
  image/file parts on those roles, and smoltalk types them `string | TextPart[]`.
- No new attachment source kinds beyond path / url / base64 (no `bytes`,
  `providerFile`).
- No `timeoutMs`, no `detail` (blocked on smoltalk).
- No `text()` builder — text is a bare string element in the array.

## Testing

- **Builder units** (TS `_imageAttachment` / `_fileAttachment`): path vs. url vs.
  data-URI vs. `base64: true`; `data:` + `base64:true` normalization; `mimeType`
  override; filename derivation from basename; extensionless URL delegated to
  smoltalk; `base64: true` without `mimeType` throws.
- **Typechecker** (accept/reject, doubling as the mirror-drift guard): the five
  `llm(...)` / `userMessage(...)` cases in §2, plus the `let arr = [...]` inference
  check.
- **Codegen:** `llm([...])` emits an array argument to `runPrompt`.
- **Agency-js execution test (no real LLM call):** compile a program calling
  `llm([...])` / `userMessage([...])`; assert the constructed smoltalk user message
  has the expected parts (via statelog, per the deterministic-mock testing pattern);
  assert statelog output is redacted (no base64 blob in any logged event).
- **Memory-injection interaction (highest-value regression):** `llm([...], memory:
  true)` — exercises the `recallForInjection(promptText(...))` path with an array
  prompt; guards audit §3a.
- **Fork/branch statelog under attachments:** `fork` / `race` with attachment-carrying
  `llm(...)` — ensure the redaction change on shared log paths doesn't double-log or
  dedup incorrectly.
- **`toJSON` swap invariance** at `prompt.ts:485` — assert the wire shape is unchanged
  by the `getMessages()` → `toJSON().messages` swap.
- **Docs:** `docs/site/guide/llm.md` (a multimodal section) and stdlib doc comments on
  `image` / `file` / the widened `userMessage` (these become tool descriptions).

## Dependencies & prerequisites

1. smoltalk `0.7.1` installed. ✅ Done.
2. smoltalk re-exports `redactAttachments` from its top-level index. ✅ Done (0.7.1).
3. `make` after editing any `.agency` stdlib file (per project convention).

## Open implementation risks (ranked)

1. **`prompt` string-assumption audit** (§3a) — now enumerated; the memory-injection
   path is the smoking gun. Route all string consumers through `promptText`.
2. **Heterogeneous array-literal inference** against the tightened `llm` param —
   validate empirically with the `let arr = [...]` check before committing to the
   strict signature.
3. **Redaction completeness** — all four sites (§4) plus the `prompt` field must be
   covered; a missed site re-introduces the blow-up.
