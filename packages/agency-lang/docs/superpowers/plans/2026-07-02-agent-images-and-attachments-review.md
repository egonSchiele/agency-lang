# Review: Agent Images and Attachments Plan

**Reviewed:** `docs/superpowers/plans/2026-07-02-agent-images-and-attachments.md`
**Against spec:** `docs/superpowers/specs/2026-07-02-agent-images-and-attachments-design.md`
**Reviewer:** Amp (Claude)
**Date:** 2026-07-02

---

## Summary

Overall a **solid, executable plan**. Task ordering is correct (both prerequisites — placeholder rendering and the modality probe — come before the feature tasks that depend on them). TDD steps are concrete, commits are scoped to their tasks, and the "Spec-coverage map" at the end honestly ties every spec item to a task, including a named "known limitation" for the un-exercisable generation-failure branch. Verified: `mainAgentTools` layout, `Resolved.model`, `stat` shape, `Attachment` shape, `_contentToString` current behavior, `smoltalk.modelSupportsInputModality` signature and `undefined` return for unknown models — all match the plan's assumptions.

Nonetheless there are a handful of correctness bugs, test-fragility issues, and one small style deviation that should be addressed before execution.

---

## Blocking issues

### B1. `modalityFilter` mutates its input's `skipped` array (Task 5, Step 1)

```
let skipped: string[] = detected.skipped
...
skipped.push("${label} (model ${main.model} has no image input)")
```

Agency arrays are reference-typed. `let skipped = detected.skipped` aliases the caller's array, and `skipped.push(...)` mutates it. The wrapping call site (`modalityFilter(detectAttachments(expanded))`) does not reuse `detected`, so the observable behavior is correct today — but this is a landmine for the next caller who does. Also inconsistent with the fresh `attachments`/`labels` arrays right next to it.

**Fix:** `let skipped: string[] = [...detected.skipped]` (array spread is called out as proven in "Global Constraints"). Same pattern the plan already uses to build `parts` in the wiring.

### B2. `modalityFilterPassthroughWhenNoSlots` relies on execution-test process state

The test asserts `main == null` in `getResolvedSlots()` to exercise the passthrough branch, but a single Agency execution-test process runs many nodes. If any earlier node in `attachments.agency` (or a test the runner batches with it) has called `applyResolved(...)`, `main` will be non-null and this node's `.attachments.length` result depends on whether the leftover model happens to accept images. The other two `modalityFilter*` nodes in this same file **do** call `applyResolved(...)`, and node execution order within a `.agency` file is not documented to be top-to-bottom.

**Fix:** Either (a) explicitly reset with `applyResolved({})` at the top of the passthrough test, or (b) drop the "no slots" node and only test the two positive cases where the model is explicitly set. Option (a) is preferable if `applyResolved({})` clears the "main" slot cleanly — worth a quick check against `shared.agency:121`.

### B3. `attachmentsTurn.agency` thread-slug probe is silently fragile

`threadHasImagePlaceholder()` probes `["t0", "t1", "t2", "t3"]`. The `main` thread's assigned slug is a function of every `thread(...)` block opened earlier in the run, not a stable constant. The plan itself flags this ("do not widen the slug probe list silently without understanding why") but that's a guardrail, not a fix — if slug allocation changes for any reason, all three tests silently return `…|false` and the human has to debug the fixture.

**Fix (pick one):**
- Grab the current thread id explicitly: replace the slug loop with `getThread(currentThreadId(), 0, 200)` after the reply returns. `currentThreadId()` is exported from `std::thread` (line 409). This is exact — no guessing.
- Or use `listThreads(lazySummarize: false)` and filter to `label == "main"`, then read that id. Passing `false` avoids the "burns mocks via summarization" concern the plan calls out.

Either replaces four brittle string constants with the real id and eliminates the "which slug did I get today" failure mode.

---

## Non-blocking correctness/robustness issues

### N1. `normalizeToken` doesn't handle empty `HOME`

```
if (t.startsWith("~/")) {
  const home = env("HOME")
  if (home != null) {
    t = home + t.slice(1)
  }
}
```

`env` returns `string | null` but nothing prevents a `HOME=""` (rare but real in containers/CI). An empty `home` would rewrite `~/foo.png` to `/foo.png` and then fail the stat silently. Cheap guard: `if (home != null && home != "")`.

