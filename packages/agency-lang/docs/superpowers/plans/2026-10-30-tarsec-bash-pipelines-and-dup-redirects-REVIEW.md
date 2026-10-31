# Review: tarsec pipelines and dup redirects (ADI-239)

Plan reviewed: `/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-safebash-reads/packages/agency-lang/docs/superpowers/plans/2026-10-30-tarsec-bash-pipelines-and-dup-redirects.md`

Checked against the tarsec checkout at `/Users/adityabhargava/tarsec`
(`main` at ef1ba83, version 0.5.4) and the spike branch
`spike/bash-pipeline` (4b76ff3).

## Verdict

Task 2 (dup redirects) is right and can be built as written. Task 1 (the
pipeline) has two real bugs in the parser design. Both are things the
plan's own tests would catch, but the plan states the wrong mechanism as
fact, so a builder following it would write the code, watch two tests
fail, and have to rediscover why. Fix the design in the plan first. Both
fixes are small and stay inside combinators.

## Bug 1: `(a && b) | c` cannot reach the pipeline parser

Task 1 Step 4 says: "The `parensParser` argument to `buildExpressionParser`
stays, so `(a && b) | c` reaches the pipeline through the atom." It does
not. Read `buildExpressionParser` in `lib/combinators.ts` (around line
1240):

```ts
const base: Parser<T> = (input: string) => {
  const paren = parenParser ?? buildDefaultParenParser();
  const result = paren(input);
  if (result.success) return result;
  return atom(input);
};
```

The paren parser runs first, and when it succeeds the atom is never
tried. For `(a && b) | c`, `parensParser` consumes `(a && b)` and
returns, the `&&`/`||` level finds no operator at ` | c`, and
`bashParser` fails on leftover input. The pipeline parser never sees the
string. The plan's own test row `(a && b) | c → pipeline(parens(and(a,
b)), c)` would fail.

The spike did not have this problem because it made `|` an operator
level inside `buildExpressionParser`, so a parenthesized base could be
its left operand. Moving to `sepBy1` as the atom changes that.

The fix is one argument. Since the plan already makes a parenthesized
group a pipeline stage (`or(lazy(() => parensParser), simpleCommandParser)`),
the expression parser's own paren handling is now redundant and in the
way. Pass a parser that never matches so `base` always falls through to
the atom:

```ts
export const commandParser: Parser<Command> = trace("commandParser", buildExpressionParser<Command>(
  pipelineParser,
  [[ /* && and || as today */ ]],
  // Parentheses are a pipeline STAGE, handled inside pipelineParser. Left
  // to buildExpressionParser they would be consumed before the atom runs
  // and `(a && b) | c` could never be a pipeline.
  fail("parentheses are parsed as a pipeline stage"),
))
```

`fail` is exported from `lib/parsers.ts:573` and is `Parser<never>`,
which satisfies `Parser<Command>`. Keep the comment, because the next
reader will see `fail` where a paren parser goes and want to "fix" it.

Add a test row for a lone parenthesized group, `(a && b)` →
`parens(and(a, b))`, since that path now goes through `pipelineParser`'s
one-stage case rather than through the expression parser.

## Bug 2: `sepBy1` swallows a trailing separator, it does not leave it

Task 1 Step 4 says to check whether `sepBy1` "backtracks past a matched
separator" and, if it does, to wrap in `committed`. The behavior is
worse than the plan's guess and the test will fail with no `committed`.
Read `sepBy` in `lib/combinators.ts:460`:

```ts
rest = result.rest;
const sepResult = separator(rest);
if (!sepResult.success) { ... return success(results, rest); }
rest = sepResult.rest;          // <- advanced past the separator
// loop: parser(rest) fails, not committed ->
//   return success(results, rest);   <- with rest ALREADY past the separator
```

When the separator matches and the next element fails, `sepBy` returns
success with `rest` positioned after the separator. So `ls |` parses as
`ls` with the `|` silently eaten, and `bashParser` sees an empty rest and
succeeds. That is exactly the "mis-parse, not rejection" the module
header forbids, and it is why the plan's `pipe with no right side` row
matters. (The same thing happens today with `echo a;`, which parses as
`echo a`. That one is harmless because bash agrees. `ls |` is a syntax
error in bash.)

So the `committed` branch of the plan is not a fallback, it is the
design. Write the pipeline as a first stage followed by zero or more
committed `| stage` pairs:

```ts
const pipelineStage: Parser<Command> = or(lazy(() => parensParser), simpleCommandParser);

/** `a | b | c`, flat. The operator COMMITS: once a `|` is seen, a missing
 * stage is a parse error, not the end of the pipeline. Without the
 * commit, `sepBy` returns past a matched separator and `ls |` would parse
 * as `ls`. */
