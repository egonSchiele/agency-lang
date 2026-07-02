---
name: Agent image generation + attachments
description: Wire the merged multimodal capability into the built-in agency agent — a generate/modify-image tool that saves to disk, and auto-attaching image/PDF file paths (drag-drop or mentioned) from the user's message to the LLM turn.
status: implemented
date: 2026-07-02
---

# Agent image generation + attachments

## Summary

The multimodal work (image attachments on `llm()` / `userMessage()`, `std::image.generateImage`, `writeBinary`) is merged. This spec wires it into the built-in agent (`lib/agents/agency-agent/`) as two features:

1. **Image generation tool** — the agent can generate or modify images and save them to disk.
2. **User attachments** — when the user's message references an image/PDF file path (via terminal drag-drop, which inserts a path, or an explicit mention), the agent auto-attaches that file to the LLM turn.

## Background: the agent turn

- A user message flows `repl(onSubmit: _runTurn) → agentReply(userMsg) → agentReplyVia("", userMsg) → mainAgent(prompt) → llm(prompt, { tools: mainAgentTools })` (`agent.agency`).
- `mainAgentTools` is a list of the subagent tools; adding a tool means adding a function to that list (in Agency, functions *are* tools).
- `llm()` already accepts `string | (string | Attachment)[]` (merged), so the turn can carry attachments once we build the array.
- Already imported by `agent.agency`: `exists` (`std::shell`), `setAgentCwd` (`std::index`); `writeBinary`/`readBinary`/`applyAgentCwd` are auto-imported. New imports needed: `generateImage` (`std::image`); `image`/`file` and the `Attachment` type (`std::thread`); `stat` (`std::shell`); `env` (`std::system`); `map` (`std::array`); `basename` (`std::path`).
- The agent always has an agent cwd: `setupSession` calls `setAgentCwd(cwd())` unconditionally, and every existing agent file tool resolves against it (`read.partial(useAgentCwd: true)` etc. in the subagent tool lists). Both new features must follow that convention.

## Feasibility: terminal drag-and-drop

A terminal program cannot intercept the OS file-drop event. But every common terminal (Terminal.app, iTerm2, VS Code, GNOME Terminal, Windows Terminal) handles a drop by **inserting the file's path into the current input line** — usually absolute, often shell-quoted (`'…'`) or backslash-escaped (`my\ file.png`). Our REPL reads a line, so a dropped file arrives as a path token in the submitted message. Therefore drag-drop and explicit path mentions are the **same problem**: detect file paths in the message. No terminal integration is required (or possible from a TUI).

## Part A — Image generation tool

A new agent tool added to `mainAgentTools`. It generates (or modifies) and **saves to disk**, returning the path — never base64, which would flood the LLM context.

```ts
import { generateImage } from "std::image"
import { map } from "std::array"

def generateImageFile(
  prompt: string,
  path: string,
  size: string = "",
  images: string[] = [],
): string {
  """
  Generate an image from a text prompt and save it to `path`. To MODIFY existing
  images (edit / variation), pass their paths in `images`. Returns the saved path
  on success. Use this when the user asks to create, draw, edit, or restyle an image.

  @param prompt - What to generate, or how to modify the input images.
  @param path - Where to save the resulting image (e.g. "diagram.png").
  @param size - Optional size like "1024x1024".
  @param images - Optional input image paths to edit / vary.
  """
  // LLM-supplied paths resolve against the agent cwd, like every other
  // agent file tool.
  const inputs = map(images) as p {
    return applyAgentCwd(p)
  }
  const r = generateImage(prompt, size: size, images: inputs)
  if (isFailure(r)) {
    return "Image generation failed: ${r.error}"
  }
  // writeBinary rejects an absolute filename when dir is set (resolvePath
  // security check), so split path into (dir, name) and resolve the dir.
  let dir = dirname(path)
  if (!isAbsolute(dir)) {
    dir = applyAgentCwd(dir)
  }
  const w = writeBinary(basename(path), r.value.base64, dir)
  if (isFailure(w)) {
    return "Generated the image, but saving to ${path} failed: ${w.error}"
  }
  return "Saved image to ${path}"
}
```

