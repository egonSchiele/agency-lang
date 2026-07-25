# Review: `toolMessage` attachments implementation plan

Reviewing `2026-07-22-toolmessage-attachments.md`. The plan addresses every
finding from the spec review — `label` on all three messages, the flattening
documented in the docstring, the second-consumer note in `replyAttachments.ts`,
and the three tests I asked for. The structure is right.

One correctness bug, plus three smaller gaps.

## Blocking: the declared type is wider than the implementation handles

Task 1 Step 4 types the parameter as `result: smoltalk.UserContentInput`. That
type is:

```ts
export type UserContentPart = TextPart | ImagePart | FilePart;
export type UserContentInput = string | Array<string | UserContentPart>;
```

So an array element may legally be a **`TextPart`** — `{ type: "text", text: string }`,
which has **no `source` field** (`smoltalk/dist/classes/message/contentParts.d.ts:3-20`).

The implementation treats every non-string element as an attachment, with an
unchecked cast:

```ts
for (const part of result) {
  if (typeof part === "string") {
    textParts.push(part);
  } else {
    attachments.push(part as ReplyAttachmentPart);   // ← a TextPart lands here
  }
}
```

A `TextPart` therefore flows into `buildReplyUserMessage`, which immediately does
`entry.part.source.kind` (`replyAttachments.ts:169`) and throws
`TypeError: Cannot read properties of undefined (reading 'kind')` — a confusing
crash far from the call site, which is exactly the failure mode the `#641` args
guards were added to prevent.

The contrast matters: `_userMessage` declares the *same* type and honors all of
it, because it hands `msg` straight to `smoltalk.userMessage(msg)`, which handles
text parts (smoltalk's own doc comment: "a bare string element is sugar for a
text part"). `_toolMessage` would become the one function in the file that
advertises `UserContentInput` and cannot actually accept it.

**Reachability:** the Agency wrapper types `result` as
`string | (string | Attachment)[]`, and stdlib `Attachment` is image/file only —
so Agency callers are protected by the typechecker. But `_toolMessage` is
exported and called directly from TypeScript (the agency-js tests and any TS
caller), where the signature openly invites a `TextPart`.

**Fix — pick one:**

- *Handle text parts* (truest to the "same type as `userMessage`" claim, 2 lines):
  ```ts
  } else if (part.type === "text") {
    textParts.push(part.text);
  } else {
    attachments.push(part);
  }
  ```
- *Or narrow the declared type* to what the code actually supports, e.g.
  `string | Array<string | ReplyAttachmentPart>`, so the signature stops
  promising `TextPart` support.

I'd do the first, plus a guard so anything lacking a `source` raises a clear
`toolMessage: ...` error rather than a `TypeError` from inside the loop's
helper. Either way, add a test for the text-part element.

## Empty array produces an empty tool result, bypassing the placeholder

The placeholder is conditional on there being attachments:

```ts
toolContent = attachments.length > 0 && text === "" ? "[see attached]" : text;
```

So `toolMessage("t", {}, [])` yields `text === ""`, no attachments, and a
tool-result message with empty content — the one case that still violates the
spec's "a tool-result message needs non-empty content" premise. (I flagged in the
spec review that this premise was asserted rather than verified; this is where it
bites.) Decide deliberately: either treat an empty array like an empty string and
accept empty content, or apply a placeholder uniformly. Add a test either way —
nothing currently covers `[]`.

## Test gaps

- **No file-attachment case.** All seven new tests use `_imageAttachment`.
  `buildReplyUserMessage` has a distinct `file` branch — the `kindWord`, the
  `filename` passthrough, and the `application/pdf` mime default — none of it
  exercised. Add one `_fileAttachment` case.
- **The `att_N` label text isn't pinned.** The spec made a point of `att_N` being
  deliberately *not* the loop's `img_N`, but no assertion checks the label reads
  `[att_1 — image output of tool saveDraft]`. Change the prefix or the wording
  and every test still passes. Assert it once.
- **Low-risk, confirm at Step 2:** the new tests assert on
  `smoltalk.userMessage(parts).toJSON().content`. The existing reply-attachment
  tests assert on `buildReplyUserMessage`'s return value *directly*, never
  through `smoltalk.userMessage()` + `toJSON()`. I expect it round-trips
  unchanged (an array input normalizes to `UserContentPart[]`, and the built
  parts are already valid `ImagePart`s), but it's an unverified hop — worth
  confirming when the tests first run rather than assuming.

## Verified correct

