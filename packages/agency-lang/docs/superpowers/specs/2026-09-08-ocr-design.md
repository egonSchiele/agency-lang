# OCR in the Agency standard library

## What this adds

1. `viewFile` in `std::thread`. A tool the model can call to put an image or PDF in front of
   itself.
2. A new `std::ocr` module with two backends: macOS Vision (local) and a vision model (cloud).
3. A new workspace package, `@agency-lang/tesseract-local`, for offline OCR that works everywhere.
4. A `skipUnlessPlatform` field for Agency test files, so a test that needs macOS is skipped
   honestly on Linux instead of failing or being hidden behind `skipOnCI`.

The `agency-lang` package gains no new dependencies. The local macOS backend runs through a
script we ship as a string constant. Tesseract lives in its own package, where its dependency
does not reach the language.

## Background: why `viewFile` is worth adding

Agency already routes images to a model. A tool calls `std::thread.attachToReply(image(path))`
during its invocation, and the runtime injects the image as a user message after the tool round
completes. `docs/dev/agents/reply-attachments.md` describes the mechanism. Today the only
caller is `generateImageFile` in `lib/agents/agency-agent/lib/images.agency`.

Every Agency function is a tool, so a model can already call `attachToReply` if a caller puts it
in an `llm()` call's `tools:` array. Doing so is awkward. `attachToReply` takes an `Attachment`
value, not a path. A model would have to call `image("x.png")` first, receive the
`{type: "image", source: {kind: "path", ...}}` object serialized into a tool result, and pass that
structure back on a second round.

`viewFile` collapses that into one call that takes a string.

## `viewFile`

```
export def viewFile(path: string): Result<string>
```

It lives in `stdlib/thread.agency`, next to `attachToReply`, `image`, and `file`. The effect is
declared in the same file, right above the function. `thread.agency` declares no effects today.
This is the first.

Behaviour, in order:

1. Resolve `path` through `_realTarget` (imported from `agency-lang/stdlib-lib/contained.js`) to
   get the real spelling. A failure here is returned as-is.
2. Classify the file by extension only. The accepted extensions are the keys of `MIME_TYPES` in
   `lib/stdlib/mediaPathScan.ts`: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, and `.pdf`. Anything
   else returns a Failure naming the extension and listing the accepted ones. No byte of the
   file is read before the interrupt. The reply pipeline infers the MIME type when it sends the
   bytes, so sniffing here would add nothing the model sees.
3. Stat the resolved path through `contained.ts` (`wholePath` then `stat`). A missing file or a
   file over `MAX_REPLY_ATTACHMENT_BYTES` (20 MB, from `lib/config.ts`) returns a Failure that
   names the reason. A stat is a probe, not a read, and it happens after resolution, so it is
   allowed before the interrupt.
4. Refuse to run outside a tool invocation. `_attachToReply` in `lib/stdlib/thread.ts` drops an
   attachment queued outside a tool call and only logs to statelog. `viewFile` checks
   `isInsideToolCall()` through a new TS helper and returns a Failure: `viewFile only works when
   called as a tool inside an llm() call.` A tool result that said "queued" while nothing was
   queued would mislead the model.
5. Raise the interrupt (below).
6. After approval, re-validate the exact spelling from step 1 with `approvedFilePath` (below).
   A refusal is returned as a Failure.
7. Call `attachToReply(image(approved))` for an image extension or `attachToReply(file(approved))`
   for `.pdf`.
8. Return `Queued invoice.png for attachment.` The reply pipeline appends its own marker to the
   tool result, and that marker is the authority on whether the file was delivered.

### Why the return string promises nothing

`harvestReplyAttachments` in `lib/runtime/replyAttachments.ts` gates every attachment on the
model's input modality, whether the file exists, the 20 MB size cap, and a limit of
`MAX_REPLY_ATTACHMENTS_PER_CALL` (10) attachments per `llm()` call. A gated attachment becomes a
`skipped:` marker in the tool result rather than a failure.

