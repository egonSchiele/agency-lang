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
test is a `graders.ts` so it can share `citations-resolve` with the two
older tests. Its checklist and band graders are `graders.json` specs passed
to `buildGraders`, and only the no-repeat grader is written by hand:

- `answered` (must pass): the answer is not empty and not a failure line.
- `facts`: a checklist of eight findable facts, judged against
  `graderFiles/sources.md`, which lists the pages and the quotes.
- `sourcing`: cites two of the long interviews, cites something beyond
  Wikipedia, and quotes Yorke's own words twice.
- `llm-calls`, `wall-seconds`, `cost-usd` (weight 0.1 each): full marks
  at 8 calls, 90 seconds, and $0.25; zero at 40 calls, the six-minute
  cap, and the $3 cap.
- `no-repeated-retrieval` (weight 0.3): a retrieval tool (the three
  fetches, the three Wikipedia lookups, the Tavily and Brave searches)
  called twice with the same arguments fails. It leaves `saveDraft` out,
  because a draft that grows at the end looks the same in the record's
  200-character argument preview. Two limits to know. It compares that
  preview, so two URLs that differ only after the 200th character count
  as one call, and one URL spelled two ways (a trailing slash, `fetch`
  then `fetchMarkdown`) counts as two; the fetch cache in ADI-45
  normalizes URLs and will catch the second, and this grader is the
  floor under it. It counts every retrieval in the run, so any agent the
  researcher calls is counted with it.
- `citations-resolve`: the shared grader described below. This is the
  one grader that can tell an invented interview on a real outlet's
  domain from a real one; the `sourcing` checklist reads only the text.

The baseline before any fix to the research path is recorded in
`thom-yorke-how-he-learned/notes.md`.

Every test runs `citations-resolve` from `lib/researchGraders.ts`. It
fetches every URL the answer cites. A URL that does not exist (a host
that does not resolve, a 404, a 410) is an invented citation and costs
its share of the score. One that answers 403 or 429, a server error, or
a timeout may be real and blocking scripts, so it is reported and costs
nothing. An answer that cites no URL fails, and so does one where nothing
could be checked.

Properties still to add:

- cost and time bands on the two older tests; only the Thom Yorke test
  has them
- specifics over generalities, beyond the one quote count in the Thom
  Yorke test
- freshness against a dated fact
