# Issue #513 — guard block around a paused subprocess `run()` loses its value after serialize/resume

> **CORRECTION (2026-07-14):** The root-cause theory below is WRONG. The
> subprocess payload does NOT get lost on a popped block frame — checkpoints
> are stamped while block frames are live, and positional replay realigns
> them. The verified cause is `FunctionRefReviver` throwing eagerly on
> unregistered `__block_<n>` references when a FRESH process restores a
> checkpoint (blocks self-register only when their creating line executes).
> See `2026-07-14-issue-513-block-ref-revive-fix-design.md` for the verified
> mechanism and the fix. The code references below remain useful.

**Investigation date:** 2026-07-13
**Issue:** https://github.com/egonSchiele/agency-lang/issues/513
**Status:** Root cause confirmed (code-grounded, high confidence). Not yet fixed.

---

## Symptom (from the issue)

When a subprocess pauses on a bubbled interrupt and its serialized stack contains a
`guard(...) as { ... }` block wrapping the paused `run()` call, resuming loses the block's
return value: after the approval resumes the tree, the outer `run(...)` expression evaluates
to `undefined` instead of the child's Result. The node then crashes with
`Cannot read properties of undefined (reading X)` when it touches `result`.

- Single-level (in-memory) pause/resume through a guard block **works**.
- The value is lost **only** when the process holding the guard block is itself a subprocess,
  i.e. its state stack goes through checkpoint serialize/deserialize before the resume.
- Reproduces without any PR #512 feature by writing the inner hop as a user-level
  `guard(cost: 1.0) as { return run(...) }`, so the bug is in guard-block resume across
  serialization, not in `maxCost` itself.

**Impact on #512:** `run(maxCost: ...)` wraps `_run` in a guard block, so `maxCost` on a nested
run that pauses returns `undefined`. PR #512 keeps the no-cap path guard-free (two call sites)
so default behavior is unaffected; collapsing to a single always-guarded call site (a review
suggestion) is blocked on this bug.

---

## Root cause

The paused subprocess's **resume payload is stored on a frame that gets discarded during
serialization** when `run()` sits inside a `guard(...) as { }` block.

### The mechanism, step by step

1. When a nested `run()` (`_run`) pauses on a bubbled interrupt, `_run` stashes everything
   needed to resume the child — the child's checkpoint, the surfaced interrupts, the node —
   into a **frame local**:
   - `lib/runtime/ipc.ts:1255` → `saveSubprocessPayload(args.parentFrame, { childCheckpoint, interrupts, node, subprocessSessionId })`
   - `args.parentFrame` is `stateStack.lastFrame()` — set at `lib/runtime/ipc.ts:1331`
     (`const parentFrame = stateStack.lastFrame();`)
   - The payload lands in `frame.locals["__subprocess_state_0"]`
     (`SUBPROCESS_PAYLOAD_KEY`, `lib/runtime/ipc.ts:496–499`)

2. The design **assumes that frame is serialized** with the parent. The comment at
   `lib/runtime/ipc.ts:1252–1254` says exactly this:
   > *"Opaque payload: serialized with the parent frame; NEVER walked by State.toJSON — the
   > child checkpoint belongs to another process and must not be spliced into the parent replay."*

3. But when `_run` runs inside a `guard(...) as { return try _run(...) }` block, `lastFrame()`
   is the **block's own frame** (`__bframe_<blockName>`), not `run()`'s def frame. The frame
   chain at the moment `_run` executes is:

   ```
   run() def frame            (persistent — serialized)
     └─ guard() def frame     (persistent — serialized)         [pushed by the guard def]
          └─ _runGuarded(...)  (TS seam — pushes NO agency frame)
               └─ __call(block)
                    └─ block frame __bframe_<block>  ← lastFrame() here  (EPHEMERAL)
                         └─ try _run(...)   → saveSubprocessPayload(__bframe, ...)
   ```

