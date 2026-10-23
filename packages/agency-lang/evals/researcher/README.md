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

Two properties so far.

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
- `no-repeated-fetchMarkdown`, `no-repeated-fetch`: a page fetched twice
  with the same arguments fails the grader.

The baseline before any fix to the research path is recorded in
`thom-yorke-how-he-learned/notes.md`.

The two older tests run `citations-resolve` from `lib/researchGraders.ts`.
It fetches every URL the answer cites and scores the share that resolve.
An answer with no citation fails.

Properties still to add:

- freshness against a dated fact
