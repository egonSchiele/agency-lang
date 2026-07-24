# `toolMessage` Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Widen `std::thread.toolMessage`'s `result` to accept `string | (string | Attachment)[]`, so a seeded tool result can carry images/files, delivered as a follow-up user message.

**Architecture:** A string result keeps the current two-message shape. An array is partitioned declaratively into text (joined with `\n`) and image/file attachments; text-part elements contribute their text, attachments go in a third follow-up **user** message built by reusing the loop's pure `buildReplyUserMessage` helper (for its push-time path→base64 inlining). Attachments and text land in separate messages — the flattening is forced by tool results being text-only at the protocol level.

**Tech Stack:** TypeScript (runtime), Agency (stdlib wrapper), `smoltalk` (message builders + content-part types), `buildReplyUserMessage` from `lib/runtime/replyAttachments.ts`, vitest.

## Global Constraints

- Reference spec: `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-21-toolmessage-attachments-design.md`.
- `result` is typed `smoltalk.UserContentInput` (the same type `_userMessage` accepts: `string | Array<string | UserContentPart>`, where `UserContentPart = TextPart | ImagePart | FilePart`). The implementation handles **all three** part kinds: strings and text parts become text; image/file parts become attachments. A non-string part is classified by its `type` field, never assumed to be an attachment — this is what stops a `TextPart` (which has no `source`) from crashing inside `buildReplyUserMessage`.
- Backward-compatible: every existing string caller keeps producing exactly the two-message pair. Verified by the untouched existing tests.
- Partition **declaratively** with named predicates (`isToolResultAttachment`, `toolResultPartText`), not a hand-rolled accumulator loop — every derived value is `const`.
- Model-facing tokens live as named constants with a warning comment: the `att_` id prefix (deliberately parallel to the loop's `img_N`, kept distinct) and the `[see attached]` placeholder.
- Text parts join with `"\n"`. Attachments and text go in separate messages; relative position is not preserved (forced by the protocol).
- Follow-up user message built via `buildReplyUserMessage` (push-time path inlining, never throws on a missing file). Ids are per-call `att_1`, `att_2`, … — not the loop's shared `img_N`.
- **Empty array** (`[]`) and empty string (`""`) both produce empty tool-result content and no follow-up — two messages. The `[see attached]` placeholder fires only when there is at least one attachment and no text.
- `label` rides on **all** messages a call pushes (two, or three with attachments).
- No `img_N` parity, no shared counter, no correlation marker, no gating (spec's non-goals). The `#641` `args` guards (serialize-or-throw, non-object check) stay exactly as they are.
- Never use dynamic imports. Use `type` not `interface`. No nested ternaries.

---

### Task 1: Widen `_toolMessage` to accept attachments

**Files:**
- Modify: `packages/agency-lang/lib/stdlib/thread.ts` (imports, two module-level helpers + two constants, and the `_toolMessage` body)
- Test: `packages/agency-lang/lib/stdlib/toolMessage.test.ts` (add cases)

**Interfaces:**
- Consumes: `buildReplyUserMessage`, `HarvestedReplyAttachment`, `ReplyAttachmentPart` from `../runtime/replyAttachments.js`; `smoltalk.userMessage`, `smoltalk.UserContentInput`, `smoltalk.UserContentPart`; `_imageAttachment` / `_fileAttachment` from `./thread.js` (in the test).
- Produces: `_toolMessage(name: string, args: any, result: smoltalk.UserContentInput, label?: string): Promise<void>` — a string result pushes two messages; an array with attachments pushes three.

- [ ] **Step 1: Write the failing tests**

At the top of `packages/agency-lang/lib/stdlib/toolMessage.test.ts`, extend the `./thread.js` import and add fs/os/path imports:

```ts
import { _toolMessage, _imageAttachment, _fileAttachment } from "./thread.js";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

Add these `it(...)` blocks inside the existing `describe("_toolMessage", …)`:

```ts
  it("text-only array is two messages joined with newlines, no follow-up", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      async () => {
        await _toolMessage("t", { a: 1 }, ["a", "b"], "L");
      },
    );
    const msgs = threads.getOrCreateActive().getMessages().map((m: any) => m.toJSON());
    expect(msgs).toHaveLength(2);
    expect(msgs[1].role).toBe("tool");
    expect(msgs[1].content).toBe("a\nb");
  });

  it("empty array is empty tool content, two messages, no placeholder", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      async () => {
        await _toolMessage("t", { a: 1 }, []);
      },
    );
    const msgs = threads.getOrCreateActive().getMessages().map((m: any) => m.toJSON());
    expect(msgs).toHaveLength(2);
    expect(msgs[1].content).toBe("");
  });

  it("a text-part element contributes its text to the tool result", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const img = _imageAttachment("AAAB", "image/png", true);
    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      async () => {
        await _toolMessage("t", { a: 1 }, [{ type: "text", text: "hi" } as any, img]);
      },
    );
    const msgs = threads.getOrCreateActive().getMessages().map((m: any) => m.toJSON());
    expect(msgs).toHaveLength(3);
    expect(msgs[1].content).toBe("hi");
    expect(msgs[2].role).toBe("user");
  });

  it("array with an image produces three messages; the label names the tool", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const img = _imageAttachment("AAAB", "image/png", true);
    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      async () => {
        await _toolMessage("saveDraft", { a: 1 }, ["Here:", img], "L");
      },
    );
    const msgs = threads.getOrCreateActive().getMessages().map((m: any) => m.toJSON());
    expect(msgs).toHaveLength(3);
    expect(msgs[1].content).toBe("Here:");
    expect(msgs[2].role).toBe("user");
    const parts = msgs[2].content as any[];
    expect(parts.find((p) => p.type === "image")).toBeDefined();
    // att_N label text is pinned, including the tool name.
    expect(parts.find((p) => p.type === "text")?.text).toBe(
      "[att_1 — image output of tool saveDraft]",
    );
  });

  it("two attachments get att_1 and att_2 in order", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const a = _imageAttachment("AAAB", "image/png", true);
    const b = _imageAttachment("CCCD", "image/png", true);
    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      async () => {
        await _toolMessage("t", { a: 1 }, ["x", a, b]);
      },
    );
    const parts = threads.getOrCreateActive().getMessages()[2].toJSON().content as any[];
    const labels = parts.filter((p) => p.type === "text").map((p) => p.text);
    expect(labels).toEqual([
      "[att_1 — image output of tool t]",
      "[att_2 — image output of tool t]",
    ]);
  });

  it("carries a file attachment in the follow-up", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const file = _fileAttachment("AAAB", "doc.pdf", "application/pdf", true);
    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      async () => {
        await _toolMessage("t", { a: 1 }, [file]);
      },
    );
    const parts = threads.getOrCreateActive().getMessages()[2].toJSON().content as any[];
    expect(parts.find((p) => p.type === "file")).toBeDefined();
  });

  it("image-only result uses the [see attached] placeholder", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const img = _imageAttachment("AAAB", "image/png", true);
    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      async () => {
        await _toolMessage("t", { a: 1 }, [img]);
      },
    );
    const msgs = threads.getOrCreateActive().getMessages().map((m: any) => m.toJSON());
    expect(msgs).toHaveLength(3);
    expect(msgs[1].content).toBe("[see attached]");
  });

  it("labels all three messages", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const img = _imageAttachment("AAAB", "image/png", true);
    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      async () => {
        await _toolMessage("t", { a: 1 }, ["x", img], "budget");
      },
    );
    const thread = threads.getOrCreateActive();
    expect(thread.labelAt(0)).toBe("budget");
    expect(thread.labelAt(1)).toBe("budget");
    expect(thread.labelAt(2)).toBe("budget");
  });

  it("flattens interleaved text and images", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const img = _imageAttachment("AAAB", "image/png", true);
    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      async () => {
        await _toolMessage("t", { a: 1 }, ["a", img, "b"]);
      },
    );
    const msgs = threads.getOrCreateActive().getMessages().map((m: any) => m.toJSON());
    expect(msgs).toHaveLength(3);
    expect(msgs[1].content).toBe("a\nb");
    expect(msgs[2].role).toBe("user");
  });

  it("inlines a file-path image to base64 and keeps it after the file is deleted", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const dir = mkdtempSync(join(tmpdir(), "tm-"));
    const file = join(dir, "pic.png");
    const bytes = Buffer.from([1, 2, 3]);
    writeFileSync(file, bytes);
    const img = _imageAttachment(file, "", false); // path source
    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      async () => {
        await _toolMessage("t", { a: 1 }, [img]);
      },
    );
    rmSync(dir, { recursive: true, force: true }); // gone after the seed
    const parts = threads.getOrCreateActive().getMessages()[2].toJSON().content as any[];
    const imgPart = parts.find((p) => p.type === "image");
    expect(imgPart.source.kind).toBe("base64"); // inlined at push
    expect(imgPart.source.base64).toBe(bytes.toString("base64")); // the right bytes
  });

  it("does not throw on an unreadable path; emits a text note", async () => {
    const ctx = makeCtx();
    const threads = ThreadStore.withDefaultActive(ctx.statelogClient);
    const img = _imageAttachment("/no/such/file.png", "", false);
    await agency.withTestContext(
      { ctx, stack: ctx.stateStack, threads },
      async () => {
        await _toolMessage("t", { a: 1 }, [img]);
      },
    );
    const msgs = threads.getOrCreateActive().getMessages().map((m: any) => m.toJSON());
    expect(msgs).toHaveLength(3);
    const notes = (msgs[2].content as any[]).filter((p) => p.type === "text");
    expect(notes.some((p) => /could not be read/.test(p.text))).toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify they fail (and confirm the toJSON hop works)**

Run: `pnpm exec vitest run lib/stdlib/toolMessage.test.ts`
Expected: the new array cases FAIL (the `result: string` param rejects/ stringifies an array). The existing string-path cases still PASS. If a failure is a *shape* mismatch on `msgs[2].content` (e.g. content is not the parts array these tests assume), note the actual shape now — the tests read `smoltalk.userMessage(parts).toJSON().content`, a hop the existing reply-attachment tests do not exercise (they assert on `buildReplyUserMessage`'s return directly). It should round-trip to a `UserContentPart[]`; if it nests differently, adjust the accessor before Step 5.

- [ ] **Step 3: Update the imports**

In `packages/agency-lang/lib/stdlib/thread.ts`, replace the existing `import type { ReplyAttachmentPart } from "../runtime/replyAttachments.js";` (line 3) with:

```ts
import {
  buildReplyUserMessage,
  type ReplyAttachmentPart,
  type HarvestedReplyAttachment,
} from "../runtime/replyAttachments.js";
```

- [ ] **Step 4: Add the constants + helpers, and rewrite the `_toolMessage` body**

In `packages/agency-lang/lib/stdlib/thread.ts`, add these module-level constants and helpers just above `_toolMessage`:

```ts
// Model-facing tokens for seeded tool attachments. `att_` deliberately parallels
// the loop's `img_N` (lib/runtime/replyAttachments.ts) while staying distinct, so
// the two id schemes are not confused. The placeholder both fills an otherwise-
// empty tool result and tells the model that attachments follow. A model may read
// these; keep them stable.
const SEEDED_ATTACHMENT_ID_PREFIX = "att_";
const EMPTY_ATTACHMENT_PLACEHOLDER = "[see attached]";

/** A tool-result part is an attachment when it is an image or file part. A bare
 *  string or a text part is not. Classifying by `type` (never "not a string") is
 *  what keeps a text part — which has no `source` — out of buildReplyUserMessage. */
function isToolResultAttachment(
  part: string | smoltalk.UserContentPart,
): part is ReplyAttachmentPart {
  return (
    typeof part !== "string" && (part.type === "image" || part.type === "file")
  );
}

/** The text a non-attachment part contributes: a bare string as-is, a text
 *  part's text, and "" for anything else (which the type does not permit). */
function toolResultPartText(part: string | smoltalk.UserContentPart): string {
  if (typeof part === "string") {
    return part;
  }
  if (part.type === "text") {
    return part.text;
  }
  return "";
}
```

Then change the `_toolMessage` signature's `result` type and replace its tail (from `const id = nanoid();` through the two existing `thread.push(...)` calls). Leave the `args` validation block (the `try`/`catch` and the non-object `if`) exactly as it is. New signature line:

```ts
export async function _toolMessage(
  name: string,
  args: any,
  result: smoltalk.UserContentInput,
  label: string = "",
): Promise<void> {
```

New tail (replacing everything after the `args` validation block):

```ts
  // A string result keeps the two-message shape. An array is partitioned into
  // its text (joined with newlines) and its image/file attachments. A tool
  // result is text-only, so attachments cannot ride in it — they follow in a
  // user message.
  const parts: Array<string | smoltalk.UserContentPart> =
    typeof result === "string" ? [result] : result;
  const attachments = parts.filter(isToolResultAttachment);
  const text = parts
    .filter((p) => !isToolResultAttachment(p))
    .map(toolResultPartText)
    .join("\n");
  const toolContent =
    attachments.length > 0 && text === "" ? EMPTY_ATTACHMENT_PLACEHOLDER : text;

  const id = nanoid();
  const { threads } = getRuntimeContext();
  const thread = threads.getOrCreateActive();

  thread.push(
    smoltalk.assistantMessage("", {
      toolCalls: [new smoltalk.ToolCall(id, name, argsRecord)],
    }),
    label || null,
  );
  thread.push(
    smoltalk.toolMessage(toolContent, { tool_call_id: id, name }),
    label || null,
  );

  if (attachments.length > 0) {
    // Reuse buildReplyUserMessage: it inlines file-path images to base64 HERE
    // (so a seeded path image survives a later delete/edit) and never throws on
    // a missing file.
    const entries: HarvestedReplyAttachment[] = attachments.map((part, i) => ({
      id: `${SEEDED_ATTACHMENT_ID_PREFIX}${i + 1}`,
      toolName: name,
      part,
    }));
    thread.push(
      smoltalk.userMessage(
        buildReplyUserMessage(entries) as smoltalk.UserContentInput,
      ),
      label || null,
    );
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run lib/stdlib/toolMessage.test.ts`
Expected: PASS — the original 8 plus the 12 new cases.

- [ ] **Step 6: Commit**

```bash
git add packages/agency-lang/lib/stdlib/thread.ts packages/agency-lang/lib/stdlib/toolMessage.test.ts
git commit -m "feat(thread): _toolMessage accepts attachments via a follow-up user message"
```

---

### Task 2: Widen the Agency wrapper and document the flattening

**Files:**
- Modify: `packages/agency-lang/stdlib/thread.agency` (the `toolMessage` wrapper type + docstring)
- Modify: `packages/agency-lang/lib/runtime/replyAttachments.ts` (module doc — name the second consumer)

**Interfaces:**
- Consumes: `_toolMessage` (Task 1); the `Attachment` type already in `stdlib/thread.agency`.
- Produces: Agency `toolMessage(name, args, result: string | (string | Attachment)[], label = "")`.

- [ ] **Step 1: Widen the wrapper and update its docstring**

In `packages/agency-lang/stdlib/thread.agency`, replace the `toolMessage` wrapper with:

```ts
export def toolMessage(
  name: string,
  args: any,
  result: string | (string | Attachment)[],
  label: string = "",
) {
  """
  Add a synthetic tool call and its result to the current thread, as if the
  model had made the call. Nothing runs; this only shapes the conversation the
  model reads on its next llm() call. Use it to make the model see work a
  scaffold did on its behalf. Call it at a clean point in the thread, not in
  the middle of a tool exchange still waiting for its result.

  result may be a string, or an array mixing text and image/file attachments.
  Tool results are text-only, so attachments cannot ride in the tool message:
  the text parts are joined with newlines and sent as the tool result, and the
  attachments follow in a separate user message. The position of text relative
  to attachments is therefore not preserved.

  @param name - The tool name the model will see it "called"
  @param args - The call arguments, as an object (serialized to JSON)
  @param result - The tool response: a string, or an array of text and attachments
  @param label - Optional debug tag shown in statelog. Never sent to the model.
  """
  _toolMessage(name, args, result, label)
}
```

- [ ] **Step 2: Name the second consumer in `replyAttachments.ts`**

In `packages/agency-lang/lib/runtime/replyAttachments.ts`, the top-of-file module comment describes the file as the tool-loop reply channel and flags its marker/label strings as "MODEL-FACING API — tests pin them." Add one sentence to that comment, right after the "MODEL-FACING API" note:

```ts
 * SECOND CONSUMER: std::thread.toolMessage (lib/stdlib/thread.ts) also calls
 * buildReplyUserMessage to attach images to a seeded tool result. A change to
 * that function's output shape or its label wording affects seeded messages
 * too, not just the live tool loop.
```

- [ ] **Step 3: Rebuild the stdlib**

Run: `make`
Expected: build succeeds with no `error` lines for `stdlib/thread.agency`.

- [ ] **Step 4: Confirm the existing Agency round-trip test still passes**

Run: `pnpm run a test tests/agency/thread/toolmessage-roundtrip.agency`
Expected: PASS (`assistant|tool:Draft saved.`) — the string path is unchanged.

- [ ] **Step 5: Regenerate stdlib docs**

Run: `make doc`
Expected: `docs/site/stdlib/thread.md` shows the widened `result` type and the flattening note.

- [ ] **Step 6: Commit**

```bash
git add packages/agency-lang/stdlib/thread.agency packages/agency-lang/lib/runtime/replyAttachments.ts packages/agency-lang/docs/site/stdlib/thread.md
git commit -m "feat(thread): widen toolMessage result to accept attachments; document flattening"
```

---

## Self-Review

**Spec coverage:**
- `result` widened to `string | (string | Attachment)[]` (wrapper) / `UserContentInput` (runtime) — Task 1 Step 4, Task 2 Step 1. ✓
- String result unchanged (two messages) — the `typeof result === "string"` widen-to-`[result]` path yields no attachments and no follow-up; pinned by the untouched existing tests plus "text-only array" and "empty array". ✓
- Array → split text (`\n`-joined) + attachments; three-message follow-up — Task 1 Step 4 + the image/two-attachment/flatten tests. ✓
- Reuse `buildReplyUserMessage` for push-time inlining — Task 1 Step 4; pinned by the "inlines a file-path image … keeps it after delete" test (asserts `base64` kind AND the exact bytes AND survival post-`rmSync`). ✓
- `att_N` ids, no `img_N`/marker/gating — Task 1 Step 4; the `att_1`/`att_2` label text is asserted by the image and two-attachment tests. ✓
- `[see attached]` placeholder only for attachments-with-no-text; empty array/string → empty content — Task 1 Step 4 + placeholder and empty-array tests. ✓
- `label` on all messages — Task 1 Step 4 (`label || null` on every push) + "labels all three". ✓
- Text-part handling (no crash) — `isToolResultAttachment` classifies by `type`, `toolResultPartText` extracts text; pinned by the "text-part element" test. ✓
- File-attachment branch — the `_fileAttachment` test. ✓
- Unreadable path does not throw — inherited from `buildReplyUserMessage` + the unreadable-path test. ✓
- Docstring states the flattening; second consumer named in `replyAttachments.ts` — Task 2 Steps 1 and 2. ✓

**Placeholder scan:** No TBD/TODO. Every code step shows full code. Step 2's note is a bounded "confirm the toJSON shape" check, not deferred logic.

**Type consistency:** `_toolMessage(… result: smoltalk.UserContentInput …)` (Task 1) is fed by the wrapper's `string | (string | Attachment)[]` (Task 2), the same pairing `userMessage`/`_userMessage` already use (stdlib attachments are assignable to `smoltalk.UserContentPart`). `isToolResultAttachment` narrows to `ReplyAttachmentPart` (smoltalk `ImagePart | FilePart`, the element type `buildReplyUserMessage` consumes). `HarvestedReplyAttachment` `{ id, toolName, part }` matches. The follow-up push mirrors the loop's `smoltalk.userMessage(buildReplyUserMessage(entries) as smoltalk.UserContentInput)` at `prompt.ts:1848`, plus `label || null`.

**Anti-pattern check (the review's focus):** the split is now a declarative `.filter()` partition with named predicates, every value `const` and derived from inputs — no accumulator loop, no order-dependent mutable state. Model-facing strings are named constants with a warning comment. The one ternary (`toolContent`) is flat. No nested ternaries, no dynamic imports.
