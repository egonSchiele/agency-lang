# The Agency writer's prompt: the tutorial, the docs listing, and formatting

`agencyCodingAgent` (`stdlib/agents/agency/coding.agency`) writes Agency
programs. This doc covers how it learns the language, and the rules for
changing that.

## The tutorial

`stdlib/agents/prompts/agency-tutorial.md` is a tour of the language
written for a model. It sits at the top of the writer's system prompt,
above the rules in `coding.agency`. It is in the prompt because the writer
rarely opens a docs page: between 2 and 14 pages over 75 eval trials.

`agentPrompt(filename)` in `std::skills` reads it into a `static const`.
It raises no interrupt, because the file ships inside the package, and a
`read(...) with approve` in a static fails under a policy that rejects
reads. It returns a `Result`. `agencyCodingAgent` returns a failure when
the tutorial could not be read, so a file missing from the published
package is an error on the first run. `package.json` ships
`stdlib/agents/prompts`.

Rules for editing the tutorial:

- Every code sample must parse. Extract the fenced blocks and run
  `pnpm run ast` on each. Blocks that are signatures, `{ ... }`
  placeholders, or program output fail, and no others should.
- Show one form for each construct, because the writer copies what it
  sees: handler parameters are named `data`, match arms use `=>`, `llm`
  takes `tools:` by name, and a Result is read with `is success(v)` or
  `match`.
- Unwrap every `Result` a sample receives. `read` returns one, and a
  sample that uses it as a string teaches a type error.
- The tutorial and the rules below it in `coding.agency` must agree.
- The standard library section lists the functions in scope with no import
  (`std::index`), then the modules real agents import most. The counts came
  from `lib/agents/agency-agent` and a second agent codebase. A module that
  only an eval test needs does not go on the list.

## The docs listing

`agencyDocToolsBrief()` in `std::agents/lib/toolkits` gives the writer the
five docs tools with each page as one line:

```
handlers.md - Explains how `handle ... with` blocks let agents respond to interrupts.
```

The full listing wraps the same description in XML tags and names the
directory: 18,673 characters for the guide, against 10,771.

- Keep the description. With paths alone the writer opened four times as
  many pages and scored 0.677, against 0.791 for the full listing. A name
  such as `llm-part-2.md` says too little, and the one-line summaries teach
  some of the language themselves.
- A page with no description is listed by its frontmatter `name`, which
  is how most of the diagnostics pages get a label.
- `briefEntry` collapses whitespace in a description. It comes from
  frontmatter a user wrote, and a line break in it would read as another
  entry.
- `toolkits` scans each docs section once (`docsEntries`) and builds the
  full and the brief tool from the same entries (`docsToolFromEntries`).
- The brief tools have the same names as the full ones. An agent offers
  one set. The writer drops any `extraTools` entry whose name it already
  has, because a provider rejects two tools with one name.

## Formatting

The harness formats a draft once its checks pass (`formatted` in
`coding.agency`). The writer has no `format` tool. With the tutorial in the
prompt and formatting left to the model, 7 drafts in 75 came back
formatted.

- The checks run on the text the model wrote. A critique quotes line
  numbers, and they have to match what the model sees in its thread.
- The formatted text is compiled once more, and the draft goes out
  unformatted when that fails. A formatter bug must not change the
  deliverable.

Do not add a typecheck instruction to the task message. It was measured: a
typecheck is a tool round, the model calls per trial about doubled, and so
did the cost. The loop compiles every draft regardless.

## Measuring a change

```bash
pnpm run agency eval run \
  stdlib/agents/agency/coding.agency:evalMain \
  --suite evals/agency-coding --trials 3 -n 4 \
  --out runs/<name>
pnpm run agency eval grade runs/<name>
```

Each trial loads the compiled stdlib when it starts. Do not run `make` or
switch branches in a checkout while a run or a grade is going there. At
three trials, a difference under about 0.1 on one test is noise.

Reference scores, writer and judge on `gpt-5-mini`:

| writer | score | cost |
| --- | --- | --- |
| full XML listing, no tutorial | 0.791 ± 0.009 | $1.10 |
| paths-only listing, no tutorial | 0.677 ± 0.006 | $1.24 |
| brief listing, no tutorial | 0.775 ± 0.019 | $1.02 |
| tutorial, brief listing, formatting, typecheck line | 0.822 ± 0.027 | $0.78 |
| tutorial, brief listing, formatting | 0.875 ± 0.015 | $0.48 |

Issue #1081 costs points in every run: a `match` or `if ... then ... else`
used as a value fails the sandbox's undefined-variable check, so a correct
draft can fail its hidden test.
