# Review: OCR in the Agency standard library

Reviewer: Claude. Date: 2026-09-08.
Spec: `2026-09-08-ocr-design.md`.

Verdict: the shape is right. `viewFile` is a small, useful addition, the
local-versus-cloud effect split matches how `std::speech` already draws the
line, and keeping Tesseract in its own package keeps the language free of the
dependency. Most code claims I checked hold. Five things need a decision
before implementation. Three are safety or correctness gaps in `viewFile` and
the local backend, one is a test plan that cannot run as written, and one is a
naming choice that points a model at the cloud by default. The rest are
smaller.

## What I verified

- `attachToReply`, `image`, and `file` live in `stdlib/thread.agency` with the
  signatures the spec relies on. `image()` returns `Attachment`, so
  `attachToReply(image(real))` type-checks.
- `generateImageFile` in `lib/agents/agency-agent/lib/images.agency:60` is the
  only stdlib caller of `attachToReply` today, as the spec says.
- `harvestReplyAttachments` in `lib/runtime/replyAttachments.ts` gates on
  modality, existence, `MAX_REPLY_ATTACHMENT_BYTES`, and
  `MAX_REPLY_ATTACHMENTS_PER_CALL`, and turns a gated attachment into a marker
  string rather than a failure. All four gates are real.
- `std::readImage` is declared in `stdlib/index.agency:47` with
  `@alwaysUnder(dir)` and a `{dir, filename}` payload. The proposed
  `std::viewFile` and `std::ocr` payloads copy that shape, which is right.
- `std::transcribe` in `stdlib/speech.agency:43` carries
  `{requestedProvider, configuredModel, filepath}` and the comment above it
  gives the same reason the spec gives for `std::ocrCloud`. `transcribe`
  resolves with `_realTarget` before raising, so the containment pattern the
  spec copies exists.
- `thread(label: "...")` is used throughout `stdlib/agents/*.agency` and the
  coordinator, and the coordinator assigns to an outer variable from inside
  the block (`first = false` in `mainAgent`). The `readText` body shape is
  valid.
- No runtime code raises `std::readImage` when an `image(path)` reaches
  `llm()`. So the `std::ocrCloud` interrupt is the only gate on `readText`,
  and the `std::viewFile` interrupt is the only gate on `viewFile`. The spec
  is right to add both.
- `packages/whisper-local` has the layout the spec copies, and its
  `models.lock.json` pins every download by URL and sha256.

## Must fix

### 1. `viewFile` step 2 reads bytes before the interrupt

Step 2 classifies the file "by extension and content type". Reading a content
type means opening the file and sniffing its first bytes. Step 3 raises the
interrupt. That order lets an agent probe any readable file on the machine
before anyone approves anything. The probe leaks little, but the rule in
`docs/dev/stdlib/contained-files.md` is that nothing reads the bytes before
the payload is approved, and this breaks it.

Pick one of these and say so in the spec:

- Classify by extension only. Refuse anything that is not `.png`, `.jpg`,
  `.jpeg`, `.gif`, `.webp`, or `.pdf` before raising. The reply pipeline
  infers the MIME type when it sends the bytes anyway, so a sniff here adds
  nothing the model will see.
- Raise first, sniff after. Then a rejected interrupt never touches the file.

The first is simpler and matches how `image()` works today.

### 2. The confirmation string can lie to the model

`viewFile` returns `Attached invoice.png. It appears in the message right
after this result.` There are three cases where that sentence is false:

- `_attachToReply` in `lib/stdlib/thread.ts:246` drops the attachment when it
  is called outside a tool invocation and only logs to statelog. `viewFile`
  called from ordinary Agency code returns "Attached" and attaches nothing.
- The harvest gate skips the file because it is over the size cap or the
  model has no image input. The tool result then reads "Attached invoice.png"
  followed by the pipeline's "skipped:" marker. The model gets two claims
  that contradict each other.
- The eleventh `viewFile` in one `llm()` call is silently over the
  per-call limit.

The spec says `viewFile` "does not duplicate these checks. It documents
them." Documentation does not fix a tool result that says two things. Either:

- Reword the return so it promises nothing the pipeline may undo. For
  example: `Queued invoice.png for attachment.` The marker already says what
  happened next.
- Or check size and modality before raising, using
  `modelSupportsInputModality` and a stat on the resolved path, and return a
  Failure that names the reason. This is a stat, not a read, so it is
  allowed before the interrupt. It gives the model one clear answer instead
  of two.

The second is better for the model. Either way, say what `viewFile` returns
when it is not inside a tool call. A Failure is the honest answer there.

### 3. The osascript invocation contradicts two existing callers

The spec pipes the script into `osascript -l JavaScript -` on stdin and
passes the image path as an argument. Both existing callers,
`lib/stdlib/appleNotes.ts:56` and `lib/stdlib/builtins.ts:287`, pass the
script with `-e` and carry a comment saying that a bare `-` is passed through
as argv item 1 and shifts every real argument by one. The spec and the
comments cannot both be right about the same flag. The prototype may have
worked because the script read `argv[1]` instead of `argv[0]`, or because it
did not read argv at all.

Use `-e` like the other two callers, or record in `docs/dev/stdlib/ocr.md`
why stdin is needed for a JXA script and how the argv shift is handled. The
spec's reason for embedding the script as a string, so that nothing on disk
can be rewritten, holds for `-e` too. The important property, that the path
arrives as argv and is never spliced into the script source, is what both
existing callers protect. Keep it.

One more thing to state: the script must not `ObjC.import` anything beyond
`Vision` and `Foundation`, and the runner must refuse to start on any
platform other than darwin before it touches `execFile`, the way
`runNotesScript` does.

### 4. The Vision test cannot skip on platform

