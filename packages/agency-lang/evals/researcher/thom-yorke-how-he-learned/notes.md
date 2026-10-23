# Baseline, 2026-10-23

Recorded before any change to the research path (ADI-43). One run of
`agency eval run stdlib/agents/researcher.agency:evalMain --suite
evals/researcher --test thom-yorke-how-he-learned`, with `gpt-5-mini` on
`openai-responses` from `agency.json`, Tavily and OpenAI keys in the
environment. Reproduce the numbers with a run and `agency eval grade`
before and after each fix in milestone M3.

## Score 0.798

| grader                    | score | note                                   |
| ------------------------- | ----- | -------------------------------------- |
| answered (must pass)      | pass  |                                        |
| facts                     | 6/8   | missed Brian May; missed "sanctuary"   |
| sourcing                  | 2/4   | one long interview cited; one quote    |
| llm-calls                 | 0.813 | 14 calls                               |
| wall-seconds              | 0.000 | 360 s, the whole six-minute budget     |
| cost-usd                  | 0.984 | $0.29, of which $0.22 is hosted search |
| no-repeated-fetchMarkdown | pass  | one fetch in the whole run             |
| no-repeated-fetch         | pass  |                                        |

## What the trace shows

The research part was short. The researcher made two small calls (the
`whatIAmDoing` note, then a fetch of the Wikipedia page), and then one
call of 2 minutes 46 seconds that used the provider's hosted web search
and wrote the whole answer: 122,000 input tokens, 8,200 output tokens.
The answer was done at 2 minutes 57 seconds with three LLM calls.

Everything after that was the grounding review. `reviewAgent` ran eleven
more calls over three minutes, alternating `whatIAmDoing` and
`saveDraft` as it checked claims one by one, and its twelfth call was
still running when the researcher's six-minute guard tripped. The guard
rejected, `revise` carried the first attempt's answer out as the
salvage, and that is what the graders scored. So the whole wall-clock
score is lost to the review, and no second attempt ever ran.

Two things to know when reading the sourcing score:

- The hosted search tool leaves no `toolCallStart` rows. The answer
  cites nine URLs but the trace shows one fetch, so eight citations came
  from search snippets or from memory. The sourcing checklist cannot tell
  these apart; the `citations-resolve` grader in `lib/researchGraders.ts`
  would, and could be added once `graders.json` can run it or a sixth
  kind exists.
- Of the long interviews in `graderFiles/sources.md`, the answer cited
  none directly. It cited a 2013 Guardian interview and the Exeter alumni
  page instead, both real, both fine for the facts, so the `facts`
  checklist still passed six points.

## Compared with trace wX5GvrUq

The pathology this test was mined from (73 calls, 57 minutes, the same
pages fetched ten times, a second attempt that redid the research) did
not reproduce here under the six-minute, three-dollar cap, because the
cap cut the run before a second attempt could start. What did reproduce:
the review costing more calls and time than the research, and the final
answer quoting almost nothing (one Yorke quote, from the Suspiria press).
ADI-46, ADI-47, and ADI-48 should move the review and second-attempt
numbers; ADI-45 is pinned by the two no-repeat graders.
