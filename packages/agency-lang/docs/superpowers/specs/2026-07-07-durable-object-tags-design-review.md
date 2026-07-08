# Review: Durable Object Tags — Design (2026-07-07)

**Spec:** `2026-07-07-durable-object-tags-design.md`
**Verdict:** Approve with revisions — Finding 1 needs a design addition (join-time
flag propagation + a test) before this goes to a plan; Findings 2–3 are small
spec amendments.

All claims below were verified against the worktree code (`revivers/index.ts`,
`globalStore.ts`, `redactForStatelog.ts`, `statelogClient.ts`, `runBatch.ts`,
`stateStack.ts`), not just the spec text.

## What checks out

- **The chokepoint claim is true.** Only five non-test files touch
  `nativeTypeReplacer`/`nativeTypeReviver`: `deepClone` (`lib/runtime/utils.ts:8`),
  `lib/runtime/state/stateStack.ts`, `lib/runtime/state/context.ts`,
  `GlobalStore.toJSON` (`lib/runtime/state/globalStore.ts:166-169`), and the
  log-path file. One new reviver really does cover deepClone, interrupt locals,
  and globals clone/fork. The altitude is right — this reuses the codebase's own
  round-trip semantics instead of inventing a parallel path.
- **The log path really is separate.** `makeRedactReplacer`
  (`lib/runtime/redactForStatelog.ts`) is a standalone replacer that never
  composes with `nativeTypeReplacer`, and `statelogClient.ts:1191` uses plain
  `JSON.stringify` with it. A `__nativeType:"Tagged"` marker can't appear in
  logs, and `JSON.stringify` drops the symbol key natively.
- **The reviver mechanics work as described.** `JSON.parse` revivers run
  bottom-up, so `value.v` is fully revived when `TaggedReviver.revive` runs; the
  spread in `serialize` drops the non-enumerable symbol so there's no re-match
  loop; and all 7 registered revivers were checked — none match plain
  objects/arrays, so registration order genuinely doesn't matter.
- The frozen-after-tagging **serialize** path, the spread-drops-tag semantics,
  and the monotonic-flag safety direction are all correct as written.

## Finding 1 (must fix): child→parent join still leaks — the spec's own promise is broken in one direction

The `hasAnyTags()` fix covers tag-signal flow **parent→child** (clone/`fromJSON`
carry the serialized flag) but not **child→parent**. Successful branch results
return to the parent **by reference** — `lib/runtime/runBatch.ts:381`
(`const value = await fn()`; successful returns are never round-tripped) —
while the branch ran on a **cloned** GlobalStore (`runBatch.ts:348-352`). So:

1. A branch calls `redact(obj)` — the symbol lands on the object, and
   `__hasObjectTags` is set on the *branch's* store.
2. The branch returns `obj`; it reaches the parent with its tag intact (that's
   the durability the spec promises).
3. The parent posts statelog. The gate at `statelogClient.ts:1190` reads the
   **parent's** store, whose flag was never set → the redaction pass is skipped
   entirely → `obj` logs **unredacted**, even though `isRedacted(obj)` would
   have said yes.

Today this same flow merely loses the tag, which the docs call out as
branch-local. After this spec, the guide will say object tags "survive
fork/race/parallel" — making this a silent leak relative to the documented
contract. Interrupt payloads (`e.data` referencing a branch-tagged object,
handled by parent handlers) hit the same hole.

**Fix:** propagate the flag at branch settle in `runBatch` — when a branch
completes (values *or* interrupts) with its store's object-tag flag set, OR it
into the parent's store. It's monotonic so this is one boolean write, and
there's already a per-branch propagate-at-join precedent (the cost/token
roll-up). `shareGlobals: true` needs nothing (same store).

**Test to add:** branch redacts an object, returns it, parent logs it →
`[REDACTED]`.

## Finding 2: `removeAllTags` on a tagged-then-frozen object will throw

The edge-case section covers freeze-after-tag for *serialize/read* only. But
freezing makes the symbol property non-configurable, so
`delete obj[TAG_SYMBOL]` throws a TypeError in strict mode — and the spec's
test plan says "removeTag / removeAllTags clear the symbol prop." The current
code (`globalStore.ts:103-116`) has the same shape split: `removeTag` mutates
the record (safe — the record object isn't frozen when the target is),
`removeAllTags` deletes the container entry (unsafe on the symbol path).

**Fix:** implement `removeAllTags` on the durable path by clearing the record's
keys (or try-delete with record-clear fallback), never by deleting the property.

## Finding 3: `revive` should restore the null-prototype record

`tagsRecordFor` deliberately uses null-prototype records so a tag key like
`"__proto__"` is a plain data property (`globalStore.ts:62-64`). `JSON.parse`
produces an `Object.prototype`-based `tags` record, so a later `setTag` on the
revived object would assign through the `__proto__` setter.

**Fix:** one line in `revive` — `Object.setPrototypeOf(value.tags, null)`
before attaching. Worth stating in the spec so the invariant doesn't silently
regress.

## Smaller suggestions

- **Split the flag instead of unifying it.** The spec sets the serialized
  `__hasObjectTags` on both the durable and WeakMap paths. But WeakMap tags
  *don't* survive clone — serializing their bit means one tag on a frozen
  object makes every descendant branch and every resumed run pay the redaction
  pass forever, for a tag that no longer exists. Keep two bits: today's
  in-memory `objectTagsPresent` (resets on clone, covers WeakMap — current
  behavior at `globalStore.ts:23` is already correct for it) plus the new
  serialized flag for the durable path only. Same safety, less permanent
  over-approximation.
- **Name `tagsRecordFor` in the file map.** The dispatch the spec's table
  describes lives in one unified helper (`globalStore.ts:65`), not severally in
  `setTag`/`getTagsFor`/`removeTag`. Saying so keeps the implementer from
  forking that unified path; `removeAllTags` (`:110`) is the one method with
  its own branch to update.
