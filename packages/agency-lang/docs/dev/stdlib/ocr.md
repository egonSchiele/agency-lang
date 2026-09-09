# std::ocr and viewFile

Three ways to get text or an image in front of a model, and the line
between them.

## The three functions and their effects

| Function | Where the bytes go | Effect |
|---|---|---|
| `std::ocr.readText`, `readTextBlocks` | macOS Vision, on the machine | `std::ocr` |
| `std::ocr.readTextWithModel` | a model provider | `std::ocrCloud` |
| `std::thread.viewFile` | a model provider, as an attachment | `std::viewFile` |

Approving one never authorizes another. `std::viewFile` is separate from
`std::readImage` for the same reason `std::synthesizeSpeech` is separate
from `std::say`: reading bytes into a variable and sending them to a
provider are different permissions.

The short names are the local ones. A model choosing among tools reaches
for the shortest name, so the shortest must be the one that keeps the file
on the machine.

## Before the interrupt and after it

Every function here follows the split `contained-files.md` describes.
Before the interrupt the wrapper resolves the caller's spelling with
`_realTarget`, checks only the name and the stat, and puts the resolved
spelling in the payload. No byte is read. After approval the helper
re-validates that exact spelling with `fixedPath`, which refuses a
symlink that appeared while the prompt was pending, and reads through a
validated descriptor.

What happens to the bytes then depends on who reads them:

- Vision reads a file by pathname inside `osascript`. The helper reads the
  approved file with `readBytes`, writes those bytes to a temp file it
  created with `create-only`, hands that temp path to the script, and
  removes it afterwards. The subprocess never sees the original path, so
  there is no window between validation and its read. This is the `say`
  pattern from `speech.ts`.
- The reply pipeline (`viewFile`) and the llm message builder
  (`readTextWithModel`) read the file themselves at send time. They get
  the path that `approvedFilePath` in `lib/stdlib/approvedPath.ts`
  returns after `fixedPath`, a regular-file check, and a descriptor open.
  The check-then-open window that remains is the one
  `contained-files.md` assigns to process containment, and it is the same
  window `transcribe` has.
- `tesseract-local` raises no interrupt. It reads through `wholePath` and
  `readBytes` and hands the worker bytes.

## The osascript bridge

The JavaScript for Automation program is `lib/stdlib/visionOcr.jxa`. The
makefile copies it into `dist/lib/stdlib/` beside `ocr.js`, which locates
it relative to its own URL and runs
`osascript -l JavaScript visionOcr.jxa <tempCopy> <language> <fast>`.
The image path is model-supplied text, so it arrives as `argv[0]` and is
never spliced into the script.

The helper takes the process runner as a parameter, so `ocr.test.ts` runs
without spawning anything. The real script is exercised only by
`tests/agency/ocr.agency`, which carries `skipUnlessPlatform: "darwin"`.

## The y flip

Vision reports `boundingBox` with the origin at the bottom left. The
script prints `y = 1 - (visionY + height)` so `TextBlock.box` has the
origin at the top left like `screenshot` regions and drawing libraries.

## Why the local functions never fall back

A non-macOS call returns a Failure naming `readTextWithModel` and
`@agency-lang/tesseract-local`. It does not call `readTextWithModel`
itself, because the user approved `std::ocr`, a local read, and an upload
under that approval would be a different action.

## Why viewFile says "queued"

`viewFile` returns `Queued <name> for attachment.` and not "attached".
The reply pipeline (`lib/runtime/replyAttachments.ts`) may still skip the
attachment for a model with no image input or an over-full call, and it
appends its own marker to the tool result saying so. A return string that
claimed delivery would contradict that marker. `viewFile` pre-checks the
two things it can know before the interrupt, existence and size, by a
stat through `contained.ts`, and refuses to run outside a tool call
because `attachToReply` silently drops there.

## Files

- `stdlib/ocr.agency`, `lib/stdlib/ocr.ts`, `lib/stdlib/visionOcr.jxa`, `lib/stdlib/ocr.test.ts`
- `lib/stdlib/approvedPath.ts`, the post-approval validation shared by `viewFile` and `readTextWithModel`
- `stdlib/thread.agency` (`viewFile`), `lib/stdlib/thread.ts` (`_viewFilePrecheck`, `_insideToolCall`)
- `lib/agents/agency-agent/lib/images.agency` (`viewImageFile`, the agent-cwd wrapper)
- `tests/agency/ocr.agency`, `tests/agency/attach-to-reply.agency`, `tests/agency-js/ocr-cloud/`
- `packages/tesseract-local/`
