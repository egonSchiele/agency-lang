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

Every test also runs `citations-resolve`. It fetches every URL the answer
cites and scores the share that resolve. An answer with no citation fails.

Properties still to add:

- depth matched to the ask (time and cost within a band per test)
- specifics over generalities
- freshness against a dated fact
