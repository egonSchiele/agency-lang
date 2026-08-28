# The writing rewrite agent

`std::agents/writing/rewrite` (`stdlib/agents/writing/rewrite.agency`) turns
the writing reviewer's findings into text. It calls `writingReviewAgent`,
hands the text and the findings to one rewriting call, and returns the
rewritten text as `Result<string>`.

## Decisions

- **The loop lives in the agent, not in callers.** `passes` (default 1)
  bounds the review-and-rewrite rounds. A round whose review returns no
  findings ends the loop, so clean text costs one review call and comes back
  unchanged. The `agency agent` `rewrite` subagent is a thin wrapper, the
  same shape as the `writing` one, so the CLI gets the loop for free.
- **A reviewer failure is the agent's failure.** The reviewer fails open (a
  review that could not run returns no findings). The rewriter does not: if
  the review failed, returning the original text would look like "nothing to
  fix", so the agent returns `failure(...)` instead. The guard block cannot
  return a `Result`, so the loop records the failure in a variable and the
  function reads it after the guard.
- **The subagent splits prose from request with a small LLM call.** A
  message like "Rewrite this for a contributor: ..." holds both. Passing the
  whole message, as the `writing` subagent does, would rewrite the
  instruction along with the prose.

## Evals

`evals/writing-rewrite/` reuses the reviewer suite's inputs. Each
`test.json` points `files` and `graderFiles` at
`../../writing-review/<test>/`; `loadInputs.ts` resolves both relative to
the test directory, so no copying and no symlinks. Only tests with a
`cleaned.md` are included, plus the two clean-text controls. The test-file
readers both suites need (`getSourceFileText`, `harvest`, `editorPoints`)
live in `evals/writing-review/lib/testFiles.ts`.

The first smoke run showed why the suite is separate from the reviewer's:
on `comment-abrupt-verb` the rewriter fixed 1 of 5 editor points even though
the reviewer had named most of them. The rewriting call made one phrase
concrete and dropped the rest. `flaws-fixed` reports each point as
`[fixed]` or `[remains]` with the judge's reason, so that gap is visible per
point.

## Files

- `stdlib/agents/writing/rewrite.agency` — the agent and its `evalMain`
- `lib/agents/agency-agent/brains/coordinator/subagents/rewrite.agency` — the CLI subagent
- `evals/writing-rewrite/lib/rewriteGraders.ts`, `templates.ts` — graders and judge prompts
- `evals/writing-review/lib/testFiles.ts` — shared test-file readers
