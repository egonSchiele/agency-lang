# Implementation plan — Memory recall tier overhaul

Fixes the three independent recall failures we identified for the
`recall("Tell me something about Maggie")` scenario:

1. **Tier 1** uses a single-direction substring check, so
   natural-language queries that *mention* an entity name never match.
2. **Tier 2** embeds bare observation text (`"loves to weave"`), so
   query embeddings that anchor on the entity name (`"Tell me
   something about Maggie"`) have no useful similarity to anything we
   stored.
3. **Tier 3** is gated on Tiers 1+2 returning fewer than `K`
   candidates, AND it does both candidate generation and relevance
   filtering in one prompt over the full graph — flaky and expensive.

After this change, recall reliably surfaces entities by descriptive
queries, with a clear funnel of cheap → expensive stages and a
deterministic precision filter at the end.

---

## Background

### What's there today

`MemoryManager.recall` ([lib/runtime/memory/manager.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/memory-layer/packages/agency-lang/lib/runtime/memory/manager.ts#L346)):

```ts
async recall(query: string): Promise<string> {
  const entry = await this.getEntry();
  const orderedIds = await this.tier1And2(entry, query);
  if (orderedIds.length < DEFAULT_RECALL_K) {
    try {
      const tier3 = await this.llmRecallEntityIds(entry, query, model);
      for (const id of tier3) if (!orderedIds.includes(id)) orderedIds.push(id);
    } catch (err) { /* warn */ }
  }
  const topK = orderedIds.slice(0, DEFAULT_RECALL_K);
  const entities = topK.map((id) => entry.graph.getEntity(id)).filter(...);
  return formatRetrievalResults(entry.graph, entities);
}
```

Failure modes for the user-reported case (`recall("Tell me something
about Maggie")`):

- Tier 1 (`structuredLookup` in [retrieval.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/memory-layer/packages/agency-lang/lib/runtime/memory/retrieval.ts#L9)) checks `entity.name.includes(query)`. `"maggie".includes("tell me something about maggie")` is false.
- Tier 2 embeds `"loves to weave"` (the bare observation content). Cosine similarity with the embedding of `"Tell me something about Maggie"` is essentially noise — the user's name doesn't appear in the indexed text at all.
- Tier 3 sees the whole graph and is asked to do candidate generation + relevance scoring. With `gpt-4o-mini`, the result varies across runs even though the underlying graph is identical.

### Constraints we want to preserve

- Storage layout stays unchanged — no migration of existing graph JSON.
- `recallForInjection` keeps its low-latency Tiers-1+2-only path.
- `_remember` / `_forget` API surface unchanged.
- Tier costs stay ordered (microseconds → embedding call → LLM call).

---

## Design

### Tier 1 — bidirectional substring with word boundaries

`structuredLookup` becomes a token-aware bidirectional matcher:

```ts
function structuredLookup(graph, query, options?) {
  const lower = query.toLowerCase();
  const queryTokens = tokenize(lower); // words ≥ 3 chars, no stop words

  return graph.getEntities().filter((entity) => {
    if (options?.source && entity.source !== options.source) return false;

    const nameLower = entity.name.toLowerCase();
    if (
      isMeaningfulName(nameLower) &&
      (containsToken(lower, nameLower) ||      // query mentions name
       containsToken(nameLower, lower))         // name contains query
    ) return true;

    if (entity.type.toLowerCase() === lower) return true;

    for (const obs of graph.getCurrentObservations(entity.id)) {
      const c = obs.content.toLowerCase();
      if (containsToken(c, lower) || containsToken(lower, c)) return true;
    }

    return false;
  });
}
```

Helpers:

- **`containsToken(haystack, needle)`** — `\b{escapeRegex(needle)}\b` test.  Word-boundary based, case-insensitive (callers lowercase already).
- **`isMeaningfulName(s)`** — length ≥ 3 AND not a member of a small stop-word set (`"the"`, `"and"`, `"you"`, etc.).

This kills the "AI matches rain" false-positive class and recovers the
common case (`recall("Maggie")` and `recall("Tell me about Maggie")` both work).

### Tier 2 — contextualized embedding input

Storage stays unchanged. The `Observation` on disk remains
`{ id, content: "loves to weave", validFrom, validTo }`. Only the
*string fed to the embedder* changes.

```ts
function buildEmbedText(entity: Entity, obs: Observation): string {
  return `${entity.name} (${entity.type}): ${obs.content}`;
}

private async generateEmbeddings(entry, observationIds) {
  for (const obsId of observationIds) {
    const entity = findOwningEntity(entry, obsId); // via obsToEntity map
    const obs = findObservation(entity, obsId);
    if (!entity || !obs) continue;
    try {
      const vector = await this._embed(buildEmbedText(entity, obs), {
        model: this.config.embeddings?.model,
      });
      entry.embeddings.addEntry(obsId, vector);
    } catch (err) { /* best-effort */ }
  }
}
```

The query embedding stays as-is (just the raw query string). Cosine
similarity now operates between two strings that share entity-name
signal when the query mentions the entity, *and* between two strings
that share fact signal when the query is fact-shaped.

#### Embedding format versioning

Introduce an explicit `formatVersion: 2` on the `EmbeddingIndex` so we
can detect indexes built with the old (bare-content) text and discard
them on load:

```ts
type EmbeddingIndex = {
  formatVersion?: number; // undefined or < 2 = legacy bare-content format
  model: string;
  entries: EmbeddingEntry[];
};
```

In `MemoryManager.getEntry`:

```ts
const isCurrentFormat =
  embeddingIndex && (embeddingIndex.formatVersion ?? 1) >= 2;
if (
  embeddingIndex &&
  isCurrentFormat &&
  (!configuredModel || embeddingIndex.model === configuredModel)
) {
  embeddings = EmbeddingManager.fromIndex(embeddingIndex);
} else {
  embeddings = new EmbeddingManager();
}
```

`EmbeddingManager.toIndex()` always emits `formatVersion: 2`. Old
on-disk indexes silently rebuild on first write. This avoids a
migration script and keeps invariants simple.

### Tier 3 — pure filter over a bounded candidate set

Replace "LLM picks names from full graph" with "LLM picks ids from a
candidate list":

#### New prompt ([retrieval.mustache](file:///Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/memory-layer/packages/agency-lang/lib/templates/prompts/memory/retrieval.mustache))

```
You are filtering candidate entities from a knowledge graph for relevance to a query.

Candidate entities:
{{{candidates:string}}}

Query: {{{query:string}}}

Return a JSON array of entity ids (strings) for the candidates that are actually relevant to the query. Order does not matter. Return [] if none are relevant. Return only the JSON array — no prose.

Example output: ["entity-1", "entity-7"]
```

`candidates` is a per-entity formatted block built from the entity ids
we want filtered, e.g.:

```
entity-1: Maggie (Person) — loves to weave; loves to read romance books
entity-3: Bob (Person) — plays guitar
```

#### New helper

```ts
private buildCandidateIndex(graph: MemoryGraph, ids: string[]): string {
  const lines: string[] = [];
  for (const id of ids) {
    const e = graph.getEntity(id);
    if (!e) continue;
    const obs = graph.getCurrentObservations(id).map((o) => o.content).join("; ");
    lines.push(obs ? `${e.id}: ${e.name} (${e.type}) — ${obs}` : `${e.id}: ${e.name} (${e.type})`);
  }
  return lines.join("\n");
}
```

#### New rerank function

```ts
private async llmFilterCandidates(
  entry: CacheEntry,
  query: string,
  candidateIds: string[],
  model: string,
): Promise<string[]> {
  if (candidateIds.length === 0) return [];
  const prompt = retrievalTemplate({
    candidates: this.buildCandidateIndex(entry.graph, candidateIds),
    query,
  });
  const response = await this._text(prompt, { model });
  const ids = parseStringArray(response);
  if (!ids) return [];
  // Reject hallucinated ids: filter to the ones we actually offered.
  const offered = new Set(candidateIds);
  return ids.filter((id) => offered.has(id));
}
```

The id-filtering step makes hallucinations harmless: any id the LLM
invents gets dropped. Returning ids (not names) eliminates the
case/spelling drift class of bugs in the current implementation.

### New recall flow

```ts
async recall(query: string, options?: { model?: string }): Promise<string> {
  const entry = await this.getEntry();

  // Stage 1+2: gather candidates.
  let candidateIds = await this.tier1And2(entry, query);

  // Fallback: if the cheap tiers found nothing AND the graph is small
  // enough to send wholesale, give Tier 3 the whole list. On larger
  // graphs we accept "no recall" rather than blow tokens on a giant
  // candidate list — Tiers 1+2 should have surfaced something.
  const FALLBACK_THRESHOLD = 50;
  if (candidateIds.length === 0) {
    const all = entry.graph.getEntities();
    if (all.length === 0) return "";
    if (all.length <= FALLBACK_THRESHOLD) {
      candidateIds = all.map((e) => e.id);
    } else {
      return "";
    }
  }

  // Stage 3: LLM relevance filter (always runs when we have candidates).
  const model = options?.model ?? this.model();
  let relevantIds: string[];
  try {
    relevantIds = await this.llmFilterCandidates(entry, query, candidateIds, model);
  } catch (err) {
    console.warn(
      `[memory] tier 3 (LLM filter) failed for query=${JSON.stringify(query)}: ${(err as Error).message}`,
    );
    // Fail open: return the cheap-tier ordering rather than nothing.
    relevantIds = candidateIds;
  }

  const topK = relevantIds.slice(0, DEFAULT_RECALL_K);
  const entities = topK
    .map((id) => entry.graph.getEntity(id))
    .filter((e): e is NonNullable<typeof e> => e !== null);
  return formatRetrievalResults(entry.graph, entities);
}
```

`recallForInjection` stays Tiers-1+2-only — it's intentionally
latency-sensitive and skips the LLM round-trip.

---

## Implementation steps

### Step 1 — Tier 1 rewrite

**File:** [lib/runtime/memory/retrieval.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/memory-layer/packages/agency-lang/lib/runtime/memory/retrieval.ts)

- Add `containsToken(haystack, needle)` (regex with `\b...\b`,
  escaping needle).
- Add `isMeaningfulName(s)` (length ≥ 3 AND not in a small stop-word
  set hardcoded inline — `the`, `and`, `you`, `for`, `not`, …).
- Rewrite `structuredLookup` to use both directions on entity name
  and observation content; keep type as exact equality.
- No API change — same signature, same return type.

**File:** `lib/runtime/memory/retrieval.test.ts` (extend)

- Cases covering the user-reported failure (long descriptive query
  matches the entity by name).
- Cases covering false-positive guards (short stop-word names skipped,
  word boundaries enforced).

### Step 2 — Tier 2 contextualized embeddings

**File:** [lib/runtime/memory/manager.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/memory-layer/packages/agency-lang/lib/runtime/memory/manager.ts)

- Add private helper `buildEmbedText(entity, obs)`.
- Modify `generateEmbeddings` to look up the owning entity for each
  observation id (via `entry.obsToEntity` + `entry.graph.getEntity`)
  and pass `buildEmbedText(entity, obs)` to `_embed` instead of the
  raw `obs.content`.
- Existing `obsToEntity` reverse index is built in `getEntry`; reuse
  it. If lookup fails (shouldn't happen — the obs id was just added),
  skip with a `console.warn`.

**File:** [lib/runtime/memory/types.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/memory-layer/packages/agency-lang/lib/runtime/memory/types.ts)

- Add optional `formatVersion?: number` to `EmbeddingIndex` and to
  `EmbeddingIndexSchema` (`z.number().optional()`).

**File:** [lib/runtime/memory/embeddings.ts](file:///Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/memory-layer/packages/agency-lang/lib/runtime/memory/embeddings.ts)

- `toIndex()` returns `{ formatVersion: 2, model, entries }`.
- `fromIndex` ignores the field (no behavioral change here — version
  policy is enforced at the manager's load site).

**File:** `lib/runtime/memory/manager.ts` (`getEntry`)

- Treat any embedding index without `formatVersion >= 2` as legacy
  and start with an empty `EmbeddingManager` (the next `remember`
  will rebuild with the new format). Documented in a comment so it
  doesn't look like a bug.

**File:** `lib/runtime/memory/embeddings.test.ts` (extend)

- A test that round-trips an index with `formatVersion: 2`.

**File:** `lib/runtime/memory/manager.test.ts` (extend)

- Cover that legacy indexes (no `formatVersion`) load as empty.
- Cover that `generateEmbeddings` calls `_embed` with the
  contextualized string (assert via the mock LLM client).

### Step 3 — Tier 3 rewrite (filter, not generate)

**File:** [lib/templates/prompts/memory/retrieval.mustache](file:///Users/adityabhargava/agency-lang/packages/agency-lang/.worktrees/memory-layer/packages/agency-lang/lib/templates/prompts/memory/retrieval.mustache)

Replace the prompt body with the candidate-filter version above.
Variables now: `candidates: string`, `query: string`.

**File:** `pnpm run templates` regenerates the matching `.ts`.

**File:** `lib/runtime/memory/manager.ts`

- Add `buildCandidateIndex(graph, ids)`.
- Replace `llmRecallEntityIds` with `llmFilterCandidates` using the
  new prompt and id-based parsing + offered-id filtering.
- Delete the old `buildRetrievalPrompt` import / usage if unused
  elsewhere. (`buildRetrievalPrompt` lives in `retrieval.ts`; check
  remaining call sites — likely only `manager.ts` used it.)

**File:** `lib/runtime/memory/retrieval.ts`

- Remove the now-unused `buildRetrievalPrompt` if no other caller
  depends on it (a `grep` pass confirms before deletion).

### Step 4 — Recall flow restructure

**File:** `lib/runtime/memory/manager.ts` — replace `recall` body with
the version in the Design section above. `recallForInjection` is left
alone.

Add a `FALLBACK_GRAPH_SIZE_LIMIT` constant (50) at the top of the
file with a comment explaining its purpose.

### Step 5 — Update / extend tests

**File:** `lib/runtime/memory/manager.test.ts`

Add cases for:

- `recall("Tell me something about Maggie")` after a single
  `remember("Maggie loves to weave")` returns the Maggie entity
  (Tier 1 hit via the contextualized observation match).
- `recall(...)` after a process restart (simulated by constructing a
  new `MemoryManager` against the same store) returns the same
  entity. This is the regression test for the user-reported bug.
- `recall(...)` on a graph with > 50 entities and no Tier 1+2 hits
  returns "" (fallback skipped).
- Tier 3 LLM hallucinating an unknown id is dropped, not returned.

**File:** `tests/agency/memory/basic.agency` and the broader
`tests/agency/memory/` suite — should keep passing without changes.

### Step 6 — Verify nothing else regressed

- `pnpm tsc --noEmit`
- `pnpm test:run`
- `make` (rebuilds stdlib + templates including the regenerated
  `retrieval.ts`)
- `AGENCY_USE_TEST_LLM_PROVIDER=1 pnpm run agency test tests/agency/memory/`
- `pnpm run lint:structure`

---

## Open questions to lock in before merging

1. **Fallback graph-size limit.** I picked 50 based on intuition. The
   right ceiling is "candidate index fits cheaply in the LLM context
   without dominating the prompt." Could parameterize via
   `memory.recallFallbackLimit` but that's premature; ship the
   constant.

2. **Source filter parity.** `structuredLookup` accepts an
   `options.source` filter today. The new flow needs to honor it
   too, but no caller passes it. We'll keep the parameter and apply
   it only in the Tier 1 stage; document that it does not constrain
   Tier 3.

3. **Re-embed on entity rename.** Future concern. There's no API for
   entity rename today. When/if one lands, it must trigger
   `generateEmbeddings` for all observations of that entity (bumping
   the `formatVersion` again or hashing the source string would also
   work).

4. **Tier 3 temperature.** Worth setting `temperature: 0` on the
   relevance filter call. Defer — `_text` doesn't currently expose
   temperature. Tracking separately.

---

## Verification matrix

| Scenario | Expected after change |
|---|---|
| `recall("Maggie")` | Tier 1 substring hit on entity name. ✓ |
| `recall("weave")` | Tier 1 substring hit on observation. ✓ |
| `recall("Tell me something about Maggie")` | Tier 1 word-boundary hit (`\bmaggie\b` inside query). ✓ |
| Same after process restart | Tier 1 still hits — Tier 1 is purely structural, no embedding rebuild needed. ✓ |
| `recall("hobbies")` (no Tier 1 match, embeddings present) | Tier 2 hit on contextualized embedding. ✓ |
| `recall("hobbies")` after restart with old-format embeddings | Index discarded, Tier 2 returns nothing → Tier 3 over fallback (small graph) finds Maggie. ✓ |
| `recall("nonsense xyz")` on small graph | Tier 1+2 empty → fallback to all entities → Tier 3 returns []. ✓ |
| `recall("nonsense xyz")` on graph with > 50 entities | Tier 1+2 empty → no fallback → returns "". ✓ |
| Tier 3 LLM returns `["bogus-id"]` | Filtered out, returns []. ✓ |

---

## File-by-file diff summary

| File | Change |
|---|---|
| `lib/runtime/memory/retrieval.ts` | Rewrite `structuredLookup` (bidirectional + word boundaries + stop words). Possibly delete `buildRetrievalPrompt` if no longer used. |
| `lib/runtime/memory/retrieval.test.ts` | New cases for both directions and false-positive guards. |
| `lib/runtime/memory/types.ts` | Add `formatVersion?: number` to `EmbeddingIndex` + schema. |
| `lib/runtime/memory/embeddings.ts` | `toIndex()` emits `formatVersion: 2`. |
| `lib/runtime/memory/embeddings.test.ts` | Round-trip test for `formatVersion`. |
| `lib/runtime/memory/manager.ts` | Add `buildEmbedText`, contextualize `generateEmbeddings`, version check in `getEntry`, replace `llmRecallEntityIds` with `llmFilterCandidates`, add `buildCandidateIndex`, restructure `recall`. |
| `lib/runtime/memory/manager.test.ts` | Coverage for the new recall flow + the user-reported regression. |
| `lib/templates/prompts/memory/retrieval.mustache` | New prompt: candidate-list filter, returns ids. |
| `lib/templates/prompts/memory/retrieval.ts` | Auto-regenerated by `pnpm run templates`. |

---

## Effort estimate

Medium. The hard part (design) is locked in. Implementation is roughly:

- Step 1 (Tier 1): ~40 lines + tests.
- Step 2 (Tier 2): ~25 lines + small schema + tests.
- Step 3 (Tier 3): new prompt + ~30 lines + tests.
- Step 4 (recall flow): ~40 lines.
- Step 5 (tests): ~80 lines across files.
- Step 6 (verification): commands above.

One focused session, including verification.
