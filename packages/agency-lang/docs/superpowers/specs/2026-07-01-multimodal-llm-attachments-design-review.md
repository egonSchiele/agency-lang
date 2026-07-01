---
name: Multimodal LLM Attachments — Design Review
description: Review of docs/superpowers/specs/2026-07-01-multimodal-llm-attachments-design.md
status: review
date: 2026-07-01
reviews: docs/superpowers/specs/2026-07-01-multimodal-llm-attachments-design.md
---

# Multimodal LLM Attachments — Design Review

## Overall

Strong spec. The scope is well-drawn (additive, no breaking changes), the
boundary with smoltalk is clean (Agency constructs plain objects; smoltalk
does I/O), and the risk list at the bottom names the real hazards. A few
claims are inaccurate against the code, and a few concrete gaps deserve to
be pinned before "design → plan".

## Correctness of claims

### Verified

- `lib/runtime/prompt.ts:815` is the sole `smoltalk.userMessage(prompt)` push site. ✅
- Statelog message-carrying sites at `prompt.ts:406` and `prompt.ts:485`. ✅
- `redactAttachments` exists in `smoltalk/dist/util/redact.d.ts` but is
  **not** re-exported from `smoltalk/dist/index.d.ts` (only
  `normalizeImageRef` and `loadBlob` are). ✅
- `llm`'s first param is `"any"` in `lib/typeChecker/builtins.ts:166`. ✅
- `stdlib/thread.agency` has no `image` / `file` today; adding them there
  is the right home. ✅
- smoltalk 0.7.0 exports `UserContentInput = string | Array<string | UserContentPart>`
  and `userMessage(content: UserContentInput, options?)` — the widened
  contract matches. ✅

### Wrong or imprecise

1. **The "streaming completion" line-574 site is mislabeled.** Lines
   565–576 in `prompt.ts` are the `onLLMCallEnd` hook, not a streaming
   event. Real streaming-side logging lives in
   `lib/runtime/streaming.ts` (`handleStreamingResponse`). Grep that
   file for statelog emits carrying `messages` / `prompt` and add each
   to the redaction list. Missing a site re-introduces the base64 blow-up.

2. **The `prompt` string-assumption audit is not thorough enough.** The
   spec calls the audit out as Risk #1 but does not enumerate the sites
   that will break. At minimum:

   - `recallManager.recallForInjection(prompt)` at `prompt.ts:801` —
     param is typed `string`.
   - The template literal at `prompt.ts:803`:
     `\`Relevant context from memory:\n${facts}\`` uses `prompt`
     indirectly via `facts`, but the wider audit must include the
     surrounding branch where `prompt` is used in `${...}` expansion.
     If `prompt` becomes `string | UserContentInput`, any raw `${prompt}`
     emits `[object Object]` when the caller passed an array.
   - `dispatchLLMRequest`'s param at `prompt.ts:60` types `prompt: string`.
   - Any `.length` / `.substring` / `.slice` reads for statelog previews.

   The design should specify **one** text-preview helper (e.g.,
   `promptText(p) = typeof p === 'string' ? p : p.map(x => typeof x === 'string' ? x : x.type === 'text' ? x.text : '').join(' ')`)
   and require every string-only consumer to route through it. This is
   the single most valuable clarification the spec needs.

3. **Codegen "expected no change" — mostly right, but non-obvious.**
   `processLlmCall` compiles `arguments[0]` as an expression, so an
   Agency array literal produces a JS array. But the array literal
   must also **typecheck** against the tightened param, which requires
   three type-checker capabilities in one line:
   1. heterogeneous-array-literal inference,
   2. function-call return types (`image(...) : Attachment`) flowing
      into the array element union,
   3. the union `string | Attachment` accepting either.

   The spec's feasibility test is correct in spirit; make it exercise
   all three explicitly — e.g. bind the literal to a name first:

   ```ts
   let arr = ["hi", image("x"), file("y")]  // arr : (string | Attachment)[]
   llm(arr)
   ```

4. **`Attachment` naming collides with itself and with smoltalk.** The
   spec exports an Agency type `Attachment` whose variants are
   `type: "image" | "file"`, but smoltalk's `UserContentPart` also
   allows `type: "text"`. Two consequences:

   - Agency's `Attachment` is a strict subset of `UserContentPart`.
     The `llm` element union `string | Attachment` is slightly narrower
     than smoltalk accepts. That's probably fine — Agency users express
     text via raw strings — but the design should **say so** rather
     than leave it implicit.
   - Rename or document. Either widen to `AttachmentPart` (includes
     text) or add: "text is expressed as a plain string in the array;
     `Attachment` deliberately omits `text`."

5. **`AttachmentSource` is a subset of smoltalk's.** smoltalk's
   `AttachmentSource` also has `providerFile` and `bytes` kinds.
   Agency's mirror deliberately omits them (correct for v1). Say so
   explicitly: "future smoltalk source kinds are not automatically
   accepted by Agency's `image` / `file` builders."

