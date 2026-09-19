# The Agency writer's prompt: the tutorial, the docs listing, and what the harness does itself

`agencyCodingAgent` (`stdlib/agents/agency/coding.agency`) writes Agency
programs. This doc covers how it learns the language: a tutorial in its
system prompt, docs tools with a short listing, and two jobs the harness
does so the model does not have to remember them. Each choice was measured
on `evals/agency-coding`, and the numbers are at the end.

## The tutorial

`stdlib/agents/prompts/agency-tutorial.md` is a tour of the language
written for a model: LLM calls, syntax, interrupts and handlers, Results,
threads, guards, and a section on the standard library. It sits at the
top of the writer's system prompt, above the rules in `coding.agency`.

It is in the prompt because the writer rarely opens a docs page. In 75
eval trials it opened between 2 and 14. What it needs most often has to be
in front of it already.

`agentPrompt(filename)` in `std::skills` reads the file into a
`static const`. It raises no interrupt, for the reason `docsSkill` gives:
the file ships inside the package. A `read(...) with approve` in a static
would fail under any policy that rejects reads. The read is confined to
`stdlib/agents/prompts`, and `package.json` ships that folder.

Rules for editing the tutorial:

- Every code sample must parse. Extract the fenced blocks and run
  `pnpm run ast` on each. The blocks that are signatures, `{ ... }`
  placeholders, or program output will fail, and no others should.
- Show one form for each thing. The eval judges mark a draft down for a
  form the suite does not prefer, and the writer copies what it sees:
  handler parameters are named `data`, match arms use `=>`, `llm` takes
  `tools:` by name, and a Result is read with `is success(v)` or `match`.
- The tutorial and the rules below it in `coding.agency` must agree. When
  they disagree, the writer follows either one.

### The standard library section

The section has two lists. The first names every function that is in scope
with no import (`std::index`). The second names the modules that real
agents import most. The counts came from two codebases: `agency agent`
(`lib/agents/agency-agent`) and a chat application's agent. `std::thread`
is first because both depend on it. A module goes on the list because
programs use it. A data connector that one eval test needs does not go on
it.

The section ends by sending the writer to the `agencyStdlib` tool's file
list for everything else.

## The docs listing

`docsSkill(section, brief: true)` and
`skillsToolFromEntries(..., brief: true)` list each file as one line:

```
handlers.md - Explains how `handle ... with` blocks let agents respond to interrupts.
```

The full listing wraps the same description in `<skill>`, `<name>`,
`<description>`, and `<location>` tags and names the directory. For the
guide that came to 18,673 characters on every model call. The brief form is
10,771. A file with no description is listed by its path alone.

The description has to stay. A listing of paths alone was tried: the
writer opened four times as many pages and scored 0.677 where the full
listing scored 0.791. File names such as `llm-part-2.md` say too little.
The descriptions also teach: seventy one-line summaries of the guide are a
small tutorial of their own. The two tests that fell furthest without
them, `effect-payload-types` and `handler-chain`, are about interrupts and
handlers.

The writer builds its own five docs tools with `brief: true`. Every other
agent still gets the full listing from `agencyDocTools()`.

Shrinking the listing further means writing shorter `description` lines in
the frontmatter of the pages under `docs/site`. Five guide pages have none.

## What the harness does itself

**Formatting.** `generateLoop` runs `format` on each draft before checking
it. A draft that does not parse goes on unformatted, and the checks report
the parse error. The writer has no `format` tool. When formatting was the
model's job, a prompt with the tutorial in it produced 7 formatted drafts
in 75.

**The typecheck instruction.** The message the writer answers ends with
`CHECK_FIRST`, on the first attempt and on every repair. The system prompt
says the same thing in its closing lines, which sit below 30 KB of
tutorial. With the instruction there only, the writer called `typecheck` 14
times in 75 trials where it had called it 77 times before. This line is
where the tutorial runs' extra cost comes from: a typecheck is a tool
round, and it about doubles the model calls in a trial. The loop compiles
every draft regardless, so the line buys catching an error one round
sooner.

Both follow `harness-and-model.md`: a step the harness can do
deterministically does not belong in the prompt, and an instruction the
model must follow goes where it answers.

## The measurements

The full `evals/agency-coding` suite, 25 tests, three trials each, writer
and judge on `gpt-5-mini`. A difference under about 0.1 on one test is
noise at three trials: one failed draft moves a test by 0.3.

| writer | score | cost | model calls | docs pages opened |
| --- | --- | --- | --- | --- |
| before any of this | 0.791 ± 0.009 | $1.10 | 401 | 14 |
| paths-only listing, no tutorial | 0.677 ± 0.006 | $1.24 | 502 | 57 |
| brief listing, no tutorial | 0.775 ± 0.019 | $1.02 | 385 | 12 |
| tutorial, paths-only listing | 0.787 ± 0.010 | $0.43 | 150 | 4 |
| the same, plus harness formatting and `CHECK_FIRST` | 0.840 ± 0.014 | $0.94 | 353 | 4 |
| tutorial, brief listing, formatting, `CHECK_FIRST` (what ships) | 0.822 ± 0.027 | $0.78 | 282 | 2 |

What the rows say:

- The tutorial is what raises the score. `stdlib-knowledge` went from 0.131
  to about 0.55, and that gain came from the standard library section: the
  tutorial without it scored 0.030 there.
- Without the tutorial, the brief listing matches the full one at a little
  over half the size.
- With the tutorial, the listing format changes nothing measurable,
  because the writer almost never opens a page.
- Harness formatting with no typecheck instruction was not run. It would
  show how much of the last 0.05 formatting accounts for.

To run it again:

```bash
pnpm run agency eval run \
  stdlib/agents/agency/coding.agency:evalMain \
  --suite evals/agency-coding --trials 3 -n 4 \
  --out runs/<name>
pnpm run agency eval grade runs/<name>
```

Each trial loads the compiled stdlib when it starts. Do not run `make` or
switch branches in a checkout while a run is going there.

## A known loss that is not the writer's

Issue #1081. A `match` or an `if ... then ... else` used as a value fails
the sandbox's undefined-variable check with `AG4007: Variable
'__matchval_1' is not defined`. The tutorial teaches `if ... then ...
else`, so the writer uses it, and a draft the judge scores in full can
fail its hidden test. It appears 4 to 7 times in every grade log above.