### N2. `tildeExpansion` test permanently mutates process-wide `HOME`

`setEnv("HOME", "/tmp")` in the test leaks to every subsequent node in the same execution-test process. Any later test that legitimately depends on the real `HOME` will observe `/tmp`. Test parallelism in `test:agents -p 12` is per-file subprocess, so the leak stays within the file, but future tests appended to `attachments.agency` are still affected.

**Fix:** Snapshot and restore:
```
const savedHome = env("HOME")
setEnv("HOME", "/tmp")
const d = detectAttachments("see ~/da-tilde.png") with approve
if (savedHome != null) { setEnv("HOME", savedHome) }
return "${d.attachments.length}"
```

### N3. `directoryIgnored` uses `exec("mkdir", ...)` without checking it succeeded

If `/tmp/da-dir.png` already exists as a regular file (leftover from a prior `da-a.png`-style test run — nothing cleans `/tmp`), `mkdir` fails, `stat.type == "file"`, and the test wrongly reports `1`. Two ways to be safe:

- Use `mkdir -p /tmp/da-dir-$$.png` (unique) — but Agency has no `$$` shell expansion here.
- Prefer a unique fixed name that no other node writes to: `da-uniq-dir.png` (already unlikely to collide) and add `exec("rm", ["-rf", "/tmp/da-uniq-dir.png"]) with approve` before `mkdir` to guarantee a clean starting state.

Same "leftover fixture" concern applies more broadly — several nodes reuse the same `/tmp/da-*.png` names across runs, but for those the write always overwrites, so no drift.

### N4. `modalityFilter` uses a while-loop where `for (i in range(...))` would be idiomatic

Micro-nit. The two parallel arrays (`attachments[i]`, `labels[i]`) argue for index iteration, and Agency's `range()` is used elsewhere in the same test file (`capsAtTen`). This is style, not correctness.

### N5. `MIME_TYPES: Record<string, string>` used with `MIME_TYPES[ext]` and compared `== null`

Fine given how Agency codegens `Record` index access, but double-check the type checker allows `MIME_TYPES[ext]` to narrow to `string | null` rather than raising an "index may not exist" error. If it does raise, the plan should switch to a small `if/else if` chain or an `includes()` guard on a keys array. Not a huge risk — `Record<string,string>` index access is used all over the stdlib — but worth confirming during Task 3 Step 2 (`pnpm run ast`).

### N6. `reportsWriteFailure` assumes `writeBinary` returns a `Failure` for a nonexistent directory

Not verified in this review. If `writeBinary` instead auto-creates the missing directory (mkdir -p behavior), the test flips green for the wrong reason. Suggest a quick smoke: `pnpm test:run lib/stdlib/write*.test.ts` (or equivalent) before assuming the failure shape. If the current behavior is auto-create, use a truly-unwritable directory (`/` on macOS, `/proc` on Linux) or set an interrupt-denying handler and use `with reject` instead of `with approve`.

### N7. The `10` cap constant is spec'd but the test proves it "at 10 or fewer", not "exactly 10"

`capsAtTen` writes 11 files, expects the return to be `10`. Good. But there's no test that at 9 attachments all 9 come through — trivial to add and would catch an accidental off-by-one that clamps at 9.

Not a blocker; consider adding.

---

## Spec vs. plan alignment

| Spec item | Plan task | Status |
|---|---|---|
| Part A tool: generate + edit, agent-cwd, dirname split, Result-checked write | Task 4 Step 3 | ✅ Exact match |
| Part A registration + system-prompt bullet | Task 4 (c)/(d) | ✅ Includes the "5 subagent tools + one direct tool" copy fix |
| Part B algorithm steps 1–9 | Task 3 | ✅ All present, incl. tilde, quoted, escaped-space, dedupe, cap, size-skip, inline base64 |
| Attachment lifetime (inline at attach) | Task 3 Step 1 | ✅ Comment even cites the poison-thread / policy-gate reasons |
| Wiring (visible 📎 lines, `mainAgent` widening) | Task 5 Step 3 | ✅ |
| Risk 4: modality (`modelSupportsInput`, tri-state, skip-on-false) | Task 2 + Task 5 | ✅ Correct tri-state semantics — only `== false` drops |
| Risk 5 prerequisite (placeholders in `_contentToString`) | Task 1 | ✅ Also exports the symbol so tests can import it |
| Testing: detectAttachments units | Task 3 | ✅ Covers all 13 spec cases |
| Testing: generateImageFile | Task 4 | ✅ + honest note about the un-exercisable failure branch |
| Testing: turn integration | Task 5 | ✅ (see B3) |

