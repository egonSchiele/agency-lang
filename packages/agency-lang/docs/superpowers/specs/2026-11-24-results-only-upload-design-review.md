# Review: results-only eval upload (agency-lang half)

Spec: `/Users/adityabhargava/agency-lang/packages/agency-lang/docs/superpowers/specs/2026-11-24-results-only-upload-design.md`
Companion review: `/Users/adityabhargava/statelog/docs/superpowers/specs/2026-11-24-results-only-upload-design-review.md`

Checked against agency-lang `main` (83b40c30e) and statelog `origin/main` (6083394).

The core idea holds up. I compared the digest against `summarizeOne` (`lib/runDirectory/list.ts:167`) field by field, and every value that comes from the events is covered:

- `input`, `agentName`, `startedAtMs`, `durationMs`, `llmCalls`, `toolCalls`, and `codeHash`.
- `eventCount`, which `statusOf` also reads.
- The last event's timestamp, used as the `endedAt` fallback.
- `traceEnding`, used when there's no run row.
- `models`.

Two more things check out:

- **Reasoning fallback.** `modelUsageOf` fills in the fallback per event and then sums. The digest sums first, maps `null` to the fallback, and sums again. Sums are associative, so the result is identical, and the equivalence test will prove it.
- **Freezing cost is safe.** `cost(event)` reads `ev.data.cost.totalCost` as recorded at run time, not a price table (`lib/statelog/wireAccessors.ts:171`). So a stored digest loses nothing compared with today's refresh-from-events.

## Blockers (shared with the statelog half)

### 1. Statelog doesn't send 409s

Statelog route handlers return a `Result`, and `express-file-routing` sends it with `res.json(result)`. A refusal therefore arrives as **HTTP 200** with `{ success: false, error }`. Your client already handles that: `statelogRequest` returns an `envelope-error`, and `toUploadError` passes `serverError` through. So "the CLI prints the server's message" works with no status code involved.

**Fix:** remove "409" from "Upload changes" and Tests. The test becomes "a failure envelope from `putDigest` or `postEvents` becomes a failed run with the server's message".

### 2. "Delete the trace in statelog and upload again" doesn't work

Statelog's trace delete is a soft delete (`deleted_at`), and nothing cascades. A later upload of the same trace ID then fails: `upload-state` says `missing`, the insert conflicts and does nothing, and `resolveLogTrace` returns "Trace not found after creation". The problem exists today for full uploads too.

**Fix:** remove the delete advice from the example error message and from "Not in this change". File a statelog issue for re-upload after delete. Details are in the statelog review.

## Important

### 3. Say what happens when the CLI is newer than statelog

The versioning rules cover new code reading old digests. They don't cover the opposite case, which is the common one here: you release agency-lang, then `agency eval upload --results-only` runs against a statelog that hasn't bumped yet.

zod 4's `z.object` drops unknown keys by default. If v1.1 adds an optional field, an older statelog accepts the digest, stores it **without** that field, and the field is gone for good, because the events are never uploaded.

**Recommendation:** make the schema `.strict()`, the same as `AnnotationSchema`. Then an older statelog refuses with a clear message. You bump statelog and rerun, which is harmless because the PUT is an upsert. Add a test that rejects an unknown key, and add a rule to "Versioning": "statelog must be on an agency-lang at least as new as the CLI that uploads to it".

## Nits

4. **`traceEnding: string`** should be `TraceEnding` (and `z.enum` in the schema). Otherwise statelog accepts any string, and `summarizeDigest` loses the type that `ended` relies on.

5. **PUT isn't wired up yet.** The client's `request()` only takes `"GET" | "POST"` (`evalUploadClient.ts`), and `statelogRequest` takes `"GET" | "POST" | "PATCH" | "DELETE"`. Both need `"PUT"`. Also name `EvalUploadClient.putDigest` and the fake client in the tests in the file list.

6. **Message for an old statelog.** `toUploadError` already turns a 404 that isn't "Project not found" into "this statelog host does not support eval upload (upgrade the host)". A results-only-specific message would need 404 handling per route. Reuse the existing message and drop the custom one.

7. **A full upload onto a results-only trace doesn't always fail.** It fails only when the run has events. With zero events, `eventPlan({ kind: "empty" }, 0)` returns `skip`, annotations are posted, and the run reports `present`. That's harmless, since the summary still comes from the digest. Say so in the bullet so nobody "fixes" it later.

## Not issues

- `digestPlan`: `empty` also covers a full upload of a zero-event (void) run made with `create-empty`. Putting a digest onto it is fine, because a digest with `eventCount: 0` summarizes the same way.
- Memory: the results-only upload still reads one run directory at a time (`uploadRun` → `readRunDirectory`), so the `agency runs list` OOM on 5 GB batches doesn't affect it.
