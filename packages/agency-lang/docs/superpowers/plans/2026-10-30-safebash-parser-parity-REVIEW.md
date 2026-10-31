# Review: safeBash parser parity (ADI-241)

Plan reviewed: `/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-safebash-reads/packages/agency-lang/docs/superpowers/plans/2026-10-30-safebash-parser-parity.md`

Checked against `stdlib/safeBash.agency`, `stdlib/safeBash/actions.agency`,
`tests/agency/safeBash.agency`, and `tests/agency/safeBash.test.json` in
this worktree (commit 0c18d3afd).

## Verdict

The plan is right about the mechanism: the exhaustive `flattenOne` match
is the thing that forces the change, and once a pipeline flattens to its
stages the rest of `planFor` needs nothing new. I traced all eight
`newShapes` rows and the expected output is correct. Three things to fix
in the text: a global constraint that contradicts a Review Focus row, a
claim in Task 3 about what the end-to-end test proves that is false, and
a `flattenOne` arm that reinvents a function three lines above it.

## Fix: the "no question changes" constraint is not true

Global Constraints says: "every string that asked `std::bash` before still
asks it, and no string that asked a narrow question asks a different
one." Review Focus then says `git status | git log` is "the narrow case".
Both cannot hold. Today that string is unparseable and asks `std::bash`.
After this slice both stages are recognized, `narrow` holds two git
effects, and the plan asks `std::git::status` and `std::git::log`
instead. That is a question change, and it is the one the spec wants
(Part 4, "a pipeline is recognized when every stage is recognized").

Rewrite the constraint to say what is actually promised: no string that
asks a narrow question today asks a different one, and the only strings
that stop asking `std::bash` are pipelines whose every stage is already a
recognized verb, which today means git reads and echoes. The existing
`.test.json` expectations do pass unchanged, which is the useful half of
the sentence; keep that.

## Fix: Task 3 does not pin what it says it pins

Task 3 runs `safeBash("echo hi | tr a-z A-Z")` with one `std::bash`
approval and says: "This pins that the rebuilt text keeps the pipe and
bash does the plumbing." It does not pin the rebuilt text. `tr` has no
rule, so the plan is broad, and `planFor`'s `!allRecognized` branch
returns `bashPlan(source, ...)`, which runs the caller's original text
verbatim. The rebuilt text from `astToBash` is never used on that path.
The test proves that a pipe in the original string reaches bash through
`_bash`. Keep the test and change its comment to say that.

To pin the rebuilt path through a pipe, use the same trick
`rebuiltVersusOriginal` already uses: feed a recognized pipeline with odd
spacing and read `execution.command`. Add to `newShapes`, or beside
`rebuiltVersusOriginal`:

```
executionCommand("git    status |  git   log")
```

with expected `"git status | git log"`. That shows the pipe survives
`astToBash` and the stages are the ones classified. No git repository is
needed because `planFor` runs nothing. An end-to-end run of a recognized
pipeline would need a git repository under the test cwd, which no current
safeBash test assumes, so the plan-level check is the right one for this
slice.

## Fix: `flattenOne`'s pipeline arm already exists as `flattenCommands`

Task 1 Step 3 writes the arm as

```
{ tag: "pipeline", stages } => [...[flattenOne(s) for s in stages].flat()]
```

and offers a loop as a fallback. `flattenCommands(commands: Command[])`
is defined directly above `flattenOne` and does exactly this: it loops
over a list of commands and concatenates `flattenOne` of each. The arm
is

```
{ tag: "pipeline", stages } => flattenCommands(stages)
```

Mutual recursion between the two is fine; `flattenOne` already calls
itself. This also avoids the question of whether the type checker knows
`.flat()` (I could not find it in the checker's array method list, and no
`.agency` file in the repo uses it), and it avoids a single-letter
variable name. Drop the fallback sentence.

If ADI-239 takes the review suggestion to type `stages` as
`(SimpleCommand | Parens)[]`, mirror that here; `flattenCommands` takes
`Command[]` and a narrower array is assignable to it.

## Verified: the eight `newShapes` rows

For each row I followed `planFor` as it stands plus the one change the
plan makes (filter `>&` redirects out in `redirectEffect`):

- `git status | git log`: one command, not a `simpleCommand`, so the
  single-command paths are skipped; flatten gives two git stages; both
  recognized; `rebuild` renders the pipeline. `["bash", [status, log]]`.
- `git status | head`: `head` has no rule, broad.
  `["bash", ["std::bash"]]`, reason `unrecognized: no rule for `head``.
- `echo hi 2>&1`: single simple command. `tryAgencyPlan` no.
  `trySeeIfShellFree` → `echoPlan` fails (has a redirect) → `writePlan`
  calls `prepareRedirectWrite`, which fails on `fd != null` before it
  looks at the operator. So it is not shell-free, as the Review Focus
  requires. Classification: `echo` → `redirectEffect` with the dup
  filtered out → `[]`. `narrow` empty → audit rule → `std::bash`. Matches.
