# Tool reply attachments

How a tool hands images back to the model. A base64 string in a tool
result is just text to the model. Vision input must travel as image
parts, and most providers do not accept image parts in tool results. So
Agency routes them through a labeled user message injected after the
tool round.

## Flow

1. A tool calls `std::thread.attachToReply(image(path))` during its
   invocation. The bridge (`_attachToReply` in `lib/stdlib/thread.ts`)
   pushes onto the CALLING INVOCATION's branch-local `stack.other`
   (`pendingReplyAttachments`) through
   `StateStack.queueReplyAttachment`. Each parallel tool call has its
   own branch stack, so queues cannot mix. Branch state serializes, so a
   mid-round interrupt cannot drop a queued attachment. Outside a tool
   invocation, where `ctx.isInsideToolCall()` is false, the bridge drops
   the attachment and writes a statelog error.
2. `runInvokeStep` (lib/runtime/prompt.ts) harvests at invocation
   completion, inside the idempotent per-tool invoke step, so harvest
   runs exactly once per tool call across interrupt and resume.
   `harvestReplyAttachments` (`lib/runtime/replyAttachments.ts`) gates
   each entry on four things: modality, a missing file, size
   (`MAX_REPLY_ATTACHMENT_BYTES`, 20 MB) and per-call count
   (`MAX_REPLY_ATTACHMENTS_PER_CALL`, 10). The modality gate is
   tri-state through smoltalk's `modelSupportsInputModality`, and only
   an explicit `false` drops the attachment. Harvest then assigns a
   persistent `img_N` id from a counter on `runnerState`, appends the
   model-facing marker to that tool's result text, and moves survivors
   to `runnerState.replyAttachments`, which is per-`llm()`-call,
   serialized and fork-safe.
3. After `stack.popBranches()` and before the next LLM call, the round
   boundary injects ONE user message. `runRoundBoundary`
   (`lib/runtime/turnBoundary.ts`) drains `attachmentsProducer` under
   the resume-idempotent step key `round.<n>.attachReplies`, and
   `buildReplyUserMessage` puts a label text part before each
   attachment part. Path sources are inlined to base64 at build time, so
   the persistent thread never re-reads a file that may be deleted;
   url and base64 sources pass through. Injecting after the COMPLETE
   round satisfies every provider's adjacency rule, which requires all
   tool results to directly follow the assistant's tool calls.

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

A tool that fails, crashes or gets rejected loses its queued
attachments along with its branch (`stack.deleteBranch`). That is
intended, because a failed tool's images must not be shown. Skips never
fail the turn, they become markers. On Anthropic the injected message follows the tool_result user
message as a consecutive user message (API combines same-role
messages; smoltalk is growing a client-side merge as belt and
suspenders).

The first consumer is the agent's `generateImageFile`
(`lib/agents/agency-agent/lib/images.agency`). A future
`viewAttachment` on the attachment-store track reuses this channel
unchanged.