**No spec drift.** Every decision in the spec's "Decisions" and "Non-goals" sections is respected — the plan does not extend scope to subagent attachments, view-back loop, or eviction tooling.

---

## Small factual/style notes

- **`color` is used in `agent.agency` (line 135 etc.) without an import.** The plan says "(`pushMessage` and `color` are already imported in `agent.agency`.)". `pushMessage` is imported from `std::ui/cli` (line 10), but `color` is auto-imported / global. That's fine, but the parenthetical is slightly inaccurate — worth removing to avoid confusion.
- **Task 2 Step 1 probe** — the `modelSupportsInputModality` check confirmed that `gpt-3.5-turbo` returns `false` (verified while reviewing). The substitution instructions are still valuable as future-proofing.
- **Task 6 Step 2** — running `pnpm run test:agents` locally is called out as safe (no LLM). Good; that's consistent with the AGENTS.md guidance about `.agency` execution tests being LLM-free by default.
- **Task 1 test file `describe` name.** Appending a bare `describe("_contentToString", ...)` at the end is fine, but if `threads.test.ts` currently wraps everything in a top-level `describe`, indent it accordingly. Nit.
- The `Attachment[]` and `type: "image" | "file"` shape used by `modalityFilter` matches `stdlib/thread.agency:75-77` exactly — good.

---

## Recommendations before starting execution

1. **Must fix (blocking):** B1 (`skipped` aliasing), B3 (fragile slug probe).
2. **Should fix:** B2 (test state contamination), N2 (`HOME` restore), N3 (directory-fixture cleanup).
3. **Nice to have:** N1 (empty-`HOME` guard), N6 (verify `writeBinary` failure shape ahead of Task 4), N7 (positive-cap test at N=9).
4. **Cosmetic:** N4 (`for … in range`), the "`color` already imported" wording.

With B1–B3 addressed, this plan is ready to execute. The overall design is coherent, the TDD flow is real (each task's Step 2 verifies failure before Step 3–4 implements + verifies success), and the commit boundaries mean any single revert is safe.

---

## Anti-pattern audit (against `docs/dev/anti-patterns.md`)

Focused pass on whether the plan's *generated code* (not the plan document itself) exhibits any of the catalog's anti-patterns. The most important question you asked — **does the plan write declarative interfaces that neatly encapsulate complexity, or is it imperative code all the way down?** — has a mixed answer: the *outer* interfaces are well shaped (`DetectedContent`, `modalityFilter(detectAttachments(...))` composes as a pipeline, `generateImageFile` does one thing), but the *innards* of the two new helpers lean heavily imperative in ways the anti-patterns doc explicitly calls out.

### AP1. Order-dependent mutable state — `modalityFilter` (Task 5, Step 1). Real hit.

```
let ok = true
if (a.type == "image" && imageOk == false) {
  ok = false
  skipped.push(...)
}
if (a.type == "file" && pdfOk == false) {
  ok = false
  skipped.push(...)
}
if (ok) {
  attachments.push(a)
  labels.push(label)
}
```

Textbook example of the anti-pattern's "Bad" — `ok` is declared, mutated in two guarded blocks, then read below. The two branches happen to be mutually exclusive (an Attachment can't be both `image` and `file`), so the code works, but the intent gets lost in a mutable flag.

**Declarative rewrite:**
```
const drop =
  (a.type == "image" && imageOk == false) ||
  (a.type == "file" && pdfOk == false)
if (drop) {
  const reason = a.type == "image" ? "image" : "PDF"
  skipped.push("${label} (model ${main.model} has no ${reason} input)")
} else {
  attachments.push(a)
  labels.push(label)
}
```

`drop` is a `const` derived from the inputs — no reordering can break it.

### AP2. Imperative parallel arrays leaking through the interface — `DetectedContent` (Task 3). Design smell.