`viewFile` pre-checks existence and size because both are cheap and both give the model one
clear Failure instead of a tool result that says two things. It does not pre-check modality or
the per-call count. The model of the current `llm()` call is a per-call value inside
`runPrompt` and is not reachable from a stdlib helper. The count is only known at harvest.
For those two cases the marker is the answer, and a return string that said "attached" would
contradict it. "Queued" is true in every case.

### The effect

```
@alwaysUnder(dir)
effect std::viewFile { dir: string, filename: string }
```

`std::viewFile` is a distinct effect from `std::readImage`. Approving `std::readImage` authorizes
reading an image file into a variable. Approving `std::viewFile` sends the file's bytes to a model
provider. `stdlib/speech.agency` already draws this line between local `std::say` and cloud
`std::synthesizeSpeech`, and the reasoning is the same here.

### Containment: before the interrupt and after it

`docs/dev/stdlib/contained-files.md` splits every approved file operation into two halves, and
this spec follows it everywhere a file is consumed.

**Before the interrupt** the wrapper resolves the caller's spelling with `_realTarget`, checks only
the name and the stat, and puts the resolved spelling in the payload. No byte is read.

**After approval** the helper re-validates that exact spelling with `fixedPath`, which refuses a
symlink that appeared anywhere in the path while the prompt was pending, and opens the file
through a validated descriptor. Resolving the string again with `wholePath` or `_realTarget` after
approval would follow a link introduced in the meantime, so the post-approval side never does
that. This is what `_transcribe` in `lib/stdlib/speech.ts` does after `std::transcribe`.

For `viewFile` and `readTextWithModel` the bytes are read later by someone else: the reply
pipeline at harvest, and the llm message builder at send. Both get the path from a shared helper,
`approvedFilePath(spelling)` in `lib/stdlib/approvedPath.ts`, which runs `fixedPath`, requires a
regular file, opens and closes a validated descriptor, and returns the resolved path. What remains
is the check-then-open window that `contained-files.md` assigns to process containment. It is the
same window `transcribe` has today.

### Paths from the agent

When `viewFile` runs inside `agency agent`, the model supplies the path. The agent's own tools
resolve a relative path against the agent cwd with `applyAgentCwd`. `viewFile` is a stdlib
function and does not know about the agent cwd. The agent adds `viewFile` to its tool list
through a thin wrapper in `lib/agents/agency-agent/lib/images.agency` that applies the agent cwd
first, the way `generateImageFile` does. That wrapper is part of this work.

## `std::ocr`

A new module at `stdlib/ocr.agency`, with a TypeScript helper at `lib/stdlib/ocr.ts`.

### The functions

```
readText(path: string, language: string = "", fast: boolean = false): Result<string>
readTextBlocks(path: string, language: string = "", fast: boolean = false): Result<TextBlock[]>
readTextWithModel(path: string, model: string = "", provider: string = "", prompt: string = ""): Result<string>
```

Naming. The two local functions carry the short names. The cloud function carries the long one.
A model choosing among tools that share a prefix reaches for the shortest, so the shortest must be
the one that keeps the file on the machine. `std::speech` does the same: `say` is local,
`synthesizeSpeech` is cloud.

`readText` returns the recognized lines joined with newlines. It is the default because every
Agency function is a tool, and a model that calls the block form on a dense page receives a large
JSON array of boxes and confidences that crowds out its context. `readTextBlocks` is for callers
who need positions.

`TextBlock` and its box are two named types, because the codebase keeps nested objects out of
type definitions:

```
export type BoundingBox = { x: number, y: number, width: number, height: number }

export type TextBlock = {
  text: string,
  confidence: number,
  box: BoundingBox,
}
```

On the TypeScript side both are zod schemas, and the script's output is parsed with them
instead of a hand-written check.

Box coordinates are normalized to the range 0 to 1. The origin is the **top left** of the image,
so `y` grows downward, matching `screenshot` regions and every image-drawing library. Vision
reports bottom-left coordinates. The script flips `y` before printing: `y = 1 - (visionY +
height)`. The `TextBlock` doc comment states the origin.

Version one handles images. PDFs are follow-up work.

### The local backend