- **Generate and modify are one tool** — a non-empty `images` list switches it to edit/variation.
- **The file write goes through the existing `writeBinary` interrupt gate**, so the user approves the write the same way they approve any agent file write (writes are not auto-approved by policy). Generation cost flows into the agent's existing cost tracking / `guard(cost:)`. Model defaults to `DEFAULT_IMAGE_MODEL`.
- **The write's Result is checked.** `writeBinary` can fail (bad directory, denied interrupt, `create-only` conflict); the tool must not tell the LLM "Saved image to …" when nothing was written — the LLM would relay that to the user as fact.
- **Both paths resolve against the agent cwd** (the dirname split on the write, `applyAgentCwd` on the edit inputs), matching `write.partial(useAgentCwd: true)` and friends. Without this, changing the agent cwd mid-session would send generated images to the process cwd while every other write goes to the agent cwd. The `images` inputs are read by smoltalk at request time, so they too must be absolute before the call. Note `writeBinary`/`readBinary` **reject absolute filenames** whenever `dir` is set (`resolvePath`'s escape check) — always pass `(basename, dir)` pairs, never a full path as the filename.
- Registered by adding `generateImageFile` to `mainAgentTools`, plus a sentence in `mainAgentSystemPrompt` telling the coordinator it can generate/edit images directly (otherwise it may route the request to the code agent to script it).

## Part B — Attachment detection

A helper module `lib/agents/agency-agent/lib/attachments.agency`, unit-testable without a terminal:

```ts
import { Attachment } from "std::thread"

// Returns the original text plus any auto-detected image/PDF attachments.
// Each attachment carries its display label in one record (no index-coupled
// parallel arrays); skipped files carry the reason for the visible 📎 line.
type DetectedAttachment = { attachment: Attachment, label: string }
type SkippedFile = { label: string, reason: string }
type DetectedContent = { attached: DetectedAttachment[], skipped: SkippedFile[] }

def detectAttachments(msg: string): DetectedContent
```

**Algorithm:**

1. **Tokenize** `msg` on whitespace, but first pull out shell-quoted spans (`'…'` / `"…"`) as single tokens so drag-dropped paths with spaces survive.
2. For each token, **normalize**: strip surrounding quotes, unescape `\ ` → space, trim trailing punctuation the user might have typed after a path (`,`, `.`, `?`, `:`), and expand a leading `~/` with `env("HOME")` (`std::system`) — drag-drop inserts absolute paths, but typed mentions are often `~/Desktop/foo.png`, and nothing downstream expands tildes.
3. **Resolve to absolute**: if not absolute, `applyAgentCwd(token)`. In the agent this always yields an absolute path — `setupSession` calls `setAgentCwd(cwd())` unconditionally.
4. **Dedupe** resolved paths — the same file mentioned twice attaches once.
5. **Keep** the token only if `stat(absPath)` (`std::shell` — one call yields existence, type, and size) reports `type == "file"` AND its extension is attachable:
   - `.png .jpg .jpeg .gif .webp` → image attachment
   - `.pdf` → file attachment
   - anything else (`.ts`, `.md`, …) → **not attached** (the agent has `read` for those).
6. **Skip over-limit files** (`size` > smoltalk's 20 MB per-file limit) with their own visible line (`📎 skipped huge.png (too large to attach)`). An over-limit attachment must never reach the `llm()` call: smoltalk turns it into a Failure of the **whole turn**, not a skipped attachment, so relying on the send-time limit would make merely *mentioning* a 25 MB PNG fail the user's message.
7. **Inline the bytes at attach time**: `readBinary(basename(absPath), dirname(absPath))` (a read — auto-approved by the default policy; the basename/dirname split is required because `readBinary` rejects an absolute filename when `dir` is set) and build the attachment as `image(b64, mimeType, base64: true)` or `file(b64, filename: basename(absPath), mimeType: mime, base64: true)`, mapping extension → MIME type. A failed read skips the file. See "Attachment lifetime" below for why we inline instead of passing the path.
8. Cap at **10** attachments per message (avoid accidental floods).
9. Return `{ attached: [{ attachment, label: "diagram.png" }, …], skipped: [{ label, reason }, …] }` (the message text itself is not threaded through — the caller already has it). Post-review revisions: the lexical stage (steps 1–2 + the extension gate) lives in TS (`lib/stdlib/mediaPathScan.ts`) for speed and quote-robustness (apostrophes in prose must not open quote spans); the stat uses `followSymlinks: true` so links to media attach; and files dropped by the 10-cap get a visible `skipped` entry like size/read failures.

### Attachment lifetime in the persistent thread (why step 7 inlines)

smoltalk resolves attachments **per request, on a copy of the config** (`prepareAttachments` in `baseClient`): the thread's stored message keeps whatever source the attachment was built with. The coordinator thread is `session: "main"` — persisted and resent on every turn, including across agent restarts. If the stored source is a *path*:

- **Deleting or moving the file poisons the session**: every subsequent turn re-reads the path at send time and fails attachment resolution until summarization eventually drops the old message.
- **Editing the file silently rewrites history**: an old user message would resend the file's *current* bytes, not what the user actually showed the model.
- **The read bypasses policy**: smoltalk reads the file directly, outside the `std::readBinary` interrupt gate, so a policy that restricts reads wouldn't see it.

Inlining base64 at attach time fixes all three. Cost: the persisted session file carries the base64 (bounded by the 20 MB × 10 caps per message; typical images are far smaller), which we accept for v1. The inlined image is also resent as input tokens on every subsequent turn until summarization drops the message — inherent to multimodal chat and visible in the agent's per-turn cost display.

### Follow-up: attachment eviction + re-view tools (v2 sketch, not in scope)

Dropping the attachment immediately after the first response is tempting but breaks the natural flow — "what's in this diagram?" → answer → "and the top-left box?" needs the image again, and vision follow-ups are the common case. The v2 shape:

- **Recency window**: keep attachment parts for the last N user turns (N ≈ 3), then replace the part in the stored thread with a text placeholder naming the attachment and how to get it back. This reuses the same placeholder rendering the summarizer fix needs, captures most follow-ups, and bounds per-turn resend cost — a strict improvement with no new tools.
- **Attachment store + agent tools** (the `readThread`/memory pattern): a runtime attachment registry keyed by content hash — per-execution state in the GlobalStore (never a TS module global), spilled to a session-scoped directory so placeholders in a persisted `session: "main"` thread survive restarts — plus `listAttachments()` / `viewAttachment(id)` agent tools. Belongs in `std::thread` (any Agency program with threads has this problem), with the agent tools as thin wrappers.
- **Blocker for `viewAttachment`**: tool results are text-only in the current LLM loop. Getting an image back to the model from a tool needs smoltalk support for image parts in tool results, and provider support is uneven (Anthropic's API takes image blocks in `tool_result`; OpenAI support varies by API). Until then, eviction placeholders should tell the model to ask the user to re-share the file.

**Wiring (`agent.agency`):**

- In `agentReplyVia`, before dispatching the coordinator turn, call `detectAttachments(expanded)`. If it found attachments:
  - print a visible line per attachment: `📎 attached diagram.png` (via the existing `color`/`pushMessage` helpers) — **never silent**;
  - pass the multimodal array `[text, ...attachments]` to `mainAgent`.
- **`mainAgent` signature widens** from `prompt: string` to `prompt: string | (string | Attachment)[]`, passed straight to `llm(prompt, …)`.

## Decisions (approved)

1. **Auto-detect** attachable files (no marker syntax, no per-file confirmation) — matches drag-drop UX; the visible `📎 attached` line is the safety valve.
2. **Media-only** (images + PDF). Code/text paths stay with the `read` tool.
3. **v1 scope: the main coordinator path** gets attachments. Routing a message *directly* to a subagent (`--agent code`) stays text-only for now.
4. **Image tool saves to disk + returns the path**; no generate-then-view-back loop in v1.
5. **Attachments are inlined as base64 at attach time** (not stored as paths in the persistent thread) — see "Attachment lifetime" above. Accepts session-file growth in exchange for a session that can't be poisoned by a later-deleted file, historically accurate thread content, and policy-gated reads.

## Non-goals (v1)

- Attachments on messages routed directly to a subagent (follow-up: widen the shared subagent `(userMsg, allowHandoff)` signature).
- A generate → view-the-result → refine agent loop.
- Attachment eviction and `listAttachments` / `viewAttachment` tools (see the v2 sketch above — partly blocked on image parts in tool results).
- Non-media file attachment (code/text) — `read` covers it.
- Any OS-level drag-drop event handling (not possible; path insertion covers it).

## Testing

- **`detectAttachments` units** (via a `.agency` execution test, no terminal; the test registers an approve handler for the `std::readBinary` interrupt that step 7 raises): a message with an existing `.png` path → one image attachment (base64 source) + label; a `.pdf` → one file attachment; a shell-quoted path with spaces → detected; an escaped-space path → detected; a `~/` path → expanded and detected; a **non-existent** path → ignored; a *directory* named `foo.png` → ignored (the `stat` type check); an over-limit file → skipped with a "too large" label; the same path mentioned twice → one attachment; a `.ts` path → ignored; a bare mention with no path → no attachments; the 10-cap; relative path resolves against the agent cwd.
- **`generateImageFile`** (agency-js or agency test with the deterministic image client): success saves a file (`readBinary` round-trips) and returns "Saved image to …"; generation failure returns the error string; a **failing write** (e.g. bad directory) returns the "saving … failed" string, not success; `images:` passes through to an edit call; with a non-default agent cwd set, the file lands relative to the *agent* cwd.
- **Turn integration** (`tests/agentTurn` harness): `agentReply("look at ./x.png")` with a real `x.png` present routes a multimodal array into the turn (assert via **statelog** — the deterministic mock can't inspect received messages; `redactPromptForLog` preserves the string-or-array shape with payloads redacted, so assert on the presence of an image part, not its content). Confirms the `mainAgent` widening end-to-end.

## Open implementation risks

1. **Path tokenization edge cases** — quoting/escaping from different terminals. Keep the normalizer small and covered by units; false negatives (a path we miss) are acceptable, false positives (attaching an unintended existing media file) are mitigated by the visible label + media-only + user-referenced-their-own-file.
2. **Relative-path resolution** — attachments must be resolved to absolute against the agent cwd before the bytes are read (step 3); assert in a unit with a set agent cwd.
3. **`mainAgent` widening** must not disturb the subagent paths (which stay `string`); keep the union change localized to the coordinator.
4. **Model modality** — the main-slot model may not accept image or PDF input (local models, text-only hosted models). smoltalk's `validateModalities` fails the whole `llm()` call, so auto-attaching to a text-only model turns the user's message into a failed turn. An ahead-of-time check **is** possible and exact: `validateModalities` is a thin wrapper over smoltalk's exported `modelSupportsInputModality(model, "image" | "pdf", modelData)`, which returns `true` / `false` / `undefined` (unknown model or no modality data → "don't gate"). Plan: expose it as a tri-state `std::llm.modelSupportsInput(model, modality)` (a one-line `lib/stdlib/llm.ts` bridge — `HostedModelInfo` doesn't carry modalities today), and in the wiring check the resolved main-slot model (`getResolvedSlots()`): on explicit `false`, skip the attachments with a visible `📎 skipped (model has no image input)` line; on `true`/`undefined`, attach optimistically — `undefined` covers local/custom models where the send-time gate also doesn't fire, so the residual failure mode is a provider error, handled like any other turn Failure.
5. **Summarization / thread readers dump base64 (CONFIRMED — prerequisite fix).** The summarizer flattens messages via `_contentToString` (`lib/stdlib/threads.ts:40`), which `JSON.stringify`s non-string content — a user message with an inlined base64 image part would dump megabytes of base64 into the summarize prompt (cost blowup / context overflow; eager summarize fails soft but still fires the call, and the lazy path repeats it). The same coercion backs the `getMessages` thread reader. This gap is *already reachable today* via `userMessage([...attachments])` + `summarize: true` — the multimodal work redacted statelog but not this reader path — but this feature makes it mainline. Prerequisite: render attachment parts as placeholders (e.g. `[image attachment]`, reusing the `redactAttachments` approach) in `_contentToString` before shipping attachments into the main thread.