`DetectedContent` returns three same-length, index-coupled arrays: `attachments: Attachment[]`, `labels: string[]`, plus `skipped: string[]` (which is not index-coupled but still a bare array). `modalityFilter` then walks two of them by shared index (`detected.attachments[i]` + `detected.labels[i]`), and the wiring iterates each separately for its print loop. This is exactly the "imperative code everywhere" case the anti-patterns doc warns about: consumers must know *how* the arrays are aligned rather than being handed a shape that expresses *what* they are.

**Declarative rewrite:**
```
type DetectedAttachment = { attachment: Attachment, label: string }
type SkippedAttachment = { label: string, reason: string }

export type DetectedContent = {
  text: string,
  attached: DetectedAttachment[],
  skipped: SkippedAttachment[]
}
```

Then `modalityFilter` is a single `filter`/`map`, wiring prints via `for (s in detected.skipped) { pushMessage(color.yellow("📎 skipped ${s.label} — ${s.reason}")) }`, and consumers can't accidentally desynchronize the arrays. The plan already imports `map` from `std::array` for Task 4 — the same primitive would make Task 3's main loop declarative.

Bonus: this also unpicks AP1's `ok` flag naturally, because filtering *is* the declarative form of "keep if …".

### AP3. Manual imperative accumulator loops in `detectAttachments` (Task 3). Encapsulation is fine at the seams, imperative in the middle.

The main loop:
```
for (t in tokens) {
  if (attachments.length >= MAX_ATTACHMENTS) { continue }
  const norm = normalizeToken(t)
  const ext = extname(norm).toLowerCase()
  const mime = MIME_TYPES[ext]
  if (mime == null) { continue }
  ...
  seen.push(abs)
  ...
  if (info.size > maxBytes) { skipped.push(...); continue }
  const bytes = readBinary(name, dirname(abs))
  if (isFailure(bytes)) { skipped.push(...); continue }
  if (mime == "application/pdf") { attachments.push(...) } else { attachments.push(...) }
  labels.push(name)
}
```

Every step of the algorithm — tokenize, normalize, extension filter, resolve, dedupe, stat, size gate, read, attachment shape — is inlined into one loop with 4 mutating accumulators. Anti-patterns doc §"Imperative code everywhere" specifically calls out `for + if + push + dedupe` chains and prescribes a `filter`/`map` pipeline instead. A more declarative shape:

```
def tokenToCandidate(token: string): Candidate | null { ... }   // normalize, ext, resolve, mime
def readCandidate(cand: Candidate): Attempt                     // stat, size, read → attached or skipped
```

then

```
const candidates = tokenize(msg).map(tokenToCandidate).filter(c => c != null)
const unique = dedupeByPath(candidates)
const attempts = unique.slice(0, MAX_ATTACHMENTS).map(readCandidate)
```

Not obligatory — the plan's shape is testable and correct — but the current form buries the algorithm's 9 spec steps inside one imperative loop, so future edits (e.g. adding SVG, changing the dedupe key to content hash) touch the whole loop instead of one small function. Worth pulling apart at least `tokenToCandidate` (steps 1–5) from `readCandidate` (steps 6–8).

**`tokenize` itself is fine** — it's a hand-written scanner, and the doc explicitly exempts parsers from the order-dependent-state rule.

### AP4. One-line `if` statements — Task 1 (`_contentToString`) and Task 2 (`_modelSupportsInput`). Direct hit.

```ts
// Task 1
if (typeof content === "string") return content;
if (content == null) return "";
...

// Task 2
if (modality !== "image" && modality !== "pdf") return null;
return modelSupportsInputModality(model, modality) ?? null;
```

Both violate the "One-line if statements" entry. The bodies should be braced. Purely cosmetic; the structural linter (`pnpm run lint:structure`, called in Task 6) may or may not flag these — worth checking. If the linter is silent, still fix, because the plan explicitly says "Task 6 Step 1: linter clean" and other stdlib TS files (e.g. `lib/stdlib/threads.ts:41`) already use single-line-return style. If the codebase precedent overrides the doc here, note that in the review of Task 6.

### AP5. Single-character variable names — pervasive. Direct hit.