- **Test helpers produce the intended sources.** `_imageAttachment("AAAB", "image/png", true)`
  → `{ kind: "base64", base64: "AAAB", mimeType: "image/png" }`;
  `_imageAttachment(file, "", false)` → `{ kind: "path", path: file }`. Both match
  `classifySource`'s branches, so the inlining test really does exercise the path
  branch.
- **The import rewrite is valid.** `buildReplyUserMessage` is a value and
  `HarvestedReplyAttachment` is an exported type, so the combined
  `import { buildReplyUserMessage, type ReplyAttachmentPart, type HarvestedReplyAttachment }`
  is correct.
- **`HarvestedReplyAttachment` shape** `{ id, toolName, part }` matches, and the
  follow-up push mirrors the loop's own call at `prompt.ts:1848` — with the
  correct addition of `label || null`, which the loop's push does not pass.
- **The string path is genuinely untouched**, so the existing eight tests and the
  Agency round-trip stay green; Task 2 Step 4 re-runs the round-trip as a
  regression check.
- **The spec's non-goals are implemented literally**: `att_${i+1}` ids, no marker
  appended to the tool text, no `gateReplyAttachment` call.

## Anti-pattern audit (`docs/dev/anti-patterns.md`)

Unlike the first `toolMessage` plan, this one **does** hit several entries — and
the main one is the same defect as the blocking bug above.

### Imperative code everywhere (present)

The split is a hand-rolled accumulator loop:

```ts
const attachments: ReplyAttachmentPart[] = [];
...
const textParts: string[] = [];
for (const part of result) {
  if (typeof part === "string") {
    textParts.push(part);
  } else {
    attachments.push(part as ReplyAttachmentPart);
  }
}
```

Compare the catalog's own *Bad* example — declare empty array, `for`, `if`,
`push` — it is structurally the same shape. This is a partition, and the "Good"
form in the doc is `.filter()`. The code says *how* to sort the parts rather than
*what* the two groups are.

**This is also where the bug lives.** The imperative `else` is an unchecked
catch-all: anything not a string is assumed to be an attachment, so `TextPart`
silently lands in the wrong bucket and crashes later. A declarative partition
with a *named type predicate* makes the third case impossible to overlook — the
anti-pattern and the defect are one and the same.

### Order-dependent mutable state (present)

`let toolContent` is declared undefined and assigned in two branches, and
`const attachments = []` is declared empty, mutated inside the loop, then read
three times afterwards — including by the line that computes `toolContent`:

```ts
toolContent = attachments.length > 0 && text === "" ? "[see attached]" : text;
```

You cannot read that line in isolation; you have to know the loop above already
ran and filled `attachments`. That is exactly the catalog's complaint ("derive
each value from its inputs, not from other mutable variables").

### Useless special case (arguable)

The `typeof result === "string"` fast path is behaviourally identical to the
one-element-array path: normalize `"x"` to `["x"]` and you get `text === "x"`,
no attachments, no follow-up — the same two messages. Per the catalog, if it
works without the special case, drop it. **Tradeoff worth naming:** the spec
deliberately wanted the string path "untouched" for backward-compat confidence.
Since the behaviour is provably identical, collapsing it is safe, but it is a
judgement call rather than a defect.

### Suggested rewrite (fixes all three, and the bug)

```ts
const parts: Array<string | smoltalk.UserContentPart> =
  typeof result === "string" ? [result] : result;

/** A tool result can hold text or image/file parts. Text is joined into the
 *  tool message; attachments follow in a user message. */
function isAttachment(
  part: string | smoltalk.UserContentPart,
): part is ReplyAttachmentPart {
  if (typeof part === "string") {
    return false;
  }
  return part.type === "image" || part.type === "file";
}

function toText(part: string | smoltalk.UserContentPart): string {
  if (typeof part === "string") {
    return part;
  }
  return part.type === "text" ? part.text : "";
}

const attachments = parts.filter(isAttachment);
const text = parts.filter((p) => !isAttachment(p)).map(toText).join("\n");
const toolContent =
  attachments.length > 0 && text === "" ? "[see attached]" : text;
```

Every value is `const` and derived from its inputs, the two groups are named
rather than accumulated, the string special case disappears, and `isAttachment`
handles `TextPart` explicitly — closing the crash path without a separate guard.

### Inconsistent patterns: model-facing strings placed away from convention

`replyAttachments.ts` centralises its model-facing strings and flags them at the
top: "The marker strings below are MODEL-FACING API — tests pin them; do not
reword casually" (line 27). This plan introduces two more model-facing tokens —
`"[see attached]"` and the `att_` id prefix — inline in `thread.ts`, with no
such marking. Since `att_N` deliberately parallels the loop's `img_N`, they
belong next to it, or at minimum as named constants carrying the same warning.