The test plan says the `tests/agency/` case "skips on any platform that is
not macOS". The runner in `lib/cli/test.ts:887` understands `skip`,
`skipOnCI`, and `skipReason`. There is no platform skip. Every CI job in
`.github/workflows/` runs on Ubuntu, so as written this test either fails CI
or is marked `skipOnCI` and never runs anywhere but a developer's Mac.

Decide one of:

- Add a `skipUnlessPlatform: "darwin"` field to the test JSON. Small change
  to `test.ts`, and it is honest in the report.
- Use `skipOnCI` and add the Vision cases to
  `docs/dev/contributing/untestable-builtins.md`, which is what `say` and
  `screenshot` do today.

The first is better because the test still runs on every Mac that runs the
suite. Either way, the spec should say which.

### 5. The unqualified name goes to the cloud

`readText` sends the file to a model provider. `readTextLocal` keeps it on
the machine. Every Agency function is a tool, and a model choosing among
three tools that share a prefix will reach for the shortest one. The
`std::speech` precedent the spec leans on does the opposite: the short name
`say` is local and the cloud function carries the longer name
`synthesizeSpeech`.

Two options:

- Swap the marking. `readText` is local and returns blocks. `readTextCloud`
  sends to a model.
- Drop the shared prefix. `recognizeText` for local, `readTextWithModel` for
  cloud. The verb difference also tells a reader what the spec's own module
  note says: Vision recognizes, a model generates.

Related: `readTextLocalSimple` is a name that describes an implementation
detail. The spec's argument for it is right. A dense page returns a large
JSON array that crowds the model's context. That argument says the compact
form should be the default, and the block form should be the marked one:
`readText` returns a string, `readTextBlocks` returns `TextBlock[]`. That
also matches what the Tesseract package returns.

## Should fix

### Tesseract language data has no lock file

The spec says language data "downloads on first use into
`~/.agency/models/tesseract/`" and cites `whisper-local`. `whisper-local`
does not download on trust. Its `models.lock.json` pins each file to a URL
and a sha256, and `ensureModel.test.ts` covers the verification. The default
`tesseract.js` language path is a CDN. A package that downloads an unpinned
blob on first use is the case `docs/dev/contributing/supply-chain.md` exists
to prevent.

Add a `models.lock.json` with the traineddata URL and hash per language, and
verify on download. Say which `tessdata` variant is pinned (`tessdata_fast`
is the `tesseract.js` default) and that the worker and core files load from
`node_modules`, not the network.

### The Tesseract package has no interrupt

`whisper-local` has no interrupt either, so the spec is consistent with its
model. But a stdlib-adjacent package that reads a file the model names and
returns its contents should at least resolve the path through
`_realTarget`. `std::ocr` does this for both backends. Say whether the
package does too, and if not, say why the package is different.

### `TextBlock.box` origin

The box origin is the bottom left, which is what Vision returns and what the
spec says. Every other coordinate a caller is likely to hold, from
`screenshot` regions to anything that draws on an image, has its origin at
the top left. Either flip `y` in the script so the module returns top-left
coordinates, or put the bottom-left origin in the `TextBlock` doc comment
with a one-line formula for flipping it. Flipping in the script is one
subtraction and saves every caller from the same bug.

### The failure of a non-Mac local call

The spec is right not to fall back to the cloud. The Failure message should
name the alternatives so a model that receives it knows what to do next:
`readText` for a model provider, or `@agency-lang/tesseract-local` for
offline. Otherwise the model retries the same call.

### `readText` argument validation

`transcribe` throws on an empty `model` before it raises, so an invalid call
never prompts. The spec's `readText` takes `model: string = ""`. Say whether
an empty model means "the configured default" and, if so, what
`configuredModel` in the `std::ocrCloud` payload carries in that case. The
approver needs to see a real model name, not `""`.

## Minor

- The spec says `_realTarget` is "from `contained.ts`". The import spelling
  in `speech.agency:19` is `agency-lang/stdlib-lib/contained.js`. Worth
  writing out, since the doc for the module says stdlib TS lives under
  `lib/stdlib/` and the subpath maps there.
- `viewFile` is described as living "next to `attachToReply`". `thread.agency`
  declares no effects today. Adding `effect std::viewFile` there is fine, but
  the spec should say it goes there and not in `index.agency` beside
  `std::readImage`, so the implementer does not have to guess.
- The `std::ocr` docs page and the `docs/dev/stdlib/ocr.md` entry both need
  adding to the `agency-stdlib-docs` skill and the `CLAUDE.md` index. The spec
  lists this. Good.
- "Vision reports 30 supported recognition languages" is a prototype
  measurement. It changes with the macOS version. Leave it out of the module
  doc, or phrase it as "the list Vision reports on the running machine".
- The Out of scope section says PDF for the cloud backend "hands the file to
  the model with `file()`". That is one `llm()` call and no new machinery.
  If it is out of scope only for symmetry with the local backend, say so.
  Otherwise it is cheap enough to ship in version one.
- Both `readTextLocal` functions and `readText` take a path but the spec
  does not say whether the path is resolved relative to the process cwd or,
  when running inside `agency agent`, the agent cwd. `generateImageFile` uses
  `applyAgentCwd` for this. `viewFile` will be called from the agent most
  often, so it should say which.

## Questions the spec answers well

- Why `viewFile` exists at all, with the two-round `image()` then
  `attachToReply` awkwardness spelled out.
- Why local OCR never falls back to the cloud. The sentence about an
  approval that named a local read is the right reason, and it belongs in
  the module doc comment.
- Why the cloud path needs a `thread` block. The cost argument is concrete.
- The note that a model generates text rather than recognizing it. That
  belongs in the docstring of the cloud function, where the model choosing
  the tool will see it, and not only in the module doc.
