# researcher: an eval suite for the web research agent

Scores `std::agents/researcher` through its `evalMain` node
(`stdlib/agents/researcher.agency`). The input is one field, `task`, the
research question; the output is the answer text with its citations.

## Run it

```bash
node dist/scripts/agency.js eval run stdlib/agents/researcher.agency:evalMain \
  --suite evals/researcher --out runs/researcher
node dist/scripts/agency.js eval grade runs/researcher
```

The tests hit the live web, so scores move as pages change. Each run is
capped at $3 and six minutes by `evalMain`.

## What it measures

The first property is hallucination. A trap test asks about something that
does not exist (an invented feature of a real product). `no-invented-feature`
is a rubric judge that holds the truth and fails any answer that describes
how to use the thing; `citations-resolve` fetches every URL the answer cites
and scores the share that resolve, and fails an answer with no citation.

Properties still to add, from the design discussion: depth matched to the
ask (time and cost within a band per test), specifics over generalities,
freshness against a dated fact, and reading a question in the context of
the conversation before it.