### Clean on everything else

No nested ternaries (the one ternary is flat), no one-line `if`s, the `try`/`catch`
is unchanged and re-throws, no dynamic imports, no nested type definitions, no
`safeDelete` concern, and no catastrophic-failure tests. It also does **not**
duplicate an existing helper — there is no generic `partition<T>` in the tree
(the `partition*` functions found are all domain-specific), so `.filter()` is
the right tool rather than a missed reuse.

*Minor test hygiene (not in the catalog):* the inlining test creates a temp dir
via `mkdtempSync` and never cleans it up.

## Test-plan review: do the tests actually test the behavior?

The seven new cases are well chosen for the *shapes* they cover, and each would
fail if its target broke:

- Follow-up pushed when it shouldn't be → test 1's `toHaveLength(2)` fails.
- Join character changed → tests 1 and 5's `"a\nb"` fail.
- Attachments leaking into the tool-result text → test 2's `content === "Here:"`
  fails.
- Placeholder logic broken → test 3 fails.
- Follow-up push missing its `label` → test 4 fails.
- **`buildReplyUserMessage` swapped for a plain attachment push** → test 6's
  `source.kind === "base64"` fails. This is the highest-value test in the set,
  because push-time inlining is the entire justification for the reuse.
- An unreadable path throwing instead of noting → test 7 fails.

That is real coverage. The problem is what the set leaves completely dark.

### The whole `att_N` id scheme is untested

Two compounding gaps:

1. **Every test uses exactly one attachment.** So `` `att_${i + 1}` `` is only
   ever evaluated at `i === 0`. An off-by-one (`att_${i}` → `att_0`) or any
   indexing regression passes the entire suite.
2. **No test asserts the label text at all.** Nothing checks that the follow-up
   carries `[att_1 — image output of tool saveDraft]`. Change the prefix to
   `img_`, reword the label, or drop the tool name, and every test still passes.

The spec went out of its way to specify `att_N` as a deliberate, honest
divergence from the loop's `img_N`. Right now that decision has zero enforcement.
**Add one test with two attachments** asserting both labels (`att_1`, `att_2`)
and their order — that single test closes both gaps.

### The file-attachment branch is entirely unexercised

All seven tests use `_imageAttachment`. `buildReplyUserMessage` has a distinct
`file` path: the `kindWord` becomes `"file"`, `filename` is passed through, and
the mime default is `application/pdf` rather than `image/png`. None of it runs.
Add one `_fileAttachment` case.

### The inlining test proves less than it claims

Test 6 asserts `imgPart.source.kind === "base64"` — that inlining *happened* —
but never checks *what was inlined*. An implementation that inlined the wrong
bytes, or empty bytes, passes. Since the file is written as
`Buffer.from([1, 2, 3])`, assert the payload too:

```ts
expect(imgPart.source.base64).toBe(Buffer.from([1, 2, 3]).toString("base64"));
```

Stronger still, and closer to the actual claim ("a seeded path image survives a
later delete"): `rmSync` the temp file after the call and assert the message
still carries those bytes. That demonstrates the stability property rather than
inferring it.

### Other missing cases

- **Empty array `[]`** — untested, and per the finding above it produces an empty
  tool-result message with no placeholder. Whatever you decide it should do, pin
  it.
- **A `TextPart` element** — untested, and currently a crash. Needs a case once
  the type/impl mismatch is fixed.
- **Mixed image + file in one call** — follows from the two-attachment and
  file-attachment cases above.
- **`label` omitted on a three-message call** — tests 3, 5, 6 and 7 omit `label`
  but none asserts `labelAt(2) === null`. Minor, since `label || null` is shared
  across all three pushes.
- **Message count in tests 5 and 7** — neither asserts `toHaveLength(3)`, so a
  stray extra push would slip by in those two.

### Summary of what a break would *not* catch today

Changing the `att_` prefix; an off-by-one in the attachment id index; breaking
the file-attachment branch; inlining incorrect bytes; and any change to
empty-array behaviour.

## Bottom line

Fix the `UserContentInput`/`TextPart` mismatch before implementing — it's a real
crash path with a bad error message. Adopting the declarative rewrite above
fixes that bug and the two anti-patterns together. Then decide the empty-array
case, move the model-facing strings next to their siblings, and close the test
gaps — above all a two-attachment case asserting the `att_1`/`att_2` labels,
which is the only thing standing between the spec's id scheme and silent drift.
