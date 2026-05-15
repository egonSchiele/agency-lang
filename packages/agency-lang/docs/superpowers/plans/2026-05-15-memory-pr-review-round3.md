# PR #141 Review — Round 3 Implementation Plan

Tracks the 31 comments egonSchiele left on the PR after round 2.
Items marked **NEEDS DISCUSSION** are deliberately deferred — they
require design conversation, not just implementation.

If picking this up in a new thread:
- Worktree: `~/agency-lang/packages/agency-lang/.worktrees/memory-layer`
- Branch: `feature/memory-layer`
- Run tests with `AGENCY_USE_TEST_LLM_PROVIDER=1` for the agency
  memory tests, otherwise they call the real LLM.
- After editing stdlib `.agency` files, run `make`.
- Save test output to a file (tests are slow; don't rerun blindly).

---

## Order of work

1. Phase A — Mechanical fixes (constants, type dedup, log line).
2. Phase B — Move inline LLM prompts to mustache templates.
3. Phase C — Replace hand-rolled validation with Zod schemas.
4. Phase E — Code dedup and small optimizations.
5. Phase F — Investigations (test-framework mocks, embedding-manager
   reload, agency.json config inheritance, LLM-as-judge test).
6. Phase D — Bigger refactors (types unification, model-from-config,
   move LLM calls into agency code).
7. Phase G — File follow-up issues, add TODO comments.

Within each phase, do all the mechanical edits, then run typecheck +
focused tests, then move on. Save the full test suite for the end of
each phase.

---

## Phase A — Mechanical fixes

| Comment | File:Line | Plan | Status |
|---|---|---|---|
| #28 | `lib/runtime/llmClient.ts:52` | Re-export `smoltalk.EmbedConfig` / `EmbedResult` instead of duplicating. Drop the local types. | DONE |
| #29 | `lib/runtime/llmClient.ts:86` | Fold the per-memory `LlmClient` shim into `LLMClient`. Update `createMemoryLlmAdapter` to satisfy `LLMClient` directly. | DONE — deleted `llmAdapter.ts` entirely; MemoryManager now takes `LLMClient` + `smoltalkDefaults` directly via private `_text`/`_embed` helpers. |
| #8 | `lib/runtime/memory/manager.ts:27` | Same as #29. Delete `LlmClient` alias, import from `llmClient.js`. | DONE |
| #14 | `lib/runtime/memory/manager.ts:231` | Replace bare `catch {}` on Tier 3 with logged warning. | DONE — `console.warn` with query + error. |
| #18 | `lib/runtime/memory/manager.ts:322` | Move `50000` to `lib/constants.ts` as `MEMORY_COMPACTION_DEFAULT_THRESHOLD`. | DONE |
| #5 | `lib/runtime/memory/embeddings.ts:24` | Create `lib/constants.ts` with `DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small"`. Use everywhere (SmoltalkClient, SimpleOpenAIClient, EmbeddingManager). | DONE |
| #2 | `lib/runtime/memory/compaction.ts:46` | When `findCompactionSplitPoint` returns -1, log via `console.warn`. | DONE — log added at the call site in `manager.compactIfNeeded` so we have access to the messages array. |

Verify: `pnpm tsc --noEmit`, `pnpm test:run lib/runtime/memory/ lib/runtime/llmClient* lib/runtime/deterministicClient.test.ts`.

---

## Phase B — Mustache templates for prompts

| Comment | File:Line | Plan | Status |
|---|---|---|---|
| #3 | `lib/runtime/memory/compaction.ts:57` | Create `lib/templates/prompts/memory/compaction.mustache`. Run `pnpm run templates`. Replace inline string in `buildCompactionPrompt`. | DONE |
| #6 | `lib/runtime/memory/extraction.ts:22` | Same pattern — `lib/templates/prompts/memory/extraction.mustache`. | DONE |
| (implicit) | `manager.ts` retrieval/forget/merge prompts | Move all of them to `lib/templates/prompts/memory/{retrieval,forget,merge-summary}.mustache` while we're touching the file. | DONE |

Refer to existing `lib/templates/backends/agency/template.mustache` for
how mustache files are wired (typestache compiles `.mustache` →
`.ts`; only edit the `.mustache` source).

Verify: `pnpm run templates`, then run the memory tests.

---

## Phase C — Zod schemas

| Comment | File:Line | Plan | Status |
|---|---|---|---|
| #23 | `lib/runtime/memory/manager.ts:542` | Define `ExtractionResultSchema = z.object({ entities: z.array(...), relations: z.array(...), expirations: z.array(...) })` in `extraction.ts`. Replace `parseExtractionResult` with `safeParse`. Type `ExtractionResult` becomes `z.infer<typeof ExtractionResultSchema>`. | DONE |
| #24 | `lib/runtime/memory/manager.ts:554` | Same pattern for `ForgetResultSchema`. | DONE — schema lives in `manager.ts` next to its only caller; also moved `parseStringArray` to use `z.array(z.string()).safeParse`. |
| #25 | `lib/runtime/memory/store.ts:67` | Add `MemoryGraphDataSchema`, `EmbeddingIndexSchema`, `ConversationSummarySchema` to `types.ts`. `saveGraph` / `saveEmbeddings` / `saveSummary` validate via `safeParse` first; throw with the parse error path so corruption is debuggable. | DONE — validates on both load and save; error includes file path and offending field path(s). |

Verify: memory tests + a deliberately bad-shape test for each.

---

## Phase E — Code dedup and small wins

| Comment | File:Line | Plan | Status |
|---|---|---|---|
| #16 | `manager.ts:241` | Extract `private async tier1And2(entry, query): Promise<string[]>`. `recall` adds Tier 3 on top, `recallForInjection` returns Tier 1+2 only. | DONE |
| #21 | `manager.ts:429` | Folded into Phase D #11 (move extraction into agency code) — once there's only one extraction path, dedup is automatic. | DEFER (depends on Phase D #11) |
| #19 | `manager.ts:366` | Cache `obsId → entityId` map on the `CacheEntry`. Update on add/expire. Replaces the linear scan in `embeddingRecallEntityIds`. | DONE — `obsToEntity` populated on load and via `indexNewObservations`. |
| #15 | `manager.ts:226` | After Tier 1+2, `if (orderedIds.length >= DEFAULT_RECALL_K) return early`. | DONE — guards the Tier 3 LLM call in `recall`. |
| #9 | `manager.ts:108` | Per-instance is correct (one MM per execCtx). Add a comment explaining cache lifecycle so the question doesn't recur. | DONE |

Verify: full memory tests, including `recall`/`recallForInjection`.

---

## Phase F — Investigations

| Comment | File:Line | Plan | Status |
|---|---|---|---|
| #1 | `lib/cli/test.ts:702` | Investigate whether `loadConfig` already merges sibling-dir configs. If yes, delete the duplication and use the existing path. If no, document why it's separate. | DONE — confirmed `loadConfig` only loads a single file; the explicit sibling merge in `test.ts` is correct and already documented in-line. |
| #7 | `manager.ts:36` | Investigate whether tests can construct a `StateStack` and use the production `MemoryIdRef` factory. If yes, delete `createInMemoryRef`. If no, document why. | DONE — production has no factory; the ref is built inline in `forkExecCtx` over an execCtx closure. Reusing it from unit tests would require a fully-built execCtx. Comment added to `createInMemoryRef` explaining why it stays. |
| #10 | `manager.ts:168` | Trace the `!configuredModel` branch. Suspect the cache prevents repeated rebuilds, but worth confirming. Either fix or add clarifying comment. | DONE — confirmed the cache short-circuit means at most one rebuild per memoryId per MemoryManager. Clarifying comment added. |
| #31 | `tests/agency/memory/basic.test.json:13` | Confirm: the previous round proved deterministic mocks DO reach the memory adapter via the registered LLMClient, but only when `AGENCY_USE_TEST_LLM_PROVIDER=1`. Decide: (a) add a README in `tests/agency/memory/` explaining the env var, or (b) make the per-test `agency.json` set the var, or (c) enable mocks unconditionally in the test runner. Prefer (a)+(c) if the runner allows it. | DONE (a) — `tests/agency/memory/README.md` added. (c) deferred: would need a runner-wide opt-in mechanism that doesn't conflict with non-memory tests; tracked as future improvement. |
| #32 | `tests/agency/memory/llm-injection.agency:15` | Convert assertion to LLM-as-judge: assertion checks the captured injected message actually contains the stored fact "pottery", not just the prefix. Read `docs/site/guide/judge.md` (or wherever judge docs live) before converting. | DEFER — `lib/cli/test.ts:769` skips llmJudge tests when `AGENCY_USE_TEST_LLM_PROVIDER=1`, so converting would mean the deeper assertion only runs against real LLMs. Punt to a follow-up that decides whether to (a) accept that runtime cost or (b) extend the deterministic client to support judge calls. |

---

## Phase D — Bigger refactors

| Comment | File:Line | Plan | Status |
|---|---|---|---|
| #26 | `lib/runtime/memory/types.ts:13` | Replace `MemoryMessage` with `smoltalk.Message`. Touches: `extraction.ts`, `compaction.ts`, `manager.ts`, `llmAdapter.ts`. `prompt.ts` no longer needs `toMemoryMessages` — it can pass `messages.getMessages()` directly. The `role` filter in `compactIfNeeded` already works on `smoltalk.Message.role`. | DONE — `MemoryMessage`/`MemoryMessageRole` deleted; all four memory modules + `prompt.ts` now use `smoltalk.Message` directly; tests rewritten with `smoltalk.userMessage`/`assistantMessage`/`systemMessage`/`toolMessage` factories. |
| #20 | `manager.ts:386` | Memory model resolution: read top-level `agency.json.model` (defaultModel from AgencyConfig), use that as the fallback if `memory.model` is not set. Fall back to literal default only if neither is set. Document precedence: `memory.model` > `defaultModel` > hardcoded fallback. | DONE — `model()` now consults `smoltalkDefaults.model` (which carries `defaultModel`); precedence documented on `MemoryConfig.model`. |
| #11 | `manager.ts:195` | Move extraction LLM call to agency code. Add a private function in `stdlib/memory.agency` that takes a prompt + ExtractionType schema and calls `llm(prompt, { responseFormat: ... })`. TS-side `remember()` builds the prompt, hands off to the agency function, receives the typed result, applies it to the graph. This forces structured output and validation through the type system. | DONE — `MemoryManager` now exposes `buildExtractionPromptFor` + `applyExtractionFromLLM`; agency `remember()` wraps the `llm()` call in a `thread {}` block so memory's prompts get an isolated message history but still flow through `runPrompt` for tracing/cost/token tracking. `ExtractionResult` is declared in `stdlib/memory.agency`, so the runtime derives the `responseFormat` Zod schema from the agency type system. The TS-side `_remember` is kept as a convenience wrapper for tests. |
| #17 | `manager.ts:273` | Same pattern for `forget()` LLM call. | DONE — same split (`buildForgetPromptFor` + `applyForgetFromLLM`); agency `forget()` wraps the `llm()` call in a `thread {}`; `ForgetResult` declared as an agency type. |

After phase D, run `make` to rebuild stdlib, then full test suite.

---

## Phase G — Follow-up issues to file

For each, file the GitHub issue using the body below and add a
`TODO(#<issue>)` comment at the listed call site. **Don't open the
issues from the worktree** — these bodies are ready-to-paste.

---

### #4 — perf: vectorize cosine similarity in the memory recall path

**Anchor:** [lib/runtime/memory/embeddings.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/memory-layer/packages/agency-lang/lib/runtime/memory/embeddings.ts) (`cosineSimilarity` + `findSimilar`)

**Problem.** Tier-2 embedding recall scores every stored vector
against the query vector with a hand-rolled JS loop. Per recall:
`O(n · d)` multiplies + adds, where `n` is the number of stored
observations and `d` is the embedding dimension (1536 for
`text-embedding-3-small`). At ~10k observations this is ~15M FP ops
on the JS hot path.

**Goal.** Cut Tier-2 latency by 5–20× without changing the API.

**Candidates.**
- [`simsimd`](https://github.com/ashvardanian/SimSIMD) — native
  bindings, SIMD-optimized cosine, dot, l2. Pure additive dep, no
  index structure needed; drop-in replacement for the inner loop.
- [`vectorlite`](https://github.com/1yefuwang1/vectorlite) — SQLite
  extension; would only make sense if we also move embeddings out of
  the per-memoryId JSON file into SQLite (bigger architectural
  change).
- [`hnswlib-node`](https://github.com/yoshoku/hnswlib-node) —
  approximate nearest-neighbor via HNSW. Lossy but `O(log n)` per
  query. Worth it once `n > ~50k`; needs index-rebuild lifecycle.

**Acceptance.**
- Microbenchmark (k = top-10, n = 100, 1k, 10k) showing the new
  path beats current within `O(d)` per pair.
- Cross-platform packaging is preserved (no breakage on macOS arm64,
  Linux x64, Linux arm64). If a candidate breaks one of these, fall
  back per-platform or document the constraint.
- Public `cosineSimilarity` / `findSimilar` signatures unchanged so
  unit tests in `embeddings.test.ts` continue to pass without edits.

**Related files.** `lib/runtime/memory/embeddings.ts`,
`lib/runtime/memory/manager.ts:embeddingRecallEntityIds`.

---

### #12 — memory: add a benchmark harness for the recall + extraction pipeline

**Anchor:** [lib/runtime/memory/manager.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/memory-layer/packages/agency-lang/lib/runtime/memory/manager.ts) (around `recall` and `remember`)

**Problem.** We have unit tests but no way to detect a recall-latency
regression or to back perf claims (#4, #19) with numbers. Today,
"slow" is a hand-feel.

**Goal.** A repeatable harness that prints per-tier latency and total
cost as a function of graph size and message-history size.

**Sketch.**
- New file `lib/runtime/memory/__bench__/recall.bench.ts` using
  vitest's `bench` mode (no new deps).
- Synthetic graph generator: `makeGraph({ entities, observationsPerEntity })`.
  Use a deterministic seed so numbers are stable.
- Mock the LLMClient so Tier-3 returns a fixed entity name set
  (still measures the round-trip cost of the call wrapper, just
  not the network).
- Mock the embedding client to return random vectors of the
  configured dimension (so cosine has real work to do).
- Bench matrix: `entities ∈ {10, 100, 1000, 10000}` × `recall_query
  ∈ {short, long}`.
- Print per-tier latency (T1, T2, T3) and total via vitest's bench
  reporter.
- Add a `pnpm bench:memory` script.

**Acceptance.** `pnpm bench:memory` produces a table with stable
numbers (run-to-run variance reported); CI does NOT run it (would
slow down the pipeline) but the README section explains how to run
it manually.

---

### #13 — memory: per-step validation and structured tracing for the recall pipeline

**Anchor:** [lib/runtime/memory/manager.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/memory-layer/packages/agency-lang/lib/runtime/memory/manager.ts) (`recall` / `tier1And2` / `llmRecallEntityIds`)

**Problem.** Today a single `recall("foo")` is a black box —
intermediate candidate counts, what each tier contributed, what got
deduped, and what got truncated by `DEFAULT_RECALL_K` are all
invisible to operators. Phase C tightened the I/O boundary with Zod
schemas, but the call-graph itself still has no observability.

**Goal.** Emit one statelog event per tier so operators can see
where recall results came from and why a query missed.

**Sketch.**
- Use the existing `StatelogClient` already on `__ctx` — emit events
  with type `memoryRecallTier` and fields:
  - `tier`: `"structured" | "embedding" | "llm"`
  - `query`: input
  - `candidateCount`: pre-dedup
  - `addedCount`: how many made it past dedup into `orderedIds`
  - `latencyMs`
- Final event: `memoryRecallReturn` with the final entity-id list
  after `slice(0, DEFAULT_RECALL_K)`.
- (Stretch) validate that every entity id we return still exists in
  the graph (catches stale obsToEntity entries).

**Acceptance.** A single `recall("foo")` produces 4 statelog events
in `traces/`. Wire up a small unit test that runs `recall` with a
mocked statelog and asserts the event shape.

---

### #22 — memory: refactor CacheEntry into a class

**Anchor:** [lib/runtime/memory/manager.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/memory-layer/packages/agency-lang/lib/runtime/memory/manager.ts) (the `CacheEntry` type and the methods that take `entry` as first arg)

**Problem.** `CacheEntry` is a record carrying graph + embeddings +
summary + obsToEntity index + memoryId, and ~6 `MemoryManager`
methods take it as the first arg (`autoExtract`, `generateEmbeddings`,
`embeddingRecallEntityIds`, `llmRecallEntityIds`,
`indexNewObservations`, `persist`, the splits added in Phase D).
Every mutation that touches the graph also has to manually update
the embeddings AND the obsToEntity index AND remember to persist.
Easy to forget one.

**Goal.** Encapsulate the invariant "graph + embeddings + obsToEntity
stay in sync" inside one type so `MemoryManager` only orchestrates.

**Sketch.**
- New `class MemoryCacheEntry` exposing:
  - `addExtraction(result, source): { newObsIds, expiredObsIds }`
    (encapsulates `applyExtractionResult` + embedding removal +
    obsToEntity update)
  - `expireObservation(obsId)`
  - `expireRelation(relId)`
  - `lookupEntityIdByObs(obsId): string | undefined`
  - `getGraph()`, `getEmbeddings()`, `getSummary()`,
    `setSummary(...)`, `persist(store)`
- `MemoryManager` shrinks to: load → cache → call entry methods →
  invoke LLM helpers (`buildExtractionPromptFor`, etc.).
- Pairs naturally with Phase E #19 (the obsToEntity index, already
  done — this just makes its maintenance the entry's responsibility
  instead of the manager's).

**Acceptance.** No production behavior change. Test count unchanged.
The diff in `manager.ts` is a net reduction; the new class file has
focused unit tests covering the invariant.

---

### #30 — memory: run compaction out-of-band so it doesn't block `llm()`

**Anchor:** [lib/runtime/prompt.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/memory-layer/packages/agency-lang/lib/runtime/prompt.ts) (the `compactIfNeeded` call inside `_runPrompt`)

**Problem.** Compaction runs synchronously in the agent's `llm()`
hot path. When the threshold trips, the agent waits for one (or two,
if there's an existing summary) extra LLM call before its next
response. For long-running threads this is a visible latency spike.

**Goal.** Move compaction off the request path while preserving
correctness across interrupt/resume.

**Reviewer flagged this as needing discussion.** Open questions
that should be resolved on the issue before any implementation:

1. **Where does the in-flight promise live?** Per-`MemoryManager`
   state, but does it survive interrupt/resume? If the agent is
   suspended mid-compaction, do we wait, abandon, or restart on
   resume?
2. **Concurrent triggers.** If two `llm()` calls trip the threshold
   in the same execCtx, only one compaction should run — needs an
   in-flight flag with proper concurrency.
3. **Failure semantics.** A failing compaction today logs and
   continues. A failing async compaction needs the same forgiving
   behavior, but errors won't be tied to a specific `llm()` call —
   how do we surface them?
4. **State hand-off.** Compaction mutates `entry.summary` and
   triggers a `persist()`. If the main thread mutates the same
   entry concurrently (e.g. another `remember()`), what's the
   ordering rule?

**Sketch (post-discussion).**
- `MemoryManager` gets `compactIfNeededAsync(messages)` that fires
  the work but resolves immediately, plus
  `awaitInFlightCompaction()` for shutdown / save() paths.
- `prompt.ts` calls the async variant — no `await` on the result.
- A guard in `compactIfNeededAsync` short-circuits if a compaction
  is already in flight.

**Acceptance.** `tests/agency/memory/llm-injection.agency` continues
to pass. New test asserts compaction does not block the next
`llm()` call.

---

## NEEDS DISCUSSION (fast-follow, not in this round)

### #27 — `currentContext.ts` singleton

**Reviewer:** Module-level `_current` breaks concurrent users in a
web-server context. Two requests concurrently in `runNode` would
trample each other's `_current` and the second `remember()` would
read the first request's `MemoryManager`.

**Resolution direction (decided):** Add a builtin `getContext()`
function that user agency code can call. Internally, the codegen
lowers `getContext()` directly to the `__ctx` reference that's
already in scope of every compiled function — no actual function
call at runtime, just a compile-time rewrite. Then `stdlib/memory.ts`
takes ctx as an argument, and `stdlib/memory.agency` passes it
explicitly:

```agency
export def remember(content: string) {
  const ctx = getContext()
  if (_shouldRunMemory(ctx)) {
    thread {
      const prompt = _buildExtractionPrompt(ctx, content)
      const result: ExtractionResult = llm(prompt)
      _applyExtractionResult(ctx, result)
    }
  }
}
```

**Why this approach over the alternatives:**
- **vs. exposing `__ctx` directly as a magic identifier.** `__ctx`
  has a double-underscore convention reserved for compiler internals.
  Letting it leak into user code muddies the boundary AND requires
  the typechecker to special-case it (skip declaration check, skip
  state-stack tracking). With `getContext()`, all the magic lives
  inside one builtin's lowering rule.
- **vs. AsyncLocalStorage.** Cleaner — no hidden global, no
  framework-level dependency on async hooks, and easier to reason
  about in tests.
- **vs. compiling TS bindings to receive ctx as a hidden arg.**
  That works, but only fixes the stdlib case. `getContext()` is
  user-facing too: anyone writing custom agency-callable TS code
  can grab ctx the same way.

**Open sub-decisions for the discussion issue:**
1. **Type exposure.** `RuntimeContext` has dozens of internal fields
   (debugger state, statelog client, abort controller, ...). Probably
   a narrower public `Context` type with `{ memoryManager?,
   traceWriter?, ... }` only. The builtin's return type is the public
   shape; the lowered `__ctx` ref is structurally compatible.
2. **Lowering site.** Is this a typechecker-resolved builtin (like
   `nanoid`) or a TS-builder special form (like `__call`)? Builtin
   resolution is simpler; special-form gives us full control over
   the emitted output.
3. **Naming.** `getContext()` vs `ctx()` vs `runtimeContext()`. I'd
   lean `getContext()` for greppability.

**Plan for this round.** File the discussion issue with the above
content. Mark `lib/runtime/currentContext.ts` with a prominent
`TODO(#<issue>): RACE-PRONE — see <issue url>` comment. Phase D's
other refactors (#26, #20, #11, #17) do NOT depend on this being
resolved.

### #30 — Compaction in parallel

Detailed write-up moved into Phase G above.

---

## Verification checklist

Run at the end of each phase:

- [ ] `pnpm tsc --noEmit`
- [ ] `pnpm test:run lib/` (saved to `/tmp/phase-X-tests.log`)
- [ ] `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/memory/`

Final, before pushing:

- [ ] `make` (rebuilds stdlib + templates)
- [ ] `pnpm test:run` (all tests)
- [ ] Commit message lists every comment ID closed

---

## Status legend

- TODO — not started
- WIP — in progress
- DONE — code change merged into the working tree, tests pass
- DEFER — moved to follow-up issue, TODO comment in code