The plan's Agency code repeatedly uses single-char loop and helper vars: `for (t in tokens)`, `let t = token`, `const a = detected.attachments[i]`, `const p = part`, `for (s in detected.skipped)`, `for (l in detected.labels)`, `map(images) as p { ... }`, `const w = writeBinary(...)`, `const r = generateImage(...)`, `const d = detectAttachments(...)`, `const f = modalityFilter(d)`. The anti-patterns doc explicitly forbids these and asks for descriptive names.

Renames worth making mechanically:
- `t` → `token`, `p` → `part` / `path`, `a` → `att` / `attachment`, `s` → `skipReason`, `l` → `label`, `d` → `detected`, `f` → `filtered`, `r` → `result`, `w` → `writeResult`.

Test-node bodies (e.g. `const d = detectAttachments(...)`) are less critical because they're throwaway assertions, but the production code (`attachments.agency`, `modalityFilter`, `generateImageFile`) should follow the rule.

### AP6. Useless special case — arguable, Task 5 wiring.

```
if (detected.attachments.length == 0) {
  return mainAgent(expanded)
}
...
const parts: (string | Attachment)[] = [expanded, ...detected.attachments]
return mainAgent(parts)
```

If `mainAgent` widens to `string | (string | Attachment)[]`, passing `[expanded]` (a one-element array) should be semantically identical to passing `expanded` (a bare string) — smoltalk's `userMessage` accepts both. If so, this is the anti-patterns doc's "useless special case" — drop it and always take the array path. **Worth actively verifying** rather than assuming, because there may be a subtle downstream difference (e.g. summarization, thread persistence, provider serialization) that treats the two shapes differently, and if there is, the early return is documenting that difference (and should have a comment saying so).

### AP7. Magic number — `20971520` (Task 3).