4. The block frame is created fresh by `setupFunction()` and **popped in a `finally`**:
   - `lib/templates/backends/typescriptGenerator/blockSetup.mustache`:
     the block body runs inside `try { ... } finally { __bsetup.stateStack.pop(); }`
   - So by the time the process serializes its state stack, the block frame is **already gone**,
     taking `__subprocess_state_0` with it.

5. On deserialize-resume, `loadSubprocessPayload(parentFrame)` returns `undefined`
   (`lib/runtime/ipc.ts:1202`), `_run` cannot pair the resume responses with a saved child
   checkpoint, and the outer `run()` expression evaluates to `undefined`. That is the crash.

### Why in-memory / single-level works (the issue's key clue)

In memory, resume is driven by the **live `runBatch` branch objects** and the live interrupt's
`.checkpoint` reference. The frame-local `__subprocess_state_0` is only the
**serialization-survival copy**. Only the serialize → deserialize path actually reads the
payload back off a frame — which is precisely the case where the popped-block-frame loss bites.
This exactly matches the issue's observation that the failure is specific to
serialize/deserialize.

### Why the existing workaround works

`run()` already keeps a **guard-free no-cap path** — the two-call-sites structure at
`stdlib/agency.agency:161–216` (see the explanatory comment at lines 161–167). When
`maxCost == null`, `try _run(...)` runs **directly in `run()`'s own def frame** (persistent,
serialized), so `lastFrame()` is `run()`'s frame and the payload survives. The guard block is
only introduced on the `maxCost != null` path (`stdlib/agency.agency:182`), which is exactly the
broken path.

---

## What was ruled out during investigation

- **The block value itself is NOT the lost state.** `State.toJSON()` does
  `deepClone(this.args)` (`lib/runtime/state/stateStack.ts:204`), which drops function values —
  and the block is an `AgencyFunction`. This looked like the culprit at first. But it is not:
  the generated def body rebinds the block **unconditionally on every (re-)invocation**. Verified
  empirically by compiling a probe def with a block param — the generated body emits
  `__stack.args["block"] = block === __UNSET ? null : block;` at the top, before any runner step
  (`lib/backends/typescriptBuilder.ts:2045` is the analogous `__stack.args[...] = ...` binding).
  On resume, `main` re-executes, creates a **fresh** block `AgencyFunction`, and passes it into
  the reused (deserialized) frame, overwriting the dropped one. So the block is present and
  callable on resume — the only lost thing is the frame-local subprocess payload.

- **Not the `try`-expression / `__tryCall` value-passthrough.** `__tryCall` correctly passes
  interrupts through untouched (`lib/runtime/result.ts:177`, `hasInterrupts(value)` guard) and
  passes a returned Result through without double-wrapping. This is in the same *family* as #483
  (`try llm()` losing its success value), and the issue author flagged the resemblance, but the
  mechanism here is distinct: #483 is a codegen value-drop with no pause involved; #513 is a
  frame-lifecycle loss specific to pause + serialize.

---

## Key code references

