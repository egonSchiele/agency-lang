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
| #11 | `manager.ts:195` | Move extraction LLM call to agency code. Add a private function in `stdlib/memory.agency` that takes a prompt + ExtractionType schema and calls `llm(prompt, { responseFormat: ... })`. TS-side `remember()` builds the prompt, hands off to the agency function, receives the typed result, applies it to the graph. This forces structured output and validation through the type system. | TODO (carried) |
| #17 | `manager.ts:273` | Same pattern for `forget()` LLM call. | TODO (carried) |

After phase D, run `make` to rebuild stdlib, then full test suite.

---

## Phase G — Follow-up issues to file

For each, write a short GitHub issue body and link from a `TODO(#issue-num)` comment in the relevant file. **Don't open the issues from the worktree** — list them here so the user can open them.

| Comment | File:Line | Issue title (suggested) | Notes |
|---|---|---|---|
| #4 | `embeddings.ts:3` | "perf: vectorize cosine similarity" | Mention `simsimd`, `vectorlite`, `hnswlib-node` as candidates. Current impl is pure JS, O(d) per pair. |
| #12 | `manager.ts:190` | "memory: add benchmark harness for the recall/extraction pipeline" | Sketch: time each tier separately, varying graph size and message-history size. |
| #13 | `manager.ts:212` | "memory: add per-step validation and structured tracing for the recall pipeline" | Partly addressed by Phase C Zod work, but the call-graph is still hard to inspect. |
| #22 | `manager.ts:496` | "memory: refactor CacheEntry into a class with methods" | Many functions take `entry` as first arg — class methods would clean this up. Combine with Phase E dedup. |
| #30 | `prompt.ts:163` | "memory: run compaction out-of-band so it doesn't block llm() calls" | Reviewer says "warrants a bigger discussion" — explicitly NOT for this PR. |

---

## NEEDS DISCUSSION (fast-follow, not in this round)

### #27 — `currentContext.ts` singleton

**Reviewer:** Module-level `_current` breaks concurrent users in a web-server context.

**Reviewer's clarification:** Agency functions get `__ctx` via the
compiled `__ctx` var, but their TypeScript equivalents
(`stdlib/memory.ts`) don't. There's no precedent for stdlib TS code
needing the runtime ctx. Possible directions:
- Allow users to read `__ctx` directly in agency code and pass it in
  (with a warning that doing so is dangerous).
- Compile stdlib TS bindings to receive `__ctx` as a hidden second
  argument (parallel to how agency-defined functions get it).
- Use AsyncLocalStorage (the original recommendation), but that has
  its own portability/observability tradeoffs.

**Plan:** File a discussion issue ("memory: how should stdlib TS
functions access the runtime context?") summarizing the three
directions. Until resolved, mark `currentContext.ts` with a
prominent `TODO(#issue-num): RACE-PRONE — see discussion` comment.
Phase D's other refactors (#26, #20, #11, #17) do NOT depend on this
being resolved.

### #30 — Compaction in parallel

Already in Phase G as a follow-up; reviewer explicitly flagged it.

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
