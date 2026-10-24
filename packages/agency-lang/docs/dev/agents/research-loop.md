# The research loop: never review nothing, and fix instead of redo

`stdlib/agents/researcher.agency` answers a question from web sources and
runs the answer through a grounding review (`reviewAgent`) until every
claim is cited. The loop around that review is what trace wX5GvrUq showed
going wrong, and this doc records the two rules that fix it (ADI-47,
ADI-48) and why they live where they do.

## What the trace showed

The first attempt made 30 calls and ended with an empty assistant message:
no text, no tool calls. `revise` handed that empty string to
`checkGrounding`, which ran the reviewer for 37 seconds on a work product
of nothing. The reviewer did the research itself and reported seven gaps.
The second attempt then got those gaps as its whole brief, on the same
thread, with the full tool set and thirty rounds: 43 more calls, the same
pages fetched again, a request of about 600,000 tokens. The reviewer's
findings already held the facts the final answer was made of, with five
URLs; the second attempt spent 43 calls re-finding them.

## Rule 1: an empty answer is never reviewed

`answerIsEmpty` is true for `null`, and for any answer under
`MIN_ANSWER_CHARS` (20) once trimmed: an empty string, or a few words
where a cited answer was asked for. When the first attempt's answer is
empty, the block asks once more on the same thread, with no tools
(`NO_ANSWER_FOLLOWUP`: "You returned no answer. Write your answer now from
what you have read, citing sources."). The model has its sources in
context and nothing else it can do, so it answers. That reply is the
attempt. A second empty reply is `failure("the model returned no answer
twice")`.

The failure has to end the loop rather than be reviewed, so
`checkGrounding` accepts a failure as it stands. `revise` returns it,
`researchLoop` returns it, and `@guard` reports it to the caller through
`_budgetOutcome` with its message. The caller sees why there is no answer
instead of a review of nothing.

## Rule 2: a rejected answer is fixed, not redone

The block keeps the last attempt's answer in `lastAnswer`, a local of
`researchLoop` that the block assigns; `revise` hands the next attempt
only the critique. A later attempt sends `fixPrompt(lastAnswer,
critique)`: the answer, the findings, and the instruction to patch those
gaps and keep everything else, using a fact the review gives with its
source as given and fetching only what the review does not give. It runs
in a `subthread`, so the research thread does not grow by the attempt,
under `FIX_ROUNDS` (8) tool rounds, where the first attempt has thirty. A
fix that comes back empty keeps the answer it was given.

For the review's facts to be usable, a finding can carry where it was
checked: `Feedback` in `std::agents/lib/feedback` has `source?: string`,
the reviewer's prompt asks for it, `groundingInstruction` repeats the ask,
and `renderFeedback` prints it as `(source: <url>)` at the end of the
line. The field is optional, so every agent that builds findings by hand
is unchanged.

`maxAttempts` defaults to 3 instead of 2. With a full redo, two attempts
meant one redo and that was the limit worth paying for. With a fix pass,
the round cap per attempt is the real bound, and a third short attempt is
cheap.

## Why not in `revise`

The ticket asked whether the empty-answer rule belongs in `revise`, so
every loop would get it. It does not: the retry is a model call with a
prompt and no tools, and `revise` is a strategy over any block, used by
the Agency coding agent for a writer whose result is code. A
`retryIfEmpty` in a generic loop would need to know what "empty" means
for that result and how to ask again. Both rules are the researcher's,
so they are in the researcher, and the module comment says so.

## Tests

`tests/agency/agents/researcher.agency`, under scoped mocks (`researcher`
for the agent's calls, `review` for the check's):

- `emptyFirstAnswerIsAskedAgain`: the first reply is empty, the follow-up
  is text, and the one review mock sees the text. If the empty answer
  were reviewed, the researcher's second mock would go to a second
  attempt and the old loop would report "it returned no answer".
- `twoEmptyAnswersAreAFailure`: two empty replies, no review mock at all,
  so a review of nothing would fail the test for want of a mock.
- `rejectedAnswerIsFixedNotRedone`: one answer missing a fact, a finding
  with the fact and its source, and the fix is one call whose reply is the
  merged answer. The mock counts are exact, so a second research pass
  would run out of mocks, and the node checks the research thread never
  saw the fix's brief.

The eval `evals/researcher/thom-yorke-how-he-learned` measures the loop
against a live model; its baseline notes say a review that cost more
calls than the research and a second attempt that started over are what
these two rules should move.