`readText` and `readTextBlocks` run macOS's Vision framework. Neither one uses the network.

The implementation calls `osascript -l JavaScript visionOcr.jxa <path> <language> <fast>` through
`execFile`. The script is a JavaScript for Automation program in `lib/stdlib/visionOcr.jxa`,
copied into `dist/lib/stdlib/` by the makefile and located by `ocr.ts` relative to its own URL. It
imports `Foundation` and `Vision` through the ObjC bridge, runs a `VNRecognizeTextRequest` on the
image at `argv[0]`, and prints one JSON array of blocks to stdout.

The path and every other argument arrive as argv. Nothing is spliced into the script source. The
path is model-supplied text, and escaping only holds for as long as the escape function keeps up
with every metacharacter. This is the rule the existing `osascript` callers
(`lib/stdlib/appleNotes.ts` and `lib/stdlib/builtins.ts`) follow.

The helper refuses to start on any platform other than darwin before it touches `execFile`,
the way `runNotesScript` does.

`osascript` opens a pathname itself, so it cannot read through a validated descriptor. The helper
does not hand it the approved path. After approval it reads the file with `fixedPath` and
`readBytes`, writes those bytes to a temp file it creates with `create-only` in the OS temp
directory, passes that temp path to the script, and removes the temp file afterwards, cleanup
included on failure. The subprocess only ever sees a file this call wrote from validated bytes,
so there is no window between validation and its read. This is how `say` in `lib/stdlib/speech.ts`
receives its text. The cost is one copy of an image.

A prototype confirmed the path. On a 700x160 test image it returned both lines of text with
confidence 1.0 and correct bounding boxes, in 0.55 seconds.

Parameters:

- `language` selects a recognition language. An empty string lets Vision choose. The list of
  languages is whatever Vision reports on the running machine and changes with the macOS version,
  so the docs do not enumerate it.
- `fast` selects Vision's fast recognition level. The default is the accurate level.

On a machine that is not macOS, both functions return this Failure:

```
Vision OCR requires macOS. Use readTextWithModel to send the image to a model provider, or install @agency-lang/tesseract-local for offline OCR on any platform.
```

They do not fall back to `readTextWithModel`. A silent fallback would send the file to a model
provider under an approval that named a local read, which defeats the reason to call a local
function. The Failure names the alternatives so a model that receives it knows what to do next
instead of retrying the same call.

### The cloud backend

`readTextWithModel` sends the image to whichever model the caller names, or the run's default
model when `model` is empty, and asks for the text. This needs no change to smoltalk. smoltalk
exports `transcribe` / `registerTranscriptionProvider` and `speak` / `registerSpeechProvider`, and
nothing for OCR, but the multimodal message path already carries images. `readTextWithModel` uses
that path.

The body is close to pure Agency. `approved` is the path `approvedFilePath` returned after the
interrupt:

```
let text = ""
thread(label: "ocr") {
  const recognized: string = llm(
    ["Transcribe all text in this image...", image(approved)],
    model: model,
    provider: provider,
  )
  text = recognized
}
```

The variable is declared outside the block and assigned inside it, the way `mainAgent` in
`lib/agents/agency-agent/brains/coordinator/coordinator.agency` assigns `first = false` inside
its `thread` block.

The `thread` block matters. Without it the OCR prompt and the image accumulate in the caller's
conversation, and the caller pays for them on every later turn.

`prompt` lets the caller add an instruction, for example naming the jargon or field names to
expect. `std::speech.transcribe` takes a `prompt` parameter for the same purpose.

The docstring of `readTextWithModel` carries this warning, because the model choosing the tool
reads the docstring and not the module doc: a model that reads an image generates text rather than
recognizing it, so it can produce plausible content that is not on the page. Vision and Tesseract
produce garbage when they fail, which is easier to detect. Callers who need to trust the output
should prefer `readText` or check the result against the image.

### The effects

```
@alwaysUnder(dir)
effect std::ocr { dir: string, filename: string }

effect std::ocrCloud {
  requestedProvider: string,
  configuredModel: string,
  dir: string,
  filename: string,
}
```

