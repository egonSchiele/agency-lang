# Trace File Optimization + Skipped-Test Cleanup Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goals:**

1. Optimize per-execCtx trace writers so they cooperate via the file itself, not via shared in-memory state. After this work, multi-segment trace files have no duplicate headers and no duplicate chunks (cross-segment dedup), without putting any shared state on the parent `RuntimeContext`. Concurrency-safety in `traceDir` mode is preserved (each run still writes to its own `${runId}.agencytrace` file, so file-scanning never reads another run's data).

2. Triage the remaining skipped tests in the codebase — currently 7 in preprocessor unit-test files. Decide per-test: fix and re-enable, delete as obsolete, or document as still-blocked.

**Background:** PR #144 (merged as `c314da35`) un-skipped two debugger tests (`trace.test.ts` and `thread.test.ts`) and replaced the broken `__setTraceWriter` API with `__setTraceFile`. As part of that rework, cross-segment CAS dedup was deliberately dropped (per-writer CAS, files slightly larger but readable). This plan adds dedup back the right way — via file scanning, not shared in-memory state.

**Tech Stack:** TypeScript, Vitest, Node `fs`

---

## File Structure

### Modified files (Phase 1: trace dedup)

```
lib/runtime/trace/traceWriter.ts            # File-scan-on-construction, header skip
lib/runtime/trace/traceWriter.test.ts       # New unit tests for scan behavior
lib/debugger/trace.test.ts                  # Re-add deduplication assertion
```

### Modified files (Phase 2: skipped tests)

```
lib/preprocessors/typescriptPreprocessor.test.ts        # 1 skipped describe
lib/preprocessors/typescriptPreprocessor.core.test.ts   # 6 skipped describes/its
```

### New files

None — this is mostly modification of existing infrastructure.

---

## Phase 1 — Trace file optimization

### Task 1.1: Investigation

**Files:**
- Read: `lib/runtime/trace/traceWriter.ts`
- Read: `lib/runtime/trace/sinks.ts`
- Read: `lib/runtime/trace/traceReader.ts`
- Read: `lib/runtime/trace/contentAddressableStore.ts`
- Read: `lib/runtime/trace/types.ts` — confirm `TraceLine` shape (header / chunk / manifest / footer / source / static-state)
- Read: `lib/runtime/node.ts` — confirm `runNode` truncation flow

Goals:
- Confirm TraceWriter calls `writeHeader()` from three places: constructor's `create()`, `writeCheckpoint()`, `pause()`, `close()`. Confirm only the constructor call is needed; the others are defensive duplicates.
- Confirm `TraceReader` correctly handles a file with only ONE header (currently it handles many; should still handle one).
- Confirm `FileSink` opens in append mode (it does) and that `runNode` truncates fresh starts (it does, via `resolveTraceFilePath` + `writeFileSync`).
- Estimate cost: read full trace file at every `respondToInterrupts`. For a 10MB trace file with ~10 interrupts, that's 100MB of reads per run. Acceptable for tracing (which is opt-in and used in dev/debugging), but worth measuring later if traces get big.

- [x] **Step 1: Document findings inline in this plan**

#### Findings (Step 1 — completed in worktree at `.worktrees/trace-dedup/`)

**`writeHeader()` is called from FOUR places, not three** (correction to plan):

1. `TraceWriter.create()` at line 146 — once per writer construction.
2. `writeCheckpoint()` at line 71 — every checkpoint write triggers `await this.writeHeader()` first.
3. `pause()` at line 92 — at end of every segment.
4. `close()` at line 105.

`close()` ALSO calls `pause()` at line 112, which calls `writeHeader()` again. So `close()` writes the header twice with a footer between them. Per writer, a typical lifecycle therefore emits: 1 header (create) + N headers (one per checkpoint) + 1 header (pause-or-close) + (if close) 1 footer + 1 header (the final pause-from-close). For a writer with 1 checkpoint that ends on `pause()`, that's already 3 headers in the file. Multiple writers per run compound this. Reader silently ignores all but `lines[0]` (see below), so it's untidy but not broken.

**Implication for the fix:** an idempotent `writeHeader()` (gated by an instance flag `headerWritten`) is needed. After the first call (either at `create()` or seeded from a prior writer's header in the file), all subsequent calls become no-ops within that writer. Combined with the file-scan that detects whether the FILE already has a header from a prior writer, the result is exactly one `header` line per file.

**`TraceReader` requires `lines[0].type === "header"`** — strictly the first line. Lines 34-36:
```typescript
if (lines.length === 0 || lines[0].type !== "header") {
  throw new Error("Invalid trace file: missing header");
}
```
The reader's switch (lines 44-60) only handles `chunk`/`manifest`/`source`/`static-state`. Headers and footers after `lines[0]` are silently ignored (no `case` for them, no `default` either). So the scan logic must **guarantee** a header gets written first if none exists yet — otherwise reads break. The first writer of a fresh run (after `runNode` truncation) sees an empty file, no header found, must write one.

**`ContentAddressableStore` already has `loadChunks()`** at line 44 — but it stores BOTH `seenHashes` AND `chunkData`. For writer-side seeding, we only need `seenHashes` (we don't reconstruct values, only check whether a hash has been emitted). Adding a new `seedSeenHashes(hashes: Set<string>)` method avoids holding chunk *data* in memory for hashes the writer will never reconstruct. Memory matters for long traces — chunk data is the original (potentially-large) value JSON, which would otherwise be GC-able.

**`FileSink` confirmed append mode** (line 23, `flags: "a"`). Stream opens at construction, writes are buffered, `close()` awaits `stream.end()`.

**`respondToInterrupts` never truncates** — only call site is `createExecutionContext(interrupt.runId)` at line 236 of `lib/runtime/interrupts.ts`. Confirms the truncate-only-in-runNode invariant.

**`runNode` truncation flow** at lines 115-126 of `lib/runtime/node.ts`: `runId = nanoid()` → `resolveTraceFilePath` → `mkdirSync` (recursive) + `writeFileSync(path, "")`. Truncation happens BEFORE `createExecutionContext(runId)` (line 128), so the first writer of the run scans an empty file → no header found → writes one.

**`source` lines are NOT emitted at runtime** — only writer is `lib/cli/bundle.ts:49` (offline trace bundling for the `bundle` CLI command). Normal runtime trace files never contain source lines. Scan can ignore.

**`static-state` lines are emitted ONCE per run** — via `await __ctx.writeStaticStateToTrace(__globalCtx.getStaticVars())` from generated `__initializeGlobals()` (see `lib/backends/typescriptBuilder.ts:677`). After the first writer of a run, `globals.markInitialized` gates re-running. So the line appears once in the file. Scan can ignore (don't need to dedup it).

**File-flush ordering is safe** — `pause()` awaits `sink.close?.()` for every sink, and `FileSink.close()` awaits `stream.end()`. By the time a `respondToInterrupts` resolves and the driver calls the next `respondToInterrupts`, the previous writer's data is durably on disk. The new writer's `create()` scan reads consistent state.

**Footer handling (Open Question #2 from this plan): confirmed already correct.** `pause()` does NOT write a footer. Only `close()` does (line 106). With idempotent `writeHeader`, `close()` will write footer exactly once, and the file will end with the footer as the last line. Today, `close()` writes footer with an extra header AFTER it — this gets cleaned up by the idempotency change, no separate work needed.

**Existing test pattern** in `lib/runtime/trace/traceWriter.test.ts`: `beforeEach` creates a tmpDir + tracePath; tests construct `FileSink` directly with the path; a `readTrace(filePath)` helper parses JSONL. New scan tests will follow this pattern. There are also `traceReader.test.ts`, `contentAddressableStore.test.ts`, `sinks.test.ts`, `canonicalize.test.ts`, `eventLog.test.ts` for context but the writer one is the closest analog.

**Cost estimate (file-scan at every respondToInterrupts):** O(file size) per scan, called once per `respondToInterrupts`. For a 10MB trace + 100 interrupts = ~1GB total reads per run. For typical debugger sessions (sub-MB traces, tens of interrupts) negligible. Acceptable for the optimization. If traces get big in production-like usage, consider follow-up mitigations called out in Open Questions section. No action this round; document and move on.

**Risks / corner cases for implementation:**

- *Malformed lines.* If a previous writer crashed mid-write, the file may have a trailing partial JSON line. `JSON.parse` throws. Scan must wrap each line in try/catch and skip on failure (don't throw, don't stop scanning earlier valid lines). Edge: a partial line in the middle of the file would cause the rest to also be skipped if we stop on first error — better to skip just the bad line and continue.
- *File scan racing with previous writer's flush.* Theoretically possible if some other code starts a new writer without going through `pause()` first. Looking at the call paths, only `respondToInterrupts` (after a paused writer) and `runNode` (after truncation) construct writers, so this should not happen in practice. Document as "scan reads whatever is on disk at construction time; concurrency is the caller's responsibility."
- *Empty-file scan after truncation.* `runNode` writes `""` to the file. Scan reads empty content; `content.trim() === ""` → return `{ hasHeader: false, chunkHashes: new Set() }`. Writer then writes the header normally.
- *File doesn't exist yet.* `fs.existsSync` returns false; skip scan; writer writes header normally. (The first FileSink instance will create the file on its first write via the `WriteStream`.)

### Task 1.2: Scan-on-construction in TraceWriter

**Files:**
- Modify: `lib/runtime/trace/traceWriter.ts`

Behavior:
- `TraceWriter.create({ runId, traceConfig })` resolves the file path via `resolveTraceFilePath`. If a path resolves AND that file exists AND is non-empty, scan it for prior-writer state before constructing the writer.
- The scan reads the file line-by-line, parses each line as JSON, and:
  - If any line has `type === "header"`, set a flag `headerAlreadyWritten = true` so the new writer doesn't emit a duplicate.
  - Collect all `chunk` line hashes into a `Set<string>` and seed the new writer's CAS via a new `ContentAddressableStore.seedSeenHashes(Set<string>)` method.
- File scanning is best-effort: if a line fails to parse, skip it (log to stderr in verbose mode). Don't throw — partial trace files from crashes should not break a new writer.

API changes:
- `TraceWriter` constructor gains an optional `seenHashes?: Set<string>` parameter. If provided, it's passed to `ContentAddressableStore` (which gains a constructor option to seed `seenHashes`).
- `TraceWriter` adds a private `headerWritten = false` field. `writeHeader()` becomes a no-op if `headerWritten === true`. `create()` sets `headerWritten = true` if a header was found in the existing file, otherwise calls `writeHeader()` once and sets the flag.

- [x] **Step 1: Add `ContentAddressableStore.seedSeenHashes(hashes: Set<string>): void` method + unit test**

```typescript
// In ContentAddressableStore
seedSeenHashes(hashes: Set<string>): void {
  for (const h of hashes) this.seenHashes.add(h);
}
```

Test that after seeding hashes A, B, calling `process(record)` where the record references those hashes does NOT emit them as new chunks.

- [x] **Step 2: Add `scanExistingTraceFile(filePath: string): { hasHeader: boolean; chunkHashes: Set<string> }` helper in `traceWriter.ts`**

Reads the file synchronously (we're in `create()` which is already async, but file scan is small + sync I/O is fine here), parses each line, returns the scan result. Returns `{ hasHeader: false, chunkHashes: new Set() }` if the file doesn't exist or is empty.

- [x] **Step 3: Update `TraceWriter.create()`**

```typescript
const filePath = resolveTraceFilePath(traceConfig, runId);
let seenHashes: Set<string> | undefined;
let skipHeader = false;
if (filePath && fs.existsSync(filePath)) {
  const scan = scanExistingTraceFile(filePath);
  if (scan.chunkHashes.size > 0) seenHashes = scan.chunkHashes;
  if (scan.hasHeader) skipHeader = true;
}
// ... create sinks ...
const writer = new TraceWriter(runId, programName, sinks, { seenHashes, headerWritten: skipHeader });
if (!skipHeader) await writer.writeHeader();
return writer;
```

- [x] **Step 4: Update `writeHeader()`, `writeCheckpoint()`, `pause()`, `close()`**

Make `writeHeader()` idempotent — if `this.headerWritten`, return immediately. Keep the existing internal calls (they're defensive but cheap given the early return).

- [x] **Step 5: Add unit tests in `lib/runtime/trace/traceWriter.test.ts`**

Test cases:
- A new writer on an empty file writes header + emits chunks normally.
- A new writer on a file that already has a header does NOT write a duplicate header.
- A new writer on a file with existing chunks A, B and a new checkpoint that references chunks A, C only emits chunk C (chunk A is deduped via seeded `seenHashes`).
- A new writer on a malformed file (non-JSON line in the middle) doesn't throw and falls back to no-seed behavior (or partial seed, depending on implementation choice — document the choice).

### Task 1.3: Re-enable cross-segment dedup assertion in trace.test.ts

**Files:**
- Modify: `lib/debugger/trace.test.ts`

Now that cross-segment dedup works, add the assertion back:

```typescript
const lines = fs.readFileSync(traceFile, "utf-8").trim().split("\n").map(JSON.parse);
const headers = lines.filter((l) => l.type === "header");
expect(headers.length).toBe(1); // exactly one header across all segments
const chunks = lines.filter((l) => l.type === "chunk");
const manifests = lines.filter((l) => l.type === "manifest");
expect(chunks.length).toBeLessThan(manifests.length * 2); // dedup happened
```

- [x] **Step 1: Add the dedup + single-header assertions to the existing `produces a trace file...` test (don't add a separate `it` — keeps suite order-independent per prior reviewer feedback)**

### Task 1.4: Update FileSink comment + TraceConfig docs

**Files:**
- Modify: `lib/runtime/trace/sinks.ts`
- Modify: `lib/runtime/trace/types.ts`

The append-mode comment in `sinks.ts` should mention that cross-segment dedup is now achieved via file-scanning in `TraceWriter.create`, not by giving up entirely.

The `TraceConfig.traceFile` doc comment can be softened slightly: it's still single-run-only because the path is fixed (concurrent runs would still race), but consecutive runs to the same path will properly truncate (via `runNode`) and then dedup within the run.

- [x] **Step 1: Update both comments**

### Task 1.5: Verify

- [x] Run `pnpm exec vitest run lib/runtime/trace lib/debugger/trace.test.ts` — all pass (80/80).
- [x] Run full suite `pnpm exec vitest run` — 1 failure (`typescriptBuilder.integration.test.ts > Fixture: 'getContext'`) which is pre-existing on bare `main` (verified by stashing). Stale fixture references the old `__setTraceWriter` API replaced by PR #144. Not introduced by this work.
- [x] Run `pnpm run lint:structure` — 1 error in `lib/lsp/hover.ts` (`prefer-const` on `baseEnd`), pre-existing (file untouched in this branch).

---

## Phase 2 — Skipped-test triage

The skipped tests in main (after PR #144) are all in preprocessor unit-test files:

| File | Line | Item | Notes |
|---|---|---|---|
| `lib/preprocessors/typescriptPreprocessor.test.ts` | 6 | `describe.skip("_addPromiseAllCalls")` | Promise.all handling; method `_addPromiseAllCalls` may be obsolete |
| `lib/preprocessors/typescriptPreprocessor.core.test.ts` | 49 | `describe.skip("containsInterrupt")` | Method still exists in preprocessor; tests may be salvageable |
| `lib/preprocessors/typescriptPreprocessor.core.test.ts` | 121 | `describe.skip("markFunctionsAsync")` | Method commented out in `runProcessing()` (line 344-345) — likely obsolete |
| `lib/preprocessors/typescriptPreprocessor.core.test.ts` | 180 | `describe.skip("markFunctionCallsAsync")` | Same as above |
| `lib/preprocessors/typescriptPreprocessor.core.test.ts` | 222 | `describe.skip("removeUnusedLlmCalls")` | Method `removeUnusedLlmCalls` still exists; check API drift |
| `lib/preprocessors/typescriptPreprocessor.core.test.ts` | 266 | `it.skip("should keep llm calls with sync tools (side effects)")` | Specific case inside `removeUnusedLlmCalls` describe |
| `lib/preprocessors/typescriptPreprocessor.core.test.ts` | 431 | `describe.skip("addPromiseAllCalls")` | Same family as #1 |

### Task 2.1: Investigation

User directive (mid-thread): delete all 7 skipped describes/its outright AND delete the corresponding preprocessor methods from `typescriptPreprocessor.ts`, since none of those methods run anymore.

Per-test decision: **DELETE** (option c) for all 7. Per-method dead-code analysis confirms safe deletion:

- `markFunctionsAsync`, `markFunctionCallsAsync`, `_markFunctionAsAsync`, `containsInterrupt`: no live callers. The two `markFunctions*` methods are commented out in `preprocess()` (lines 344-345 of original file). `_markFunctionAsAsync` is only called by `markFunctionsAsync`; `containsInterrupt` is only called by `_markFunctionAsAsync` and itself. All-or-nothing dead chain.
- `removeUnusedLlmCalls`, `_removeUnusedLlmCalls`: `removeUnusedLlmCalls` IS called from `preprocess()` (line 346), but its body just delegates to `_removeUnusedLlmCalls`, which is `return body;` (entire original implementation is commented out — see TODO at line 383 of original file). So both are no-ops. Deleting them is safe; the call site at line 346 must also be removed.
- `_addPromiseAllCalls` / `addPromiseAllCalls`: methods do not exist in the source file at all. Tests were lingering after a prior method removal.

Dead state fields after method deletion:
- `functionNameToAsync`: only used by `_markFunctionAsAsync` and inside `_removeUnusedLlmCalls`'s commented body. Dead. Deleted.
- `functionNameToUsesInterrupt`: only used by `containsInterrupt`. Dead. Deleted.
- `findChildren`, preprocessor's `isBuiltinFunction`: dead in main, but out of scope (not tied to skipped tests).
- `topologicalSortFunctions`: dead from runtime perspective (only caller was `markFunctionsAsync`) but still has its own non-skipped unit test in `core.test.ts`. Kept.

- [x] **Read the test code** to understand what it's asserting.
- [x] **Read the corresponding preprocessor method** in `lib/preprocessors/typescriptPreprocessor.ts`.
- [x] **Decide one of three outcomes:** all (c).

### Task 2.2: Apply the per-test decisions

- [x] **Delete `lib/preprocessors/typescriptPreprocessor.test.ts` entirely.** All 4 tests inside the single `describe.skip("_addPromiseAllCalls")` block — the file's only contents besides the wrapper describe — are obsolete. Removing the inner block would leave an empty wrapper, so dropping the whole file is cleaner.
- [x] **Delete the 5 `describe.skip` blocks (containsInterrupt, markFunctionsAsync, markFunctionCallsAsync, removeUnusedLlmCalls, addPromiseAllCalls) from `lib/preprocessors/typescriptPreprocessor.core.test.ts`.** Lines 49–660 of the original file (614 lines, 14 tests).
- [x] **Delete the corresponding methods + dead state fields from `lib/preprocessors/typescriptPreprocessor.ts`.** Removed: `removeUnusedLlmCalls`, `_removeUnusedLlmCalls`, `markFunctionsAsync`, `markFunctionCallsAsync`, `_markFunctionAsAsync`, `containsInterrupt`, `functionNameToAsync`, `functionNameToUsesInterrupt`. Also removed the 28-line comment block + 3 commented-out method calls at the start of `preprocess()` (lines 317-346 of original) which described the rationale for keeping `markFunctionsAsync` commented out — moot after deletion.

### Task 2.3: Verify

- [x] Run `pnpm exec vitest run lib/preprocessors/` — 86/86 pass.
- [x] Run full suite `pnpm exec vitest run` — 3428/3429 pass; the 1 failure is the pre-existing `typescriptBuilder.integration.test.ts > Fixture: 'getContext'` (stale fixture from PR #144's `__setTraceWriter` → `__setTraceFile` rename). Test count dropped from 3447 (with 18 skipped) to 3429 (with 0 skipped) = exactly the 18 deleted tests, no more no less. No new failures.
- [x] Run `pnpm run lint:structure` — same 1 pre-existing error in `lib/lsp/hover.ts` (file untouched).

---

## Final verification

- [x] Full test suite: `pnpm exec vitest run` — 0 new failures vs main baseline. 1 pre-existing failure (`getContext` fixture) remains; bare-main verified by stashing.
- [x] Lint: `pnpm run lint:structure` — 1 pre-existing error in `lib/lsp/hover.ts`; not introduced by this work.
- [x] No new files created (deletions + targeted edits + new unit tests inside existing test files).
- [x] Local-only changes; not committed or pushed.

---

## Open questions / things worth larger discussion

1. **File scan cost at scale.** Reading the entire trace file at every `respondToInterrupts` is O(N) in the file size, called O(M) times for M interrupt segments → O(N·M) total work over a run. For typical debugger sessions (tens of interrupts, < 1MB file) this is fine. For long-running agents with thousands of interrupts and large state, the cost grows. Mitigations to consider in a follow-up: cache the seen-hashes set on `__globalCtx` keyed by file path (re-introduces shared state but only as a derived cache; could be invalidated on `__setTraceFile`), or maintain a sidecar index file (`${trace}.idx`) with hash entries.
2. **Footer handling.** Currently `pause()` writes a header and `close()` writes a header + footer. With idempotent `writeHeader`, only the first writer's header lands. Should the *last* writer's `close()` write the footer, and intermediate `pause()` calls skip footers? They already do — only `close()` writes the footer. Confirm in Task 1.1.
3. **Phase 2 deletions.** If multiple skipped describes are deleted as obsolete, that's a meaningful signal that the preprocessor pipeline has evolved past them. Worth flagging in commit message; not worth a separate refactor PR.
