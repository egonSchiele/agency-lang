# Baseline, 2026-10-23

Recorded before any change to the research path (ADI-43). One run of
`agency eval run stdlib/agents/researcher.agency:evalMain --suite
evals/researcher --test thom-yorke-how-he-learned`, with `gpt-5-mini` on
`openai-responses` from `agency.json`, Tavily and OpenAI keys in the
environment. The run is graded with the graders as they stand after
review (`agency eval grade <run> --suite evals/researcher`). Reproduce
the numbers with a run and `agency eval grade` before and after each fix
in milestone M3.

## Score 0.791

| grader               | score | note                                        |
| -------------------- | ----- | ------------------------------------------- |
| answered (must pass) | pass  |                                             |
| facts                | 6/8   | missed Brian May; missed "sanctuary"        |
| sourcing             | 2/4   | no listed long interview; quote count flips |
| llm-calls            | 0.813 | 14 calls                                    |
| wall-seconds         | 0.000 | 360 s, the whole six-minute budget          |
| cost-usd             | 0.984 | $0.29, of which $0.22 is hosted search      |
| no-repeated-retrieval | pass | one fetch in the whole run                  |
| citations-resolve    | 0.909 | 11 cited, one missing: an Abingdon School PDF is 404 |

## What the trace shows

The research part was short. The researcher made two small calls (the
`whatIAmDoing` note, then a fetch of the Wikipedia page), and then one
call of 2 minutes 46 seconds that used the provider's hosted web search
and wrote the whole answer: 122,000 input tokens, 8,200 output tokens.
The answer was done at 2:57 with three LLM calls.

The grounding review then ran from 2:57 to 4:25, 88 seconds, which is
the half of the answer's time that `checkGrounding` gives it. It made
eleven calls, alternating `whatIAmDoing` and `saveDraft` as it checked
claims one by one, and finished on its own, inside its budget, with one
finding marked as an error: the answer leaned on secondary summaries
and should cite primary interviews and quote exact lines. So the review
rejected the answer.

A second attempt started at 4:25 with that critique. It was one long
call, again using hosted search, and it was still running at 6:00 when
the researcher's guard tripped and cancelled it. `revise` handed back
the first attempt's answer, the last one that completed, with the guard's
"may be unfinished" line appended, and that is what the graders scored.

An earlier version of this file said the review overran and no second
attempt ran. That was a misreading of the trace; the review's own guard
behaved as the code says.

Three things to know when reading the sourcing scores:

- The hosted search tool leaves no `toolCallStart` rows. The answer
  cites eleven URLs but the trace shows one fetch, so ten citations came
  from search snippets or from memory. `citations-resolve` found one that
  does not exist, a PDF on the Abingdon School site that answers 404; the
  other ten load. The `sourcing` checklist cannot tell a fetched page
  from a remembered one; the trace can, once a fix routes fetches through
  the tools.
- The judge's answer to the "quotes Yorke twice" point flips between
  gradings of this same run (one quote or two), so read `sourcing` as 2 or
  3 of 4.
- Of the long interviews in `graderFiles/sources.md`, the answer cited
  none. It cited a 2013 Guardian interview and the Exeter alumni page
  instead, both real, both fine for the facts, so the `facts` checklist
  still passed six points.

## Compared with trace wX5GvrUq

The pathology this test was mined from (73 calls, 57 minutes, the same
pages fetched ten times, a second attempt that redid the research) did
not reproduce in full under the six-minute, three-dollar cap: the cap cut
the second attempt off at 95 seconds. What did reproduce: a review that
costs more calls than the research (11 against 3), a second attempt that
starts the research over instead of patching the first answer, and a
final answer quoting almost nothing. ADI-46, ADI-47, and ADI-48 should
move the review and second-attempt numbers; ADI-45 is pinned by
`no-repeated-retrieval`, with the limits the suite README lists.
