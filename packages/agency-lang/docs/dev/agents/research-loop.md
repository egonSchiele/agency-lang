# The researcher: one pass, no review

`stdlib/agents/researcher.agency` answers a question from web sources in
one research pass and returns the model's reply as written. Nothing
reviews the answer afterwards.

## The rule: an empty answer is asked for once more

`answerIsEmpty` is true for `null`, and for a first reply under
`MIN_ANSWER_CHARS` (20) once trimmed: an empty string, or a few words
where a cited answer was asked for. When the first reply is empty, the
researcher asks once more on the same thread, with no tools
(`NO_ANSWER_FOLLOWUP`: "You returned no answer. Write your answer now from
what you have read, citing sources."). The model has its sources in
context and nothing else it can do, so it answers.

Any non-blank second reply is the answer, however short:
`Yes (https://x.io).` is 19 characters and a real answer. Only a blank
second reply is `failure("the model returned no answer twice")`, and
`@guarded` passes that failure to the caller unchanged, so the caller sees
why there is no answer.

The answer is saved with `saveDraft` before it is returned, so a budget
that runs out after the pass still has it.

## Why there is no grounding review

Do not add a review-and-fix loop back without new evidence. An eval of ten
real research questions, run on GLM 5.3 and GPT-6.1 Sol with and without a
grounding review (`reviewAgent` checking each claim, then a fix pass for
any gap), showed the review made answers worse, slower, and dearer:

- With the review, GLM's fix pass often returned a note about its changes
  ("Audit complete... corrections made", "the answer above is the final,
  corrected version") instead of the corrected answer, and that note
  became the user's reply.
- On Sol, the review and its fix passes used most of a $2 budget, and
  many questions ran out before any answer came back.
- Without the review, every GLM answer came back, with a median time of
  under two minutes against ten, at about a third of the cost.

Guarding against false information needs a different mechanism.

## The research tools carry no `print`

The agency agent's `researchTools`
(`lib/agents/agency-agent/brains/coordinator/subagents/research.agency`)
are the memory and todo tools. Do not add `print`: given it, models wrote
the whole report to the terminal and replied "the full answer is printed
above", so the reply held no findings. The reply is the only place an
answer goes.

## Tests

`tests/agency/agents/researcher.agency`, under a scripted model:

- `answerIsReturnedAsWritten`: one mock reply, and it comes back as the
  answer. A second model call would run out of mocks.
- `emptyFirstAnswerIsAskedAgain`: the first reply is empty, and the
  follow-up's text is the answer.
- `shortFollowUpIsAnAnswer`: the follow-up is `Yes (https://x.io).`,
  under the 20-character floor, and it is the answer.
- `twoEmptyAnswersAreAFailure`: two blank replies are the failure naming
  the cause.
