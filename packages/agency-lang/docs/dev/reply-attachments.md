# Tool reply attachments

How a tool hands images back to the model. A base64 string in a tool
result is text to the model — vision input must travel as image parts,
and most providers do not accept image parts in tool results. So agency
routes them through a labeled user message injected after the tool
round.

## Flow

1. A tool calls `std::thread.attachToReply(image(path))` during its
   invocation. The bridge (`lib/stdlib/thread.ts:_attachToReply`) pushes
   onto the CALLING INVOCATION's branch-local `stack.other`
   (`pendingReplyAttachments`) — each parallel tool call has its own
   branch stack, so queues cannot mix, and branch state serializes, so a
   mid-round interrupt cannot drop a queued attachment. Outside a tool
   invocation (`ctx.isInsideToolCall()` false) the attachment is dropped
   with a statelog error.
2. `runInvokeStep` (lib/runtime/prompt.ts) harvests at invocation
   completion, inside the idempotent per-tool invoke `b.step` — exactly
   once per tool call across interrupt/resume. Harvest
   (`lib/runtime/replyAttachments.ts`) gates each entry — modality
   (tri-state via smoltalk's `modelSupportsInputModality`; only an
   explicit `false` drops), missing file, size (20 MB), per-call count
   (10) — assigns a persistent `img_N` id from a counter on
   `self.runnerState`, appends the model-facing marker to that tool's
   result text, and moves survivors to
   `self.runnerState.replyAttachments` (per-llm()-call, serialized,
   fork-safe).
3. After `stack.popBranches()` and before the next LLM call, the round
   boundary (`runRoundBoundary` in `lib/runtime/turnBoundary.ts`,
   `attachmentsProducer`) injects ONE user message (`pr.step`
   "round.N.attachReplies", resume-idempotent): a label text part before each attachment part. Path
   sources are inlined to base64 at build time so the persistent thread
   never re-reads a deletable file; url/base64 sources pass through.
   Injection after the COMPLETE round satisfies every provider's
   adjacency rule (all tool results must directly follow the
   assistant's tool calls).

## Marker strings are model-facing API

Pinned by tests/agency/attach-to-reply tests and
lib/runtime/replyAttachments.test.ts — do not reword without updating
both and considering deployed prompts (they contain em-dashes, not
hyphens):

- `[attached img_N — delivered in the user message following these tool results]`
- `[attachment img_N skipped: too large to attach (over 20 MB)]`
- `[attachment img_N skipped: the current model has no image input]` (or `PDF`)
- `[attachment img_N skipped: too many attachments for this llm() call (limit 10)]`
- `[attachment img_N skipped: file not found]`
- label part: `[img_N — image output of tool <name>]` (or `file output`)

## Failure semantics

A tool that fails/crashes/gets rejected loses its queued attachments
with its branch (`stack.deleteBranch`) — intended: a failed tool's
images must not be shown. Skips never fail the turn; they become
markers. On Anthropic the injected message follows the tool_result user
message as a consecutive user message (API combines same-role
messages; smoltalk is growing a client-side merge as belt and
suspenders).

First consumer: the agent's `generateImageFile`. Future:
`viewAttachment` (attachment-store track) reuses this channel
unchanged.