`export def detectAttachments(msg: string, maxBytes: number = 20971520)` uses the raw byte count. Bind it: `static const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024` (matches smoltalk's 20 MB cap the comment already cites), then default to `MAX_ATTACHMENT_BYTES`. The plan already binds `MAX_ATTACHMENTS = 10` right above — do the same for the byte cap for consistency.

### Not violated

- **Duplicating existing code.** The plan explicitly reuses `applyAgentCwd`, `readBinary`, `writeBinary`, `stat`, `basename`/`dirname`/`extname`, `env`, `map`, `modelSupportsInputModality`, `getResolvedSlots`, `_contentToString`. No reinvention.
- **Leaky abstractions.** `DetectedContent` hides the tokenizer/normalizer/reader entirely — callers only see `{ text, attachments, labels, skipped }`. `modalityFilter` composes on the same type. Same story for `generateImageFile`: caller sees `(prompt, path, size, images) → string`, not `generateImage` + `writeBinary` + `dirname`. The outer seams are clean; the internals (see AP2, AP3) are the imperative part.
- **Inconsistent patterns.** Follows the surrounding agent code (`shared.agency`, `resolution.agency`) idioms.
- **Nested ternaries / try-catch without logging / dynamic requires / nested type objects.** None present.

### Verdict on the "declarative interfaces + imperative internals" question

The **interface layer is well-designed** — you can read `modalityFilter(detectAttachments(expanded))` and immediately understand the pipeline. The **implementation layer regresses to imperative style** in three places (AP1, AP2, AP3), most sharply in `modalityFilter`'s `ok` flag and in the parallel `attachments` / `labels` arrays that leak through `DetectedContent` itself. AP1 and AP2 are worth fixing because they compound: refactor `DetectedContent` to carry `DetectedAttachment[]`, and `modalityFilter` collapses to a single `filter`+`map` with no flags. AP3 is a "should", AP4/AP5/AP6/AP7 are "cheap wins while you're in the file."

None of these promote to blocking — the code works — but the anti-patterns doc's tone is prescriptive ("read this before starting a task"), so a review that ignores them would be doing the plan a disservice.

---

## Test-plan audit: do the tests actually test what they claim?

The tests as a set cover the happy paths honestly, but there are several tests that would still pass if the code they claim to test were broken, and several code paths with no test at all. Grouped by severity.

### T-BLOCK. Tests that pass even when the code is broken

**T-B1. `editInputsPassThrough` (Task 4) doesn't test what its name says.**

```
node editInputsPassThrough(): string {
  setAgentCwd("/tmp")
  generateImageFile("seed", "it-seed.png") with approve
  return generateImageFile("restyle it", "it-edit.png", images: ["it-seed.png"]) with approve
}
```

The deterministic image client (`useTestLLMProvider: true`) returns the same fixed 1×1 PNG regardless of the `images` argument. So this test only proves that passing a non-empty `images` list doesn't crash — the entire `const inputs = map(images) as p { return applyAgentCwd(p) }` line could be deleted (or replaced with `const inputs = []`) and the test would still pass green.

**Consequence:** the "LLM-supplied paths resolve against the agent cwd" invariant for edit inputs — one of the spec's explicit requirements ("Both paths resolve against the agent cwd") — has **no test coverage**. If someone accidentally removes `applyAgentCwd`, no test catches it.

**Fix:** either (a) have the deterministic image client capture and expose the last-received `images` argument so the test can assert `it-seed.png` was resolved to `/tmp/it-seed.png`, or (b) add a unit that reads the underlying `generateImage` call args via a spy/mock, or (c) at minimum, exercise with a bogus relative input path and confirm the read-input step reaches the correct place (harder — the deterministic client doesn't read inputs at all).

**T-B2. `modalityFilterDropsForTextOnlyModel` doesn't cover the PDF branch.**

The implementation has two independent drops:
```
if (a.type == "image" && imageOk == false) { ... }
if (a.type == "file" && pdfOk == false) { ... }
```

Only the `image` drop is tested. Delete the `pdfOk` check entirely and every test still passes. Also, `pdfOk` computed from `modelSupportsInput(main.model, "pdf")` (Task 2) — nothing tests the "pdf" modality end-to-end.

**Fix:** add a `modalityFilterDropsPdfForNoPdfModel` node with a `.pdf` attachment and a text-only model. Requires a model in the catalog with `pdf: false` — the same probe pattern from Task 2 Step 1 will find one.

**T-B3. `_modelSupportsInput` tests never exercise `"pdf"`.**

All four `describe("_modelSupportsInput")` cases pass `"image"` or `"audio"`. The whitelist `if (modality !== "image" && modality !== "pdf") return null` could be tightened to `if (modality !== "image") return null` and the tests would still pass, silently breaking the entire PDF-attachment code path in Task 5.

**Fix:** add `expect(_modelSupportsInput("<pdf-capable-model>", "pdf")).toBe(true)` and one for `false`.

**T-B4. `savesToAgentCwd` doesn't distinguish agent-cwd from process-cwd resolution.**

```
setAgentCwd("/tmp")
const msg = generateImageFile("a red bicycle", "it-gen.png") with approve
const back = readBinary("it-gen.png", "/tmp") with approve
```

The Agency test process's own cwd is almost certainly `packages/agency-lang/`, and `writeBinary("it-gen.png", ..., "")` (the "no agent cwd" fallback) would land at `packages/agency-lang/it-gen.png`. So the test *does* meaningfully assert that the agent cwd was consulted — but only if the process cwd is guaranteed *not* to be `/tmp` when the test runs. Fragile if someone runs the test suite from `/tmp` for any reason (e.g. a hermetic-CI change). Micro-risk, but worth using a distinctive path like `/tmp/agency-imgtest-<pid>/` if the fixture directory can be made unique.

More concretely: **there's no negative assertion** that `it-gen.png` was NOT written under process cwd. A truly diagnostic version would `setAgentCwd("/tmp")`, call `generateImageFile(..., "it-gen.png")`, then assert both `readBinary("it-gen.png", "/tmp").isSuccess()` AND `readBinary("it-gen.png", cwd()).isFailure()`.

### T-COVERAGE. Missing tests for real code paths

**T-C1. Only two of six MIME types are exercised.** `MIME_TYPES` has entries for `.png .jpg .jpeg .gif .webp .pdf`. Tests hit `.png` and `.pdf`. Someone accidentally deleting `.gif` or `.webp` from the table (a real-world drift risk when someone adds `.svg` or `.heic` later) would not fail any test. **Add:** one parameterized-style test per remaining extension, or one aggregate test that writes a `.jpg`, `.jpeg`, `.gif`, `.webp` fixture and asserts `attachments.length == 4`.

**T-C2. Case-insensitive extension (`.toLowerCase()`) is untested.** A user drag-dropping `Screenshot.PNG` (macOS default caps) or a `Report.PDF`. Delete `.toLowerCase()` in the implementation and the tests still pass.

**T-C3. `readBinary` failure branch is untested.** `if (isFailure(bytes)) { skipped.push("${name} (could not read)") }` — no test constructs a file that stat sees as a file but readBinary rejects. Hard to build portably (a chmod 000 file needs a `chmod` call; a symlink-loop needs `ln -s`), and the branch is two lines, so this is an acceptable known gap — but the plan doesn't call it out the way it calls out the generation-failure gap in Task 4.

**T-C4. Multiple attachments in one message.** No test asserts that `see /tmp/a.png and /tmp/b.png` returns two attachments in the given order. If a bug reordered or dropped subsequent attachments (e.g. an off-by-one in the cap check firing at 0 instead of `MAX_ATTACHMENTS`), only the `capsAtTen` corner case would catch it, and even that only tells you "≥10 became 10", not "the first N are preserved."

**T-C5. Mixed attachment types in one message.** `.png + .pdf` in one call — untested. Would exercise the `if (mime == "application/pdf") { file(...) } else { image(...) }` branch selection in a single loop, and would also catch a bug where the `if` predicate is inverted.

**T-C6. Subagent route stays text-only** (spec decision #3). The spec explicitly reserves subagent direct-routing (`agentReplyVia("code", "look at /tmp/x.png")`) as text-only. **No test verifies this.** If a future refactor accidentally routed `agentReplyVia("code", ...)` through the same `detectAttachments` path, this decision would silently regress. Add a `subagentRouteIgnoresImagePath` node.

**T-C7. Visible print lines (`📎 attached`, `📎 skipped`) are untested.** Task 5 Step 3 adds `pushMessage(color.yellow("📎 skipped ${s}"))` and `pushMessage(color.dim("📎 attached ${l}"))`. Delete either line and no test fails. The spec's "**never silent**" invariant is unenforced. Capturing REPL output in `.agency` tests is possible via the `clearMessages`/`pushMessage` module or by structuring `agentReply` to return the message trail — worth at least one test that captures and asserts on the emitted string.

**T-C8. Cost tracking on generation.** Spec: "generation cost flows into the agent's existing cost tracking / `guard(cost:)`". No test does `const before = getCost(); generateImageFile(...); const after = getCost(); assert(after > before)`. If `generateImageFile` accidentally used a code path that bypassed cost accrual, `guard(cost:)` would silently fail to budget for it.

**T-C9. Attachment order preservation.** The pipeline is `tokenize → filter → attachments.push(...)` — insertion order should match message order. Untested. `dedupes` uses only one path, so it can't distinguish "the second mention was dropped" from "the second mention was reordered."

**T-C10. Empty message.** `detectAttachments("")` — untested. Should return `{ text: "", attachments: [], labels: [], skipped: [] }`.

**T-C11. `_contentToString` corner cases.** The implementation has code paths for: `null` content, `type: "text"` with nullish `text` field, unknown part `type` (falls through to `JSON.stringify`), empty array. None are tested. The `"never leaks base64"` test is largely redundant with the placeholder-rendering test (the exact-match assertion already implies the base64 is absent).

**T-C12. Double-quoted path in tokenizer.** Tokenizer handles both `'` and `"`. Only `'` is tested (`quotedPathWithSpaces`). A refactor that broke double-quote handling wouldn't fail.

### T-FRAGILE. Tests whose green result depends on test-order/environment

**T-F1. `applyResolved` state leakage across nodes** — already covered as B2, but broader than the passthrough test. `attachesImageToTurn` (turn integration) doesn't call `applyResolved`, so it inherits whatever main-slot model is set from the framework's default. If the default were ever changed to a text-only model, or if a previously-run node in the same process left one behind, the modality filter would drop the image and `threadHasImagePlaceholder()` would return `false` → test fails for a reason unrelated to the code under test.

**T-F2. `/tmp` fixture-file collisions across the suite.** Multiple test nodes write to `/tmp/da-*.png` and `/tmp/at-*.png` with fixed names. Under `-p 12` parallel-file execution the *files* are per-process, but if two nodes within the same file happen to race (Agency test runner may run nodes serially within a file — worth checking), the last writer wins and read-back can flap. Suggest: prefix fixtures with the node name (`/tmp/at-x-attachesImageToTurn.png`) or a shared `testFixturePath("at-x.png")` helper.

**T-F3. `tildeExpansion` mutates `HOME` process-wide** — already covered as N2 in the correctness section. Repeating here for completeness: if a future test appended below reads `env("HOME")`, it sees `/tmp`.

**T-F4. `directoryIgnored` assumes `mkdir` won.** If `/tmp/da-dir.png` already exists as a file from a stale prior run, `mkdir` fails silently, stat sees the file, and the test wrongly reports `1` (a false negative on "we ignore directories") — but the expected output is `"0"`, so the test would loudly fail with a mismatch. Wait — that means the test *would* fail, just with a confusing diagnostic. Still worth a `rm -rf` prefix to make the message clearer when it fires.

### T-GOOD. Tests that hold up under scrutiny

- **`_contentToString` "renders text parts and attachment placeholders"** — exact-match string assertion covers ordering, spacing, and label formatting all at once. Nice.
- **`overLimitSkipped`** — asserts both count and the exact `skipped[0]` string. If the skip label wording changes, the test fails loudly.
- **`relativeResolvesAgainstAgentCwd`** — actually distinguishes agent-cwd resolution from other resolutions, because the token has no `/`, the file is at `/tmp/da-rel.png`, and `setAgentCwd("/tmp")` is the only way it can be found.
- **`quotedPathWithSpaces` and `escapedSpacePath`** — the `da b.png` filename cannot be produced by any tokenization other than the intended one, so a broken tokenizer would give a `"0"` count.
- **`capsAtTen`** — returning a number (not a string) sidesteps the JSON-encoding quirk and exercises the cap boundary properly.
- **`reportsWriteFailure`** — uses `startsWith(...)`, which is robust against writeBinary appending errno details but strict enough to fail if the "Generated the image, but saving" branch is replaced with the wrong string. (Modulo the N6 concern that writeBinary might auto-create the dir.)

### Prioritized test additions

If the plan is executed as written, these are the additions that would catch the most real regressions per line of test code:

| # | Test | Catches |
|---|---|---|
| 1 | `_modelSupportsInput("<pdf-model>", "pdf") == true` and `false` | T-B3 — silent PDF path removal |
| 2 | `modalityFilterDropsPdfForNoPdfModel` | T-B2 — silent `pdfOk` removal |
| 3 | `subagentRouteIgnoresImagePath` (`agentReplyVia("code", ...)`) | T-C6 — spec decision #3 regression |
| 4 | Aggregate multi-extension test (`.jpg .jpeg .gif .webp` fixtures, expect 4) | T-C1 — MIME table drift |
| 5 | `editInputsResolveAgainstAgentCwd` — needs image-client spy | T-B1 — silent removal of `applyAgentCwd` on edit inputs |
| 6 | `mixedImageAndPdfInOneMessage` — expect one image + one file | T-C5 — branch coverage |
| 7 | `printsVisibleAttachedLine` — capture pushMessage output | T-C7 — silent-attach regression |
| 8 | `costRecordedForGeneration` — `getCost()` delta | T-C8 — guard(cost:) budgeting |

Add the top 3 minimum, all 8 for defense in depth.

### Summary of the test-plan audit

- **False greens (4):** `editInputsPassThrough`, `modalityFilterDropsForTextOnlyModel` (missing PDF twin), `_modelSupportsInput` (missing PDF), `savesToAgentCwd` (weak agent-cwd vs process-cwd distinction).
- **Missing coverage (12):** MIME extensions, case-insensitive ext, readBinary failure, multi-attachment, mixed types, subagent route, `📎` print lines, cost tracking, order preservation, empty message, `_contentToString` corner cases, double-quoted paths.
- **Test-isolation fragility (4):** `applyResolved` leak, `/tmp` fixture collision, `HOME` leak, `mkdir` assumption.
- **Honest green (6):** the tests listed under T-GOOD really do fail when their subjects break.

Net: **the test suite as written proves the happy path works, but under-defends against regressions.** The single most valuable additions are T-B3 (pdf whitelist) and T-B1 (edit-inputs agent-cwd) — both are one-liners in the production code, both are called out in the spec, and neither would fail a single test if removed.