6. **`std::readImage()` motivation is unverified.** The spec cites
   `readImage()` as motivation for the `base64: true` escape hatch.
   Grep the stdlib and confirm the actual return shape before
   promising this pattern works end-to-end.

## Design gaps to close

1. **`file()` with a URL and no extension.** A URL like
   `https://example.com/download?id=42` yields `download` as the last
   path segment — no extension. Does that break smoltalk MIME inference?
   Two viable rules: (a) delegate everything to smoltalk (it defaults
   to `attachment.pdf`), or (b) require `mimeType` for extensionless
   URL sources. Pick one and write it into the semantics table.

2. **`base64: true` + a data-URI `source`.** The table says
   `data:<mime>;base64,<data>` → `base64` and separately
   `base64: true` → `base64`. What happens for
   `image("data:image/png;base64,...", base64: true)`? Should the
   builder strip the data-URI prefix, reject it, or blindly forward as
   raw base64 (which would produce garbage on the wire)? Add a
   normalization rule.

3. **`base64: true` without `mimeType` — "throws" where?** In Agency,
   "throws" inside a `safe` pure constructor is unusual. Confirm:
   does `throw` in a `safe def` work, or should it return a `Result` /
   call `error(...)`? Match the pattern other `safe` stdlib
   constructors already use.

4. **`redactAttachments` shape at line 485 — verify the swap.** Spec
   says switching from `messages.getMessages()` to
   `messages.toJSON().messages` is behavior-preserving because
   `JSON.stringify` calls `toJSON()`. Check what
   `statelogClient.promptCompletion` **does** with `messages` besides
   serialize — if it inspects `Message` instances (`.role`, class
   methods, `Symbol.for(...)`) the swap breaks it. Confirm before
   writing it in as a done deal. Same check applies wherever the
   redacted plain form flows into `wireAccessors.userMessageOf`.

5. **`agencyLlm.ts` widening.** Widening `prompt: string` at
   `lib/runtime/agencyLlm.ts:68` is called out, but check the whole
   surface: JSDoc, examples, and any Zod / runtime validation of the
   arg. TS callers should get the same type experience Agency callers do.

6. **Streaming preview.** As per correctness #1: audit
   `handleStreamingResponse` for statelog emits carrying `messages` /
   `prompt`. Widening the type is not enough if a streaming path
   formats the prompt as a preview string.

7. **The `.agency` ⇄ `builtins.ts` mirror is fragile.** Instead of
   "add a KEEP IN SYNC comment," look at how `LlmDefaults` ⇄
   `RetryConfig` are actually kept in sync. If it's manual, at least
   add a small unit test that structurally compares the two — a
   comment drifts silently, a test doesn't.

## Testing coverage gaps

- **Memory-injection interaction:** `llm([...], memory: true)` — the
  recall/injection path currently assumes `prompt` is a string. Add a
  test that exercises it with an array prompt. This is the highest-
  value regression test given audit gap #2.
- **Fork/branch statelog under attachments:** the redaction change
  touches shared log paths; ensure `fork` / `race` with attachment-
  carrying `llm(...)` calls don't double-log or dedup incorrectly.
- **`toJSON` swap invariance** at `prompt.ts:485` (see design gap #4).

## Nits

- "smoltalk hardcodes `detail: 'auto'`" — cite the smoltalk file/line
  or drop the parenthetical (it's advisory context, not design).
- "Confirm Agency string methods (`startsWith`) are available" belongs
  in the feasibility checklist, not the middle of the design. If
  unavailable, the design changes (needs a helper). Resolve before
  the doc is called "design".
- Agency's `url` source in the type table lacks `timeoutMs`, but
  smoltalk's `ImageRef` has it. If `timeoutMs` is out of scope for
  v1 (as stated), pin it on the type: "Agency's `url` source
  deliberately omits `timeoutMs`; smoltalk's 60s default applies."
- Consider renaming the `source` parameter on `image` / `file`.
  `source` reads as "sender / origin"; `input` or `from` is clearer
  for a string that might be a path, URL, base64, or data URI.

## Summary verdict

Design is ~80% there. Before "design → plan":

1. Do the concrete `prompt` grep in `prompt.ts` **now** and fold the
   enumerated string-only sites into the spec (Risk #1 → hard
   requirements). The memory-injection path is the smoking gun.
2. Fix the mislabel at `prompt.ts:574` and audit `streaming.ts` for a
   fourth statelog site.
3. Pin the `Attachment` vs. `UserContentPart` naming — either widen
   to include text parts or explicitly document the "strings-for-text"
   convention.
4. Resolve the two `base64: true` normalization ambiguities.
5. Verify `messages.toJSON().messages` is a safe swap for
   `messages.getMessages()` at line 485.

Nothing above is a design killer — all are edits, not rewrites.
