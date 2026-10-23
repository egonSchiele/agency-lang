# researcher: an eval suite for the web research agent

Scores `std::agents/researcher` through its `evalMain` node
(`stdlib/agents/researcher.agency`). The input has a `task` field, the
research question, and an optional `history` field, earlier turns of the
conversation the question continues. The output is the answer text with
its citations.

## Run it

```bash
node dist/scripts/agency.js eval run stdlib/agents/researcher.agency:evalMain \
  --suite evals/researcher --out runs/researcher
node dist/scripts/agency.js eval grade runs/researcher
```

The tests hit the live web, so scores move as pages change. `evalMain`
caps each run at $3 and six minutes.

## What it measures

Three properties so far.

**No invented detail.** One test asks how to use a feature that does not
exist (an invented feature of a real product). `no-invented-feature` is a
rubric judge given the correct answer, that the feature does not exist. It
fails any answer that describes how to use the invented feature.

**Reading a question in its conversation.** One test seeds two earlier
turns that fix a setting, then asks a question that reads one way on its
own and another way in that setting. `reads-in-context` is a rubric judge
given the conversation and the correct answer for the setting. It fails an
answer that is true of the question alone but wrong for the setting.

**Researching a person, at a sane cost.** `thom-yorke-how-he-learned`
asks how a self-taught musician learned his craft, what he studied, and
where his strengths lie. It is the question shape from a real session
(trace wX5GvrUq, ADI-43) in which the researcher spent 73 LLM calls and
57 minutes on the equivalent question about Grant Sanderson, fetched the
same pages up to ten times, and quoted almost none of what it read. The
test is written as `graders.json`:

- `answered` (must pass): the answer is not empty and not a failure line.
- `facts`: a checklist of eight findable facts, judged against
  `graderFiles/sources.md`, which lists the pages and the quotes.
- `sourcing`: cites two of the long interviews, cites something beyond
  Wikipedia, and quotes Yorke's own words twice.
- `llm-calls`, `wall-seconds`, `cost-usd`: full marks at 8 calls, 90
  seconds, and $0.25; zero at 40 calls, the six-minute cap, and the $3
  cap.
- `no-repeated-<tool>`, one per retrieval tool (the three fetches, the
  three Wikipedia lookups, and the Tavily search): the tool called twice
  with the same arguments fails that grader. They are per tool rather than
  one grader over every tool because the record keeps a 200-character
  preview of the arguments, and the reviewer's `saveDraft` calls, whose
  argument grows at the end, look identical in that preview. Two limits
  to know. The graders compare the argument text as logged, so `fetch`
  and `fetchMarkdown` of one URL, or the same URL with and without a
  trailing slash, count as different calls; the fetch cache in ADI-45
  normalizes URLs and will catch those, and the graders are the floor
  under it. And they count the grounding reviewer's calls along with the
  researcher's, on purpose: the reviewer runs in the same run, so a page
  the researcher fetched and the reviewer fetches again is one wasted
  fetch, and a fix that has the reviewer verify sources should hand it
  the pages or hit the cache, not refetch.
- `citations-resolve`: a `command` grader that runs
  `graderFiles/check_citations.py` over the answer. It fetches every URL
  the answer cites and fails on one that does not exist (a host that does
  not resolve, a 404 or 410) or on an answer that cites nothing. A page
  that answers 403 or 429 or times out may be real and blocking scripts,
  so it is reported and not counted against the answer. This is the one
  grader that can tell an invented interview on a real outlet's domain
  from a real one; the `sourcing` checklist reads only the text.

The baseline before any fix to the research path is recorded in
`thom-yorke-how-he-learned/notes.md`.

The two older tests run `citations-resolve` from `lib/researchGraders.ts`
instead. It fetches every URL the answer cites and scores the share that
resolve. An answer with no citation fails.

Properties still to add:

- cost and time bands on the two older tests; only the Thom Yorke test
  has them
- specifics over generalities, beyond the one quote count in the Thom
  Yorke test
- freshness against a dated fact
