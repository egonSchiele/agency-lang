# Results-only eval upload (agency-lang half)

Date: 2026-11-24. Status: design, revised after architecture review and owner review (`2026-11-24-results-only-upload-design-review.md`).
Statelog half: `/Users/adityabhargava/statelog/docs/superpowers/specs/2026-11-24-results-only-upload-design.md`.

## Problem

`agency eval upload` sends every run's full trace. For the Harbor history in ADI-375 (5,000 SWE-bench runs) that is about 10 GB, nearly all of it trace:

| Per 500 runs        | Size    |
| ------------------- | ------- |
| `statelog.jsonl`    | 1.85 GB |
| `annotations.jsonl` | 0.4 MB  |

Two habits of the trace format cause most of it, measured on 60 traces:

- 62%: every `promptCompletion` repeats the whole conversation so far in `messages`, so the trace grows with the square of the call count.
- 31%: each `std::edit` approval carries the file (53 KB on average), and the decision is logged once per handler that sees it.

gzip shrinks a trace about 6×, which still leaves about 1.8 GB. Keeping every event but stripping the heavy payloads still leaves about 1.0 GB and 1.7 million log rows. Shrinking the format itself is separate work (see "Not in this change").

What statelog shows on its eval pages (score, outcome, cost, tokens, models, duration) needs none of that bulk. This change lets a run be uploaded with its results and without its trace: about 25 MB for the same 5,000 runs.

## What the user gets

```
agency eval upload --results-only runs/flash-high
```

Each run sends a small **trace digest** (below) and its annotations, no events. The batch, test, and run pages in statelog show the same numbers as a full upload. The run's trace page shows no events.

Running the command again is harmless. Statelog refuses to mix the two kinds of upload for one run, and the CLI prints the server's message:

```
runs/flash-high/django__django-17087/1: failed: already uploaded with its trace
```

## The trace digest

Today `summarizeOne` (`lib/runDirectory/list.ts`) reads the events and the annotations together. Its fields split cleanly:

| From the events                                                    | From the annotations                                                 |
| ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `input`, `agentName`, `startedAtMs`, last event time, `durationMs` | scores, `gradingPasses`, `gatesPassed`, `labeled`                    |
| `llmCalls`, `toolCalls`, `eventCount`, `codeHash`                  | the run row: `testId`, `batch`, `trial`, `ended`, `benchmark`, suite |
| per-model usage (calls, tokens, cost)                              |                                                                      |
| the trace's own ending (used only when there is no run row)        |                                                                      |

The digest is the left column, computed once from the events:

```ts
export type TraceDigest = {
  version: 1;
  eventCount: number;
  input: string | null;
  agentName: string | null;
  startedAtMs: number | null;
  lastEventAt: string | null; // timestamp of the last event
  durationMs: number;
  llmCalls: number;
  toolCalls: number;
  traceEnding: TraceEnding; // traceEnding({ events }); z.enum in the schema
  codeHash: string | null;
  models: ModelUsage[]; // reasoning left null where the trace didn't record it
};
```

One subtlety: today `modelUsageOf` fills a missing reasoning level from the run row (`runRow.reasoning`), which is an annotation. The digest therefore stores `reasoning: null` where the trace has none. The run-row fallback is applied when the digest is combined with the annotations, followed by `sumModelUsage` so that `null` and the fallback level merge into one entry.

### Code shape

- `digestTrace(events): TraceDigest`, a pure function, in a new `lib/runDirectory/traceDigest.ts`.
- `summarizeOne` becomes `digestTrace(events)` plus `summarizeDigest({ traceId, digest, effective, hasNotes })`. There is one code path, so a digest and its events can't disagree. A new event-derived summary field has to go through the digest.
- `EvalRunInput` takes events or a digest:

  ```ts
  export type EvalRunInput = {
    traceId: string;
    annotations: readonly Annotation[];
    source: string;
    notes?: string | null;
  } & ({ events: readonly EventEnvelope[] } | { digest: TraceDigest });
  ```

- `agency-lang/eval` also exports `TraceDigest` and `TraceDigestSchema` (zod, `.strict()` like `AnnotationSchema`). Not `digestTrace`: like every other trace reading, computing a digest stays inside agency-lang (`public.test.ts` checks it is not exported). Statelog validates incoming digests with the producer's schema instead of keeping its own copy.

The reasoning fallback gives the same result as today's code. `modelUsageOf` fills the fallback per event and then sums; the digest sums first, maps `null` to the fallback, and sums again. Sums are associative, and the equivalence test proves it. Freezing cost is safe too: `cost(event)` reads the cost recorded at run time (`wireAccessors.ts`), not a price table, so a stored digest loses nothing compared with recomputing from events.