`std::ocr` covers the two local functions. The file never leaves the machine.

`std::ocrCloud` covers `readTextWithModel`. It names the requested provider and the configured
model, not a resolved destination, because a custom LLM client can route the call anywhere.
`std::transcribe` in `stdlib/speech.agency` uses the same payload shape for the same reason. When
`model` is empty, `configuredModel` carries the literal string `default`, and the interrupt message
says the image goes to the run's default model. Agency code has no accessor for the resolved default
model name, and inventing one is out of scope here.

Approving one never authorizes the other.

### Containment

Both backends resolve the path through `_realTarget` before raising, and the interrupt payload
carries the real spelling. After approval both re-validate that spelling with `fixedPath`. The
local backend then reads the bytes through `readBytes` and gives `osascript` a temp copy. The cloud
backend gives `image()` the path `approvedFilePath` returns. See the `viewFile` containment
section above for why the post-approval side never resolves the string again.

## `packages/tesseract-local`

A new workspace package, `@agency-lang/tesseract-local`, modeled on `packages/whisper-local`.

```
readText(filepath: string, language: string = "eng"): string
```

It runs `tesseract.js`, which is WebAssembly. There is no cmake step, no vendored C++, and no
native addon, so the package installs on macOS, Linux, and Windows without a compiler.
`whisper-local` requires cmake, a C++17 compiler, and ffmpeg on PATH. This package requires none of
that.

`tesseract.js` is a dependency of this package, pinned to an exact version that is at least seven
days old, which is what the workspace's `minimumReleaseAge` requires. It is not a dependency of
`agency-lang`. The worker and the WebAssembly core load from `node_modules`. Only language data is
fetched.

### Language data is pinned

`tesseract.js` defaults to fetching language data from a CDN with no verification. This package
does not use that path. It ships a `models.lock.json` in the same shape as `whisper-local`'s: one
entry per language, each with a URL pinned to a `tessdata_fast` commit on GitHub, a sha256, and a
size in bytes. `ensureLanguage(lang)` downloads the file into `~/.agency/models/tesseract/`
(override: `AGENCY_TESSERACT_MODELS_DIR`), verifies the hash, and refuses a mismatch. The download
code is a copy of `whisper-local`'s `downloadModel`, including the HTTPS-only rule and the
redirect re-check.

Version one pins `eng` only. Adding a language is a lockfile row plus a name in `KNOWN_LANGUAGES`.
A `scripts/generate-lockfile.sh` computes the rows the way `whisper-local`'s script does.

The worker is created with `langPath` pointing at that directory, `gzip: false`, and
`cacheMethod: "none"`, so `tesseract.js` reads the verified file and never fetches.

### Containment

`readText` reads the image through `wholePath` and `readBytes` from
`agency-lang/stdlib-lib/contained.js`, a validated descriptor that refuses a symlink at the final
name and anything that is not a regular file, and hands the worker the bytes rather than a path.
The package raises no interrupt, so there is no pre/post split. `whisper-local` raises none
either, and the file's bytes stay on the machine. A caller who wants approval wraps the call in a
handler.

Layout follows `whisper-local`:

- `index.agency` — the Agency wrapper, with the module doc comment and installation notes.
- `src/ocr.ts` — the implementation.
- `src/languageManager.ts` — the lockfile loader, `ensureLanguage`, and the download.
- `src/types.ts` — `KNOWN_LANGUAGES`, `LockfileEntry`, `Lockfile`.
- `models.lock.json` — the pinned language data.
- `scripts/generate-lockfile.sh` — computes lockfile rows.
- `package.json` — `"agency": "./index.agency"`, `agency-lang` as a peer dependency.
- `tests/` — vitest, with a committed fixture image.

## `skipUnlessPlatform` for Agency tests

The test runner in `lib/cli/test.ts` honours `skip`, `skipOnCI`, and `skipReason`, at file level
and per case. It has no way to skip on platform. Every CI job in `.github/workflows/` runs on
Ubuntu, so a macOS-only test today either fails CI or is marked `skipOnCI` and never runs anywhere
but a developer's Mac.

