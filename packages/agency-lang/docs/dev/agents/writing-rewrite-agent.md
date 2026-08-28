# The writing rewrite agent

`std::agents/writing/rewrite` (`stdlib/agents/writing/rewrite.agency`) turns
the writing reviewer's findings into text. It calls `writingReviewAgent`,
hands the text and the findings to one rewriting call, and returns the
rewritten text as `Result<string>`.

## Decisions

- **The loop lives in the agent, not in callers.** `passes` (default 1)
  bounds the review-and-rewrite rounds. A round whose review returns no
  findings ends the loop, so clean text costs one review call and comes back
  unchanged.
- **A reviewer failure is the agent's failure.** The reviewer fails open by
  default: a review that could not run returns no findings. The rewriter
  calls it with `failOpen: false`, because returning the original text after
  a failed review would look like "nothing to fix".
- **The `agency agent` subagent splits prose from request with a small LLM
  call.** A message like "Rewrite this for a contributor: ..." holds both;
  passing the whole message would rewrite the instruction along with the
  prose.

## Evals

`evals/writing-rewrite/` holds copies of the `writing-review` tests that
have a `cleaned.md`, plus the two clean-text controls, kept in step by hand.
`flaws-fixed` judges each of the editor's points on its own and reports it
as `[fixed]` or `[remains]`, so a rewrite that applies some findings and
drops the rest shows where.

## Files

- `stdlib/agents/writing/rewrite.agency` — the agent and its `evalMain`
- `lib/agents/agency-agent/brains/coordinator/subagents/rewrite.agency` — the CLI subagent
- `evals/writing-rewrite/lib/rewriteGraders.ts`, `templates.ts` — graders and judge prompts
