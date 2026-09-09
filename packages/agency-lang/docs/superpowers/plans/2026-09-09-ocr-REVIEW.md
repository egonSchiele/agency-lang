# OCR Implementation Plan Review

## Verdict

The plan is comprehensive, but it should not be implemented unchanged.

## Critical issue: preserve the approved file identity

The largest remaining safety problem is the path flow across an interrupt.

The plan generally proposes:

```text
user path → _realTarget() → interrupt → helper reads resolved string
```

That is insufficient if the post-approval helper resolves the string again with `wholePath()` or `_realTarget()`. A filesystem entry could change while approval is pending, especially through a symlink swap.

The required containment pattern is:

```text
Before approval                          After approval
wholePath(path)                          fixedPath(approvedPath)
      │                                         │
      ├─ real parent + final name               ├─ refuse new symlinks
      └─ resolved spelling in interrupt         └─ descriptor-validated read
```

Concretely:

- Before the interrupt, use the appropriate `contained.ts` operation to establish the resolved spelling.
- Put that resolved spelling in the interrupt payload.
- Keep that exact spelling for execution after approval.
- After approval, validate it with `fixedPath()` or `fixedRoot()`.
- Read bytes through `contained.ts`’s descriptor-backed functions rather than handing a newly resolved path directly to another program.

This applies to:

- macOS Vision OCR
- `viewFile`
- `tesseract-local`
- any cloud OCR upload

### Why `_realTarget()` alone is not enough

`_realTarget()` is intended to generate the real spelling used in an interrupt payload. It does not, by itself, provide the complete post-approval read guarantee.

If a helper subsequently calls `wholePath()` again, it can follow a symlink introduced after approval. Existing filesystem wrappers avoid this with the complementary APIs:

- Pre-interrupt: `wholePath()` / `_realTarget()`
- Post-interrupt: `fixedPath()` / `fixedRoot()`
- Actual read: `readBytes()` or `readStream()` through a validated descriptor

The OCR plan needs to explicitly encode this lifecycle rather than merely saying every path passes through `_realTarget()`.

## Other confirmed requirements

The earlier review’s five must-fix decisions remain valid:

1. **`viewFile` classification**
   - Recommended: classify by extension before approval.
   - Do not sniff file bytes before raising the interrupt.

2. **Honest confirmation**
   - Return something like `Queued invoice.png for attachment.`
   - Do not claim it was attached, because the reply-harvesting pipeline still decides actual delivery.

3. **`osascript` invocation**
   - Use `osascript -e`.
   - Pass path, language, and `fast` as argv.
   - Never interpolate them into JXA source.
   - Refuse non-Darwin platforms before calling `execFile`.
   - Retain a bounded output buffer, approximately 64 MB.

4. **Platform-specific testing**
   - Add `skipUnlessPlatform: "darwin"` for real Vision tests.
   - Update the schema, runner, precompiler, sandbox refusal lists, tests, and testing documentation.

5. **OCR naming**
   - Preferred API:
     - `readText` and `readTextBlocks`: local OCR
     - `readTextWithModel`: cloud OCR
   - Local OCR must never silently fall back to cloud, because approval to read locally does not authorize uploading the image.

## Repository facts confirmed

- `contained.ts` deliberately splits path handling into pre- and post-interrupt APIs.
- Its descriptor-backed read functions provide stronger protection than passing bare pathnames to external programs.
- `attachToReply` currently drops attachments outside a tool invocation and logs an error; therefore `viewFile` needs its own explicit early tool-context check if its contract is to return `Failure`.
- `viewFile` belongs beside `attachToReply` in `stdlib/thread.agency`.
- `skipUnlessPlatform` is not currently present in the test schema.
- The sandbox schema must refuse `skipUnlessPlatform` by name at both file and case level.
- `tesseract.js` currently has version `7.0.0` tagged as latest, but choosing and pinning a version still requires compatibility and supply-chain review.

## Recommended plan correction

Each file-consuming feature should specify two separate phases:

1. **Pre-approval**
   - Resolve the caller’s spelling.
   - Check allowed extension, existence, regular-file status, and size where appropriate.
   - Raise an interrupt containing the resolved spelling.
   - Do not read content bytes.

2. **Post-approval**
   - Revalidate the approved spelling with `fixedPath()`.
   - Open and validate the file through `contained.ts`.
   - Only then process, attach, or upload it.

For Vision specifically, safely passing a path to `osascript` needs extra design attention: a descriptor-validated read cannot simply be converted back into an ordinary pathname without weakening the guarantee. The implementation should either pass securely obtained image bytes to the subprocess in a controlled form or document and address the remaining pathname race.