| Location | Role |
|---|---|
| `lib/runtime/ipc.ts:496–508` | `SUBPROCESS_PAYLOAD_KEY = "__subprocess_state_0"`, `saveSubprocessPayload` / `loadSubprocessPayload` / `clearSubprocessPayload` — payload lives in `frame.locals` |
| `lib/runtime/ipc.ts:1331` | `const parentFrame = stateStack.lastFrame();` — the frame the payload is written to |
| `lib/runtime/ipc.ts:1252–1263` | Interrupted branch: saves payload, comment asserts it is "serialized with the parent frame" |
| `lib/runtime/ipc.ts:1202`, `1266` | `loadSubprocessPayload` on resume; `clearSubprocessPayload` on success |
| `lib/runtime/ipc.ts:480–490` | `SubprocessResumePayload` type (childCheckpoint, interrupts, node, sessionId) |
| `lib/templates/backends/typescriptGenerator/blockSetup.mustache` | Block frame created by `setupFunction()`, popped in `finally` (`__bsetup.stateStack.pop()`) |
| `lib/backends/typescriptBuilder.ts:1743–1797` | `processBlockArgument` — how `as { }` blocks compile (own frame `__bframe_<name>`, own `blockName` scope) |
| `lib/runtime/state/stateStack.ts:619–640` | `getNewState()` — in deserialize mode returns the existing (deserialized) frame; in serialize mode pushes a new one |
| `lib/runtime/state/stateStack.ts:202–208` | `State.toJSON()` — `deepClone(this.args)` drops functions (why `scopedCallbacks` are special-cased at 209–217) |
| `stdlib/agency.agency:161–216` | `run()` two-call-sites: guard-free no-cap path (works) vs `guard(cost:) as { }` path (broken). Comment at 161–167 already documents the footgun without pinning the mechanism. |
| `stdlib/thread.agency:212–252` | `guard` def: `_pushGuard` → `_runGuarded(ids, block)` → `_popGuard` |
| `lib/stdlib/thread.ts:357–378` | `_runGuarded` TS seam: `__tryCall(() => __call(block, ...), { ownedGuardIds, ... })`. Comment notes `stack.lastFrame()` is guard()'s own frame (the TS call pushes no agency frame). |
| `lib/runtime/result.ts:168–231` | `__tryCall` — interrupt passthrough (177), guardTrip→Failure conversion gated on `ownedGuardIds` (205) |

---

## Fix options

Two altitudes.

### A. Narrow fix — unblocks #512, fixes `maxCost` (recommended if the goal is just #512)

Move the cost-guard wrapping out of an Agency `as { }` block and into a TS seam so `_run`
always executes with `run()`'s **persistent def frame** as `lastFrame()`.

Because `_runGuarded` deliberately pushes **no** Agency frame, a helper along the lines of
`_runGuarded(ids, () => _run(...))` with a **plain TS closure** (not an Agency block) would run
`_run` against `run()`'s def frame — so `saveSubprocessPayload` lands on a serialized frame —
while still passing `ownedGuardIds` so `__tryCall` converts a cost trip to a Failure. This also
collapses `run()` to a single call site (the review suggestion #512 was blocked on).

- **Fixes:** `run(maxCost:)` under nested pause; #512 single-call-site cleanup.
- **Does NOT fix:** a user-written `guard(...) as { return run(...) }` (still loses the payload).
- **Effort:** ~half a day + a nested-pause fixture.
- **Risk:** low-moderate — confined to the `run()` cost-cap path and the `_runGuarded` seam.

### B. General fix — removes the footgun (the real altitude)

Make the subprocess payload survive an enclosing block frame's pop, so *any* subprocess `run()`
wrapped in *any* user `guard`/block resumes correctly across serialization.

Candidate approaches:
- Save `__subprocess_state_0` on the nearest **serialized** frame by walking past ephemeral
  block frames (keyed to avoid collisions when multiple runs share an ancestor frame), or
- Flush a block frame's `__subprocess_state_0` down to its owner frame **before** the `finally`
  pop in the block template.

- **Fixes:** all subprocess runs inside any block/guard across serialize.
- **Effort:** ~1–2 days + fixtures for user-`guard`-around-`run` across serialize.
- **Risk:** higher — touches the block-frame lifecycle and the fork/race pop invariant the
  block template's `finally` comment warns about (popping the ALS-current stack, not
  `__ctx.stateStack`, matters for parallel/fork/race branches).

### Recommendation

Do **B** if we want the footgun gone — the current mitigation is "never wrap a subprocess run in
a block," which is easy to violate and only enforced by a comment. Do **A** if the immediate goal
is just unblocking #512 and making `maxCost` correct under nested pause.

Either way, write the **failing test first**: a `tests/agency/subprocess/` fixture matching the
issue's repro (child holds the `guard(...) as { }` block, grandchild `bash` pauses, one approval
resumes the whole tree, assert the node returns `OK: deep-ok`). The existing
`tests/agency/subprocess/nested-pause-resume.agency` is the guard-free version to fork from; the
`run-max-cost.agency` fixture is the closest existing coverage of `maxCost` forwarding.