### Versioning: digests are stored and can't be regenerated

Statelog keeps digests, and the events behind them are never uploaded. So unlike a summary, a stored digest can't be recomputed after an agency-lang upgrade. Every future agency-lang must keep reading every past digest. The rules:

- `TraceDigestSchema` changes are additive only. New fields are optional. A change that can't be additive bumps `version`, and the schema accepts every version.
- `summarizeEvalRun({ digest })` accepts every past version.
- A summary field added later that comes from the events is `null` (or its empty value) for a digest that predates it.
- **Statelog must run an agency-lang at least as new as the CLI that uploads to it.** This covers the common case of a new CLI and an old server. The schema is `.strict()`, so an older statelog refuses a digest with a field it doesn't know, rather than silently dropping it (zod's default) and losing it for good. You upgrade statelog and rerun, which is harmless because the PUT is an upsert.

Tests: a frozen version-1 digest fixture, committed as JSON, must still parse and summarize. When the schema changes, that fixture stays and a new one is added beside it. The schema rejects an unknown key.

## Upload changes (`lib/cli/eval/upload.ts`, `lib/cli/statelog/evalUploadClient.ts`)

- New flag `--results-only` on `eval upload`, defined in `scripts/agency.ts`.
- New method `EvalUploadClient.putDigest(traceId, digest)`, which sends `PUT /api/projects/:project/traces/:traceId/digest`. The client's `request()` (now `"GET" | "POST"`) and `statelogRequest` (now `"GET" | "POST" | "PATCH" | "DELETE"`) both gain `"PUT"`. The fake client in the upload tests gains `putDigest`.
- No new upload state. Statelog reports a results-only trace as `empty` (it holds no events). The server refuses a mixed upload with a failure envelope: HTTP 200 with `{ success: false, error }`, as statelog does for every refusal. `statelogRequest` already turns that into an `envelope-error`, and `toUploadError` passes the server's text through.
- Per run, `--results-only` plans with a new pure `digestPlan(state)`:

  | Server state                     | Action                                                                                                      |
  | -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
  | `missing`, `empty`               | put the digest (an upsert, so reruns are harmless), then post annotations                                   |
  | `live`, `bulk-prefix`, `invalid` | refuse without sending anything: already uploaded with its trace                                           |

- Without the flag nothing changes. A full upload of a run *with events* onto a results-only trace sees `empty`, tries to append, and fails with the server's message ("uploaded results-only"). A full upload of a run with **zero** events gets `skip` from `eventPlan`, posts its annotations, and reports `present`. That's harmless, because the summary still comes from the digest. It's intended; leave it.
- The outcome line reads `uploaded results only, 3 annotations`. The summary line counts them separately, as `N uploaded results only`.
- Against a statelog without the endpoint, the PUT gets a 404, and `toUploadError` already reports "this statelog host does not support eval upload (upgrade the host)". No custom message.

## Tests

- **Equivalence**, which is the important one: for every run in the existing run-directory fixtures, `summarizeEvalRun({ events })` deep-equals `summarizeEvalRun({ digest: digestTrace(events) })`. Include a run whose trace lacks reasoning levels and whose run row has one.
- **Frozen digest:** the committed version-1 fixture parses and summarizes (see "Versioning").
- `TraceDigestSchema` accepts `digestTrace` output for every fixture, and rejects a missing required field, an unknown key, and an unknown `traceEnding`.
- `digestPlan` covers each server state.
- Upload with `--results-only` against the fake client puts one digest and the annotations per run and never posts events. A failure envelope from `putDigest` or `postEvents` becomes a failed run with the server's message.

## Docs

- `docs/dev/evals/eval-tracking.md`: a short "Results-only uploads" section covering the digest, the flag, and the versioning rules.
- The CLI help text for `eval upload`. Nothing in the user guide.

## Release

This PR ships first and is released as 0.46.0, because statelog needs `TraceDigestSchema` and the digest form of `summarizeEvalRun`. The flag only works once statelog deploys its half.

## Not in this change

- **Shrinking the trace format.** Logging each message once instead of the whole history per call, and logging a file edit once, would cut traces several times over. That's a separate agency-lang change with its own compatibility story (statelog's summarizer and the trace viewer both read `messages`).
- **Results-only for live observability.** `agency run --log` still streams every event. This flag is upload only.
- **Switching a run between results-only and full.** Not supported. Deleting a trace in statelog is a soft delete, and re-uploading a deleted trace ID fails today for full uploads too (statelog #97).