- `echo hi 2>&1 > out.txt`: `writePlan` fails (`redirects.length != 1`).
  Classification: filtered to the one `>` → `std::write` for `out.txt`.
  Matches. The rebuilt text keeps both redirects in order, since
  `redirectToBash` is called per redirect in source order.
- `echo *.md`: `echoPlan` → `echoWords` → `literalWordText` refuses a glob
  → `writePlan` fails (no redirect) → classification: `echo` contributes
  nothing → audit rule → `std::bash`. Matches. Note the reason will be
  `noEffects`, not `unrecognized`; the plan does not assert it, which is
  right.
- `rm -rf x | cat`: flatten reaches `rm`, wall refuses. `["refuse", []]`.
- `make 2>&1 | tail -100`: `make` has no rule, broad. Matches.
- `planReason("git status | head")`: as above. The exact text depends on
  how ADI-238 lands; if its review is taken, this becomes a kind plus a
  detail rather than one string. Adjust the row then.

Also checked: `echo hi >&2` (fd absent, op `>&`) fails
`prepareRedirectWrite` on "not an output redirect", so the shell-free
write path never sees a dup redirect even with no fd. Good.

## Verified: the mechanism claims

- `flattenOne` is an exhaustive `match` with no catch-all and a comment
  saying a new shape is meant to be a type error there. The plan's Task 1
  Step 2 expectation (the build fails until the arm is added) depends on
  the type checker enforcing exhaustiveness over the `Command` union once
  `Pipeline` is added to it. The comment claims it does; the plan's own
  step will confirm it. Fine.
- `literalWordText` has a catch-all arm that fails on any unknown tag, so
  a `glob` word is refused everywhere a literal is required without new
  code. Confirmed. `literalArgs` (used by the git rule) checks
  `arg.tag != "literal"` and also refuses it. Confirmed.
- `lib/stdlib/safeBash.test.ts` imports `_bashParser` and `_astToBash`
  from `./safeBash.js`, which is a one-line re-export of tarsec, so the
  round-trip list passes as soon as the pin is bumped, before any Agency
  change. The plan says this. Confirmed.
- `tarsec` is listed under `minimumReleaseAgeExclude` in
  `/Users/adityabhargava/agency-lang/pnpm-workspace.yaml` (line 25).
  Confirmed.
- `tildeRedirectQuoting` in the existing tests asserts that an unquoted
  `~` redirect target is broad because the parser refuses it. After
  ADI-240 the parser accepts `~/x` as a path, and `prepareRedirectWrite`
  resolves it with `tildeModeFor` returning `expand`, so `echo hi >
  ~/cf-sb-tilde.txt` becomes a recognized write to the real home
  directory. That test row will change from `bash` to `write`. The plan's
  constraint that existing expectations pass unchanged is wrong for this
  one row, and the change is the intended behavior (the quote-aware tilde
  rule was written for exactly this). Call it out in Task 1 Step 4 and
  update the row and its comment, which currently says the grammar
  refuses an unquoted tilde.

## Smaller points

- **Task 1 Step 1** has `cd .../<worktree>` with a placeholder. The
  builder will be in the worktree already. Say "from this package
  directory" and drop the `cd`.
- **Task 2 Step 3** filters inside `redirectEffect`. Right place: it is
  the one function that decides what redirects contribute, and
  `prepareRedirectWrite` keeps refusing `>&` on the shell-free path, which
  is what the Review Focus wants. The two-line comment the plan asks for
  should also say why `prepareRedirectWrite` is left strict, or someone
  will "fix" the inconsistency.
- **Task 4 Step 1** adds a section to the dev doc from ADI-238. If ADI-238
  has not merged when this starts, the section has nowhere to go. The
  plan says ADI-238 is "merged first"; make it an explicit blocker in the
  Linear issue if it is not already.
- **Types.** The Agency `Redirect` type has `fd?: number` and the tarsec
  dup redirect leaves `fd` absent when there is none, so no type change is
  needed for `>&2`. The plan does not say so; one sentence would save the
  builder a check.

## Anti-pattern pass

Checked against `~/.claude/skills/anti-pattern-check/anti-patterns.md`
and `docs/dev/contributing/anti-patterns.md`.

- **Duplicating existing code.** The `flattenOne` pipeline arm rewrites
  `flattenCommands`. Fixed above.
- **Single-character variable names.** `s` in the comprehension. Goes
  away with the fix.
- **Imperative code everywhere.** The design is good here: one match arm
  and one filter, and classification of the new shape needs no new
  branches because `planFor` already loops over flattened commands. That
  is the property the spec wanted from the exhaustive match.
- Nothing else applies.

## What I did not check

I did not run `make` or the Agency tests, and I did not bump the pin. The
traces above are from reading `planFor` and its helpers as they stand.
