# Value Tags & Statelog Redaction — Design

**Date:** 2026-07-07
**Status:** Design (approved in brainstorm; pending written-spec review)
**Author:** brainstormed with owner

## Summary

Add the ability to attach arbitrary **tags** to Agency values, and read them
back anywhere in the program. Build one special tag — `redact` — on top of that
mechanism: any value marked for redaction is replaced with the string
`"[REDACTED]"` when it would otherwise be written to statelog.

The immediate motivating use case: an **API key** passed into a `fetch` request
should not appear in statelog. API keys are strings (primitives), which cannot
carry attached metadata the way objects can — so the core of this design is a
tag store that keys **primitives by value** and **objects/arrays by reference**.

Provenance tracking (the `response.provenance` idea) is explicitly **out of
scope** for this iteration. It is a separate, larger feature that builds on the
same tag mechanism; see [Future Work](#future-work).

## Goals

- Let users attach tags to values: `tag(x, "key", val)` and read them with
  `getTags(x)`.
- Provide `redact(x)` sugar that marks a value so it never reaches statelog in
  the clear.
- Make redaction of **primitive secrets (API keys, tokens)** fully robust —
  including across `fork`/`parallel`/`race` branches and interrupt/resume.
- Reuse the existing per-branch, serializable state machinery (`GlobalStore`)
  rather than inventing a parallel store.

## Non-goals

- **Provenance / taint propagation.** Tags do **not** automatically flow from
  inputs to computed outputs. `const y = x + 1` does not copy `x`'s tags to `y`.
- **Boxing primitives.** We never wrap primitives; TS/JS interop is unaffected.
- **Substring redaction (v1).** Only whole-value matches are redacted. A secret
  embedded inside a larger logged string (e.g. `"https://api.com?key=XYZ"`) is
  **not** scrubbed in v1. See [Open questions / follow-ups](#follow-ups).
- **Durable object tags across serialization boundaries.** Object (reference)
  tags are branch-local and do not survive a `fork` boundary or interrupt/resume
  (see [The identity constraint](#the-identity-constraint)).

## Background: why primitives are the hard part

Agency compiles to plain TypeScript/JS values. `const x = 1` is the number `1` —
there is no object to hang metadata on, and all `1`s are indistinguishable. This
is the same wall Clojure's metadata hits (its `with-meta` only works on reference
types). Boxing primitives into wrapper objects was rejected: it forces unwrap
logic on every arithmetic/comparison, triggers V8 deopts on numeric code, and
breaks at the TS interop boundary (a boxed number handed to a plain
`function f(n: number)` arrives as an object).

The chosen alternative (owner's proposal): keep tags in **side tables**, and for
primitives, **key by value** instead of by reference. Tagging the string
`"secret-key"` tags *every* occurrence of that exact string. For a high-entropy
secret this is correct and desirable — you want every copy redacted. (It is a
footgun for low-entropy values like `0`/`true`/`"1"`, which we address with
documentation, not enforcement.)

## Design

### Two tag stores

| Store | Keyed by | Backing structure | Durable across branch/interrupt? |
|---|---|---|---|
| Primitive store | value (`string \| number \| boolean`) | `Map<primitive, Tags>` | **Yes** — serializes and clones cleanly |
| Object store | object identity | `WeakMap<object, Tags>` | **No** — branch-local, ephemeral |

`Tags` is a plain record: `Record<string, unknown>`. `tag(x, "redact", true)`
sets `tags["redact"] = true`.

`getTags(x)` dispatches on type: primitive → look up the value `Map`; object →
look up the `WeakMap`. Returns `{}` when nothing is tagged. The split semantics
are intentional and **must be documented loudly**: tagging one object does not
tag a structurally-equal but distinct object, whereas tagging a primitive tags
all equal primitives.

### Where the stores live: `GlobalStore`

The stores live on `GlobalStore` (`lib/runtime/state/globalStore.ts`), which is
already the runtime's per-branch, serializable state container:

- Held canonically on `ctx.globals`; read per-branch via the `__globals()` ALS
  accessor.
- Cloned per branch at fork time in `runInBranchAlsFrame`
  (`lib/runtime/runBatch.ts`) via `parent.globals.clone()`; discarded at join.
- Serialized for interrupts via `toJSON()`/`fromJSON()`, with branch snapshots
  riding along on `BranchState.globalsJSON`.
- Reserves an `__internal` module namespace for runtime bookkeeping (already
  home to `__tokenStats`).

**Decision: copy-on-branch, not merge-up-the-chain.** Each branch gets its own
copy of the primitive store (following the existing GlobalStore clone), so a
branch can set different tags on the same value without affecting siblings or
the parent. We reuse GlobalStore's clone/serialize machinery rather than
building a merge-at-lookup scheme, because (1) copy-on-branch is how every other
per-branch value in the language already behaves, (2) the machinery is proven,
and (3) merge-up-the-chain is a novel mechanism that is harder to serialize and
whose only benefit — avoiding per-branch duplication — is a cost GlobalStore
already accepts for globals.

Implementation sketch:

- **Primitive store**: stored under the `__internal` module (e.g. key
  `__valueTags`) as `Map<primitive, Tags>` entries. `GlobalStore.toJSON()`/
  `fromJSON()`/`clone()` already round-trip Maps correctly, so it inherits
  serialization and per-branch cloning for free.
- **Object store**: a `WeakMap<object, Tags>` field on `GlobalStore`, explicitly
  **excluded** from `toJSON()` and reset (fresh empty) on `clone()`. See below
  for why it cannot do otherwise.

> House-rule note: the codebase prefers plain objects over `Map`. The primitive
> store is a justified exception — it needs primitive keys with correct
> type distinction (`1` vs `"1"` vs `true`), which only `Map` provides.

### The identity constraint

`GlobalStore.clone()` and interrupt save/restore both round-trip through
`toJSON`/`fromJSON`. That **destroys object identity**: a cloned or restored
object is a new reference. Consequences, which differ by store:

- **Primitive (value) tags are fully durable.** `"secret-key"` is still
  `"secret-key"` after any round-trip, so the value `Map` clones into branches
  and survives interrupt/resume. **This is the API-key case, and it works end to
  end.**
- **Object (reference) tags are inherently branch-local and ephemeral.** A
  `WeakMap` cannot be enumerated to serialize, and even if it could, the
  post-round-trip object has a new identity that would not match. So object tags
  work only *within a single branch, between interrupts*. A tagged object that
  crosses a `fork` boundary or an interrupt/resume loses its tag.

This is accepted, not fixed, in v1. It aligns with the feature: redaction's
headline target (API keys, secret strings) is primitive and gets the durable
path. Object redaction is a best-effort, branch-local bonus. (Provenance, which
leans on object tagging, will have to confront identity preservation — another
reason to defer it.)

### Public API

Placement (decided): a new `std::tag` module, imported like `guard` from
`std::thread`. Chosen over auto-imported stdlib / builtins to avoid growing the
no-import global namespace.

```ts
import { tag, getTags, redact } from "std::tag"

// General tagging
tag(x, "some key", "some val")   // tags["some key"] = "some val"
tag(x, "some key")               // val defaults to true
const t = getTags(x)             // Record<string, unknown>, {} if untagged

// Redaction sugar
redact(apiKey)                   // === tag(apiKey, "redact", true)
```

Signatures:

- `tag(value: any, key: string, val: any = true): void`
- `getTags(value: any): Record<string, unknown>`
- `redact(value: any): void`

`tag`/`redact` mutate the active branch's store (a side effect), returning
nothing. They are usable inside nodes and functions; behavior in module
top-level/global scope follows the same rule as other state-touching stdlib
(no-op or error — to be finalized during implementation, matching the existing
convention).

### Redaction hook

Every statelog event funnels through a single method, `StatelogClient.post(body)`
(`lib/statelogClient.ts`), which does one `JSON.stringify` for all sinks (file,
stdout, remote). That is the single chokepoint.

At the top of `post()` — synchronously, in the caller's branch ALS context,
before the `JSON.stringify` — run a `redactForStatelog(body)` walk:

1. Deep-walk the `body` object.
2. For each **primitive leaf**, check the value store; if it carries
   `redact: true`, replace it with `"[REDACTED]"`.
3. For each **object node**, check the object store; if tagged `redact: true`,
   replace the whole node with `"[REDACTED]"` (do not descend).
4. Leave everything else untouched.

This single seam covers all ~40 event types (node enter/exit data, `toolCall`
args/output, `promptCompletion` messages/completion, `followEdge` data, hooks,
`evalValue`/`evalOutput`, `debug`/`diff`, etc.) without touching individual
call sites.

Precedent: `lib/runtime/prompt.ts` already has a redaction pass
(`redactAttachments`) that shortens base64 blobs before logging; this is the
same shape of concern, generalized to user-marked values.

Reading the active stores inside the walk: use the ALS frame via
`getRuntimeContext()`/`__globals()` (the established pattern for stdlib TS
helpers). The walk runs synchronously within `post()` before any detached
(`noWait`) network send, so it always reads the correct branch's stores.

## Edge cases & decisions

- **Whole-value only (v1).** Only a logged leaf whose value equals a tagged
  primitive is redacted. `{ apiKey: "XYZ" }` → redacted; `"...key=XYZ..."` →
  not redacted. Tag the exact string that gets logged. Substring scrubbing is a
  documented follow-up.
- **Low-entropy footgun.** Tagging `0`/`true`/`""`/`"1"` redacts every equal
  value program-wide. Document that value-tagging is for high-entropy secrets;
  optionally emit a dev-mode warning when redacting a short/low-entropy
  primitive (nice-to-have, not required).
- **`shared: true` branches.** These pointer-share the parent GlobalStore, so
  tags set in the branch are visible to parent/siblings — consistent with how
  `shared: true` already treats globals.
- **Non-statelog logging.** This design only governs statelog. `print()` and
  other direct output are unaffected — a redacted value printed with `print()`
  shows in the clear (documented; redaction is a statelog concern, not a
  general secrecy guarantee).
- **Memory lifetime.** The primitive `Map` holds strong references to tagged
  values for the life of the (per-branch) store, pinning them in memory. For a
  bounded set of secrets this is fine. Broad use (many tagged values) would grow
  unbounded — acceptable for redaction's use case; a scoping/eviction story is a
  future concern tied to provenance.

## Testing

Use Agency execution tests (`tests/agency/`) and agency-js tests
(`tests/agency-js/`) — no LLM calls required. Configure statelog to a
`logFile`/`stdout` sink and assert on the emitted JSON.

- `tag` + `getTags` round-trip for primitives (by value: a second identical
  literal reads the same tags) and objects (by reference: a structurally-equal
  distinct object reads `{}`).
- `redact` on a string → `toolCall`/`evalValue` event shows `"[REDACTED]"` in
  place of the value; untagged siblings unaffected.
- Redaction survives a `fork` branch and an interrupt/resume for a **primitive**
  (durable path).
- Object tags are **not** expected to survive a fork/interrupt — assert the
  documented branch-local behavior so the limitation is pinned by a test.
- `shared: true` propagates tags to parent/siblings.
- Whole-value vs. embedded-substring: assert embedded secret is **not** redacted
  in v1 (locks the documented boundary).

## Implementation surface (file map)

- `lib/runtime/state/globalStore.ts` — add primitive `Map` under `__internal`
  and object `WeakMap` field; extend `toJSON`/`fromJSON`/`clone` (Map in, WeakMap
  excluded/reset).
- `stdlib/tag.agency` (+ TS impl, e.g. `lib/stdlib/tag.ts`) — `tag`, `getTags`,
  `redact`; read/write stores via `getRuntimeContext()`.
- `lib/statelogClient.ts` — call `redactForStatelog(body)` at the top of
  `post()`.
- New `redactForStatelog` walker (co-located with statelog or in a small
  runtime util) with unit tests.
- Docs: a guide page (e.g. `docs/site/guide/tags.md` / redaction section) making
  the value-vs-reference semantics and the statelog-only scope explicit; stdlib
  reference via `agency doc` from `stdlib/tag.agency` docstrings.

## Follow-ups

- **Durable object tags (custom serialization)**: today object/array (reference)
  tags are branch-local — they don't survive a `fork` clone or interrupt/resume,
  because object identity dies in the `toJSON`/`fromJSON` round-trip and a
  `WeakMap` can't be serialized. Storing tags *on* the object (e.g. a hidden
  `__tags` property) does **not** fix this on its own: a non-enumerable property
  is dropped by `JSON.stringify`, and an enumerable one leaks into user-visible
  object shape and into the logs. Making object tags durable needs a custom
  replacer/reviver pair that preserves a hidden `__tags` across the round-trip
  (and re-hides it after redaction). Deferred to a follow-up PR (decided during
  PR #447 review).
- **Substring redaction**: scrub tagged secrets embedded in larger logged
  strings (thorough but O(secrets) per log; can mangle output).
- **Additional special tags**: `pii`, etc., layered on the same mechanism.
- **Low-entropy dev-mode warning**.

## Future work: provenance (separate spec)

The eventual `response.provenance` capability — "could this user's data have
been involved in generating this response?" — builds on this tag store but needs
two things this spec deliberately omits:

1. An **involvement model**. When `userData` (an object) is interpolated into a
   prompt string, the object's identity is gone by the time `llm()` sees the
   string, so value-lookup finds nothing. Automatic provenance needs
   frame/thread-scoped accumulation (collect provenance-tagged values touched in
   the current frame; stamp the response with the active set). This matches the
   already-drafted **frame-scoped interrupt-lineage** model
   (`docs/superpowers/specs/2026-07-07-interrupt-provenance-design.md`).
2. A **write hook in `llm()` post-processing** (`lib/runtime/prompt.ts`, where
   cost/token accounting and structured-output parsing already happen) to attach
   the accumulated provenance to the returned value.

Because provenance is best-effort (over-approximation is acceptable — better to
say "maybe" than to miss), it avoids the strict implicit-flow requirements of
security taint-tracking. It is nonetheless a materially larger feature and is
intentionally deferred.

## Prior art (for reference)

- **Clojure `with-meta`/`meta`** — arbitrary metadata that doesn't affect
  equality; reference-types only (same primitive limitation).
- **Rust `secrecy`/`redact`/`secret-box`** — wrapper types whose Debug/log impl
  prints `[REDACTED]`, with explicit `expose_secret()`. The redaction model.
- **Perl taint mode / Ruby `$SAFE` (removed 3.0) / Ballerina `@tainted`** —
  taint tracking; one-bit, explicit-flow-only, security-oriented. Cautionary
  tale for the provenance follow-up (a trusted-but-leaky taint system is worse
  than none).
- **JIF / FlowCaml / LIO / Jeeves** — "correct" information-flow control
  (label lattices + PC label for implicit flows); powerful but heavyweight —
  out of scope.