export const pipelineParser: Parser<Command> = trace("pipelineParser", map(
  seqR(pipelineStage, many(committed(pipeOperator, pipelineStage))),
  ([first, rest]) => rest.length === 0
    ? first
    : { tag: "pipeline", stages: [first, ...rest] },
));
```

`committed(prefix, rest)` returns `rest`'s result and marks a failure
after a successful prefix as committed. `many` propagates committed
failures (the tarsec `CLAUDE.md` says so under Architecture, and `sepBy`
above shows the check). `bashParser`'s outer `sepBy1` also propagates it,
so the whole parse fails with the committed message, which is also the
message `getErrorMessage` prefers. Two things to confirm in tests:

- `a || b` still parses as `or`. `pipeOperator` fails at `not(oneOf("|&"))`
  before committing, so nothing is committed. Good.
- `a && b |`. Here `parseLeft` in `buildExpressionParser` calls the atom
  for the right operand, gets a committed failure, and `break`s,
  restoring the committed slot. The chain ends as `a` with rest
  ` && b |`, and `bashParser` fails on leftover input. Rejected, but the
  error message will point at `&&` rather than `|`. Acceptable; note it
  in the test rather than fight it.

`seqR` returns an array of results, so the `map` destructures `[first,
rest]`. The ternary in the `map` is a single ternary, not nested, which
both anti-pattern catalogs allow.

With this shape, drop the "check `sepBy1`'s behavior" paragraph from the
plan. The behavior is known.

## Task 2: dup redirects, verified

- Putting the dup alternative first in `redirectParser`'s `or` is
  harmless but not necessary. The existing fd form uses `num` then
  `fdRedirectOp` then `wordParser`; on `2>&1` it consumes `2>` and then
  `wordParser` fails on `&1` (`&` is not a word character), so `or`
  backtracks. Either order works. Keep it first, as the plan says, since
  it is the cheaper match.
- `wholeWord` is a module-local function in `parsers.ts` (line 91), not
  an export. The plan uses it inside the same file, so that is fine.
- The `2>&12` and `2>&out` rows: `digit` then the `wholeWord` boundary
  check fails because `2` and `o` are not in `WORD_END_CHARS`. Good.
  `2>& 1`: `str(">&")` succeeds, `digit` fails on the space. Good.
- `echo x >&2` with no fd: `optional(digit)` matches nothing, `str(">&")`,
  `digit`, eof boundary. Good. The result object has no `fd` key because
  `optional` of a capture that did not match adds none. The test asserts
  "no `fd` key", which `toEqual` treats the same as `fd: undefined`, so
  the assertion is sound either way.
- The round-trip property holds for `2>&1`, because
  `redirectToBash` will render `${fd}>&${digit}` and the parser reads it
  back to the same node.

One gap in Task 2 Step 4. `astToBash`'s header promises the output is
always safe to hand to bash, and it throws `AstToBashError` where quoting
cannot rescue a field. A hand-built dup redirect with `target: literal
"out"` would render as `2>&out`, which bash reads as a redirect to a file
named `out`. That is a different command from what the node claims.
Validate that the target is a single digit and throw otherwise, the way
`redirectToBash` already throws for an unsupported operator. One `if`.

## Smaller points

- **Task 1 Step 3, the `Pipeline` type.** The plan types `stages` as
  `Command[]` but says each is a `SimpleCommand` or `Parens`. Type it as
  what it is: `stages: (SimpleCommand | Parens)[]`. A consumer walking
  stages then does not have to handle `and`, `or`, or a nested `pipeline`
  that the parser can never produce. The Agency mirror in ADI-241 should
  match.
- **Task 1 Step 1, the error-positions test.** Changing `echo hi | wc` to
  `echo hi $(date)` with expected rest `$(date)` is right. I traced it:
  `echo hi` parses, `$(` stops the argument parser, and `bashParser`
  returns `rest` starting at `$(date)`.
- **Global Constraints, `test:tsc`.** The plan says 8 pre-existing errors
  on `main`. I did not re-run it. The memory note from the spike agrees.
- **The spike worktree** at
  `/Users/adityabhargava/tarsec/.claude/worktrees/spike-bash-pipeline` is
  still there. The plan says do not merge it; it should also say to
  delete it once this PR lands, or it will be mistaken for the real
  branch.

## Anti-pattern pass

Checked against `~/.claude/skills/anti-pattern-check/anti-patterns.md`
and tarsec's own `anti-patterns.md` at the repository root.

- **Order-dependent mutable state** is explicitly exempted for parsers,
  and the plan's parser code is all combinators. Good.
- **Imperative code everywhere.** The `sepBy1` version in the plan was the
  right instinct and is why the pipeline is flat with no `pipe()`
  flattening helper. The fixed version above keeps that property.
- **Useless special cases.** None. The one-stage case returning the stage
  itself is a real requirement (a lone command must stay a
  `SimpleCommand`), not a special case.
- Nothing from the catalog applies to Task 2.

## What I did not check

I did not run the tarsec suite. The two bugs above are from reading
`buildExpressionParser` and `sepBy`, and both are visible in the code
quoted here.