This adds `skipUnlessPlatform` at both levels. The value is a `process.platform` string:
`"darwin"`, `"linux"`, or `"win32"`. When it is set and does not match, the runner reports the
file or case as skipped with the message `Skipped: needs darwin`. The field is added to the zod
schema in `lib/testFormat/schema.ts`, to the two skip checks in `lib/cli/test.ts`, and to the
mirror in `lib/cli/precompile.ts`. The Vision test uses it, and the test still runs on every Mac
that runs the suite.

## Testing

`lib/cli/test.ts` and `lib/testFormat/schema.ts` get vitest cases for `skipUnlessPlatform`: a
matching platform runs, a non-matching platform skips, and the schema accepts the field.

Local OCR needs no LLM call, so it is an Agency execution test in `tests/agency/ocr.agency`. The
test reads a small PNG fixture with known text, committed alongside it, and asserts on the
recognized string and on the block count. Its `.test.json` sets `skipUnlessPlatform: "darwin"`.

`lib/stdlib/ocr.test.ts` covers the paths that do not touch Vision. The helper takes the process
runner as an injected parameter so the tests never spawn `osascript`: a platform that is not
darwin, a missing file after approval, a symlink at the approved spelling, a runner that rejects
(non-zero exit), a runner whose stdout does not parse as JSON, and the temp-copy contract: the
runner receives a temp path with the original extension and the original bytes, never the
approved path, and the temp file is gone afterwards on success and on failure.

`lib/stdlib/approvedPath.test.ts` covers the shared post-approval helper: a regular file passes, a
missing file, a directory, a symlink at the final name, and a symlink in a parent directory are
all refused.

`viewFile` gets cases in `tests/agency/attach-to-reply.agency`, which already has the mock LLM
and the conversation reader: the confirmation string and the injected image for a `.png`, a
Failure for a `.txt`, a Failure for a missing file, and a Failure when called outside a tool.

`readTextWithModel` gets an agency-js test under `tests/agency-js/ocr-cloud/` with a stubbed LLM
client, in the shape of `tests/agency-js/llm-fork-scoped/test.js`. It asserts that the stub was
called once, that its message list contains an image part, and that the caller's thread has no OCR
messages afterwards. It makes no real model call.

The Tesseract package gets its own vitest suite: the lockfile parses, `ensureLanguage` refuses a
hash mismatch against a local http server, and `readText` on a committed fixture image returns the
known text. The last case downloads real language data and is marked `skipOnCI`.

## Build and documentation

- Run `make` after changing stdlib files.
- Add `docs/site/stdlib/ocr.md` to the `/stdlib/` sidebar in `docs/site/.vitepress/config.mts`,
  alphabetically between `notes` and `object`.
- Write `docs/dev/stdlib/ocr.md` covering the before/after-approval split and where each function
  reads its bytes, the osascript bridge and the temp copy, why the script is embedded rather than
  shipped as a file, the `y` flip, the two effects, and why `viewFile` says "queued".
- Add that doc to the index in `packages/agency-lang/CLAUDE.md` and to the `agency-stdlib-docs`
  skill at `.claude/skills/agency-stdlib-docs/SKILL.md`. The two lists are kept in step.
- Document `skipUnlessPlatform` in `docs/misc/TESTING.md` beside `skipOnCI`.
- Run `pnpm run fmt:ts` before committing. CI fails on unformatted TypeScript.

## Out of scope

- PDF input to `std::ocr`. The local path would render pages through PDFKit. The cloud path would
  hand the file to the model with `file()`, which is one `llm()` call, but the two backends would
  then accept different inputs, and a model choosing between them should not have to know that.
  Both land together in a follow-up. This does not affect `viewFile`, which attaches a PDF
  without recognizing anything.
- A dedicated OCR provider registry in smoltalk. Calling Mistral OCR, Google Document AI, or AWS
  Textract needs one, because those are not chat completions. That work spans two repositories and
  adds a credential chain.
- Structured output beyond text blocks: tables, key-value pairs, and reading order.
- An Agency accessor for the run's resolved default model name.
