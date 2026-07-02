---
name: Tool reply attachments (images from tool calls)
description: Let a tool call hand images back to the model — attachToReply() queues attachments during a tool invocation; the LLM tool loop injects them as one labeled user message after the tool round, uniformly across providers. Unlocks generate→view→refine and the future viewAttachment tool.
status: implemented
date: 2026-07-02
---

# Tool reply attachments

## Summary

A tool cannot "return" an image today: tool results are text, and a base64 string in a tool result is just tokens — it never reaches the model's vision encoder. This spec adds the missing channel, **entirely on the agency side**:

1. **`std::thread.attachToReply(attachment)`** — a tool calls this during its invocation to queue an image (or PDF) for the model.
2. **The LLM tool loop** (`lib/runtime/prompt.ts`) harvests queued attachments per tool invocation, appends an ID-bearing marker to that tool's result text, and — after ALL tool results for the round — injects **one labeled user message** carrying the image parts, then re-prompts.

First consumer: `generateImageFile` attaches the image it just saved, so the agent can see what it generated. The future `viewAttachment` tool (attachment-store track) becomes the second consumer with no new machinery.

## Background: why this shape

Investigated during brainstorming (2026-07-02), grounded in provider wire formats:

- **Native image-in-tool-result support is not unifiable.** Anthropic's `tool_result.content` accepts image blocks natively; OpenAI chat-completions tool messages are text-only; Gemini `functionResponse` is JSON-only; OpenAI Responses needs verification. smoltalk's value is a unified provider API — a feature that is native on one provider and silently rewrites message history on the others is a leaky unification. **Rejected: teaching smoltalk `ToolMessage` to carry image parts.**
- **The user-message shim is the portable channel.** Every image-capable provider accepts image parts in a user message, and the modality gate already governs which models those are.
- **Agency owns the shim, not smoltalk.** The rewrite is conversation *choreography*, not wire serialization. Doing it in the agency tool loop means: (a) users with custom `LLMClient` implementations get it for free; (b) everything downstream — attachment resolution, the 20 MB cap, `validateModalities`, statelog redaction, `[image attachment]` transcript rendering, thread persistence — applies automatically because the injected message is an ordinary user message; (c) it is pinned by agency execution tests with the deterministic client. **Rejected: a smoltalk-internal tool-message→user-message rewrite.**
- **Adjacency rules dictate the injection point.** Providers require the assistant's tool calls to be answered by ALL their tool results before any other message (OpenAI: every `tool_call_id` must get a `role:"tool"` message first; Anthropic: `tool_result` blocks in the immediately-following user message; Gemini: `functionResponse` follows `functionCall`). Therefore: **inject after the complete tool round, never between results.** `assistant(tool_calls) → tool… → user(images) → assistant` is valid everywhere.

### Prerequisite (smoltalk, owner: Aditya)

On Anthropic, tool results are themselves user messages, so injection produces consecutive `role:"user"` messages. Current Anthropic docs state consecutive same-role messages are combined server-side, but smoltalk's serializer merge is currently tool_result-only (`anthropic.js` merge condition requires `every(c => c.type === "tool_result")`). **smoltalk change: merge any consecutive user messages for providers that need it**, appending the later message's blocks after the earlier's (this keeps Anthropic's "tool_result blocks first in the message" rule satisfied and lands the semantically-nicest wire form). This also fixes a latent today-bug: two back-to-back `userMessage()` calls hit the same edge. Agency's injection does not hard-depend on the merge (server-side combining covers it), but the spec pins the smoltalk version once the merge ships.

## Design

### 1. The tool-side surface: `attachToReply`

```
export safe def attachToReply(attachment: Attachment) {
  """
  Queue an attachment (see image()/file()) to be shown to the model
  after the current tool call completes. Only meaningful while running
  as a tool inside an llm() call: the tool's text result is delivered
  as usual, and the queued attachments follow it as a single user
  message the model can see. Outside a tool invocation, the attachment
  is dropped with a statelog error.

  @param attachment - The attachment to show the model (from image() / file())
  """
  _attachToReply(attachment)
}
```

- Plain `Attachment` values — path, URL, or base64 sources all allowed. Tools should prefer **path/URL sources** (see §4, checkpoint weight).
- No return value; queuing cannot fail (over-cap and modality problems are handled at harvest/injection with visible markers, never by failing the tool).

### 2. Storage and concurrency (the load-bearing part)

Tool calls run **in parallel**, each in its own child branch of the `llm()` call's execution; and `llm()` calls themselves run in parallel under `fork`/`race`. The collector placement follows from that:

- **`attachToReply` pushes onto the calling tool invocation's own branch state** (the serialized per-branch bag, same placement family as `llmDefaults` in `stack.other`). Branch-local ⇒ no cross-talk between parallel tool calls, and the queue serializes with the branch, so a mid-invocation interrupt/resume cannot silently drop a queued attachment.
- **The tool loop harvests at invocation completion** — the loop awaits each tool call, and where it builds that tool's `ToolMessage` it drains the child's queue. This is the child-collects/parent-harvests-at-join pattern the per-branch cost roll-up already uses. Attribution is structural: whatever came from invocation X belongs to tool result X, regardless of interleaving.
- **The round buffer is local to the `runPrompt` invocation** — per-`llm()`-call by construction, so forked `llm()` calls each inject only their own attachments.
- **NOT on the global runtime context** (parallel `llm()` calls would cross-contaminate) and **NOT left in the child branch** (it would vanish at branch teardown / never reach the parent's message list).

### 3. IDs and the model-facing contract

Harvest runs in the loop's single-threaded code, so IDs are assigned there — sequential per round (`img_1`, `img_2`, …), no cross-thread coordination, deterministic under resume. The ID appears in both places the model needs for correlation:

- **Auto-appended marker on the tool result** (the loop appends it; tools never hand-write it, so it is always accurate):

  ```
  [attached img_1 — delivered in the user message following these tool results]
  ```

  Variants: `[attachment img_1 skipped: too large to attach (over 20 MB)]`, `[attachment img_1 skipped: the current model has no image input]` (the model is not named — `clientConfig.model` passes through to the modality probe unmodified, exactly as smoltalk's send gate does, and may be a structured value), `[attachment img_1 skipped: file not found]` (a bad path is caught at harvest so the tool result never claims "attached" for a file that cannot be read), and — when `attachToReply` is called outside a tool invocation — nothing (statelog error only).

- **The injected user message**, appended once after the round's final tool result:

  ```
  parts: [
    text: "[img_1 — image output of tool generateImageFile]",
    image(img_1 bytes),
    text: "[img_2 — image output of tool viewAttachment]",
    image(img_2 bytes),
  ]
  ```

  One text label part immediately precedes each image part. Multiple tools in one round share the single injected message (adjacency rule).

### 4. Harvest-time gating and inlining

At harvest (per invocation) and injection (per round), in loop code:

- **Modality gate**: `_modelSupportsInput(model, "image" | "pdf")` against the request's resolved model — on explicit `false`, the attachment is dropped with the skip marker on the tool result; `true`/`null` attach (identical tri-state rule to the send gate; never a failed turn).
- **Size cap**: 20 MB decoded (smoltalk's cap), checked before injection so an oversized attachment becomes a skip marker instead of a whole-turn Failure at `prepareAttachments`.
- **Inline at injection**: path-sourced attachments are converted to base64 parts when the user message is built (same rationale as detection: the persistent thread must not re-read paths at every send). Queue entries stay path-sourced until then, keeping serialized branch state light — a checkpoint mid-round carries file paths, not megabytes of base64. Tools that only have bytes (future `viewAttachment` reading from a store) may queue base64 directly; the docstring steers toward paths.
- **Per-call cap**: 10 attachments per `llm()` call (strictly tighter than per-round; matches detection); over-cap entries get `[attachment img_N skipped: too many attachments for this llm() call (limit 10)]`.

### 5. What falls out for free

Because the injected message is an ordinary user message on the loop's `MessageThread`:

- statelog records it with payloads redacted (`redactPromptForLog` family);
- transcripts/summaries render `[image attachment]` (`_contentToString`);
- it persists in `session:`-backed threads and will be swept by the future eviction window;
- smoltalk resolution + `validateModalities` apply at send unchanged.

### 6. First consumer: `generateImageFile`

After a successful save, the tool queues the saved file:

```
  const written = writeBinary(basename(path), generated.value.base64, dirname(path), useAgentCwd: true)
  if (isFailure(written)) {
    return "Generated the image, but saving to ${path} failed: ${written.error}"
  }
  attachToReply(image(applyAgentCwd(path)))
  return "Saved image to ${path}"
}
```

The model's next turn sees the tool result (`Saved image to … [attached img_1 — …]`) followed by the image itself — the missing half of generate→view→refine. No system-prompt change required for v1 (the marker text is self-explanatory); prompting the agent to *iterate* on what it sees is out of scope.

## Non-goals (v1)

- `viewAttachment` / `listAttachments` and the attachment store — separate track; they become the second consumer of `attachToReply` unchanged.
- Native Anthropic `tool_result` image blocks — revisit only if providers converge; the agency-side channel is forward-compatible (swap the injection for native parts without touching `attachToReply` or its callers).
- Refinement prompting (teaching the agent to critique-and-regenerate).
- Attachments from handler bodies or non-tool contexts (dropped with a statelog error).

## Testing

- **Runtime units (vitest, deterministic client)**: harvest attribution under parallel tool calls (two tools attach concurrently → each marker names only its own IDs; injected message order matches tool-result order); over-cap/modality/outside-tool paths produce the specified markers and never throw; queue entries survive an interrupt/resume mid-round (branch-state serialization).
- **Agency execution tests**: a test tool calling `attachToReply` → assert via `getThread` that the tool result carries the marker and the following user message renders `[image attachment]`; a fork with two concurrent `llm()` calls each using attaching tools → no cross-contamination (each thread's injected message contains only its own IDs); text-only model (`gpt-3.5-turbo` via `applyResolved`) → skip marker, turn succeeds.
- **Agent integration**: `generateImageFile` end-to-end — deterministic image client → save → marker on tool result → placeholder in thread.

## Open implementation risks

1. **Harvest plumbing depends on `prompt.ts` internals** — where tool invocations create branches and how their state is reachable at completion (`parentFrame` path vs direct invoke). The plan must be grounded in the actual invoke/interrupt code paths, including the two-trip interrupt path (a tool that interrupts completes its invocation only after resume; harvest must run exactly once).
2. **`stack.other` bag growth** — path-sourced entries keep checkpoints light, but nothing structurally prevents a tool from queuing large base64; consider a queue-time size check (cheap: base64 length) in addition to the injection-time cap.
3. **Anthropic consecutive-user form** — until the smoltalk merge ships, injection relies on the API's documented server-side combining of consecutive same-role messages. If an alternation 400 ever appears in practice, the smoltalk merge is the fix (and is worth shipping regardless).
4. **Marker text is model-facing API** — once shipped, tools and models depend on its shape; treat wording changes as breaking-ish (statelog/test assertions pin it).
