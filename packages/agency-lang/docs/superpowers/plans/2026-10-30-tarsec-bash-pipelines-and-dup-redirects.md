# tarsec: pipelines and `2>&1` in the bash parser (ADI-239) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The tarsec bash parser accepts `a | b | c` as a flat pipeline that binds tighter than `&&`/`||`, and accepts `2>&1` and `>&2` as dup redirects, with both rendered back by `astToBash`.

**Architecture:** A `Pipeline` node joins the `Command` union. The atom of the existing `buildExpressionParser` call becomes "one or more simple commands separated by `|`", written with `sepBy1`, mapped to a `Pipeline` when there are two or more and to the lone command otherwise. A dup redirect is a third alternative in `redirectParser` whose target is a single digit. Everything else in the parser is untouched.

**Tech Stack:** tarsec (parser combinators), vitest. Repository `/Users/adityabhargava/tarsec`, files under `lib/parsers/bash/` and `tests/parsers/bash/`.

**Spec:** `/Users/adityabhargava/agency-lang/packages/agency-lang/worktree-safebash-reads/packages/agency-lang/docs/superpowers/specs/2026-10-30-safebash-reads-pipes-scripts-design.md`, Part 4 "The tarsec change". Linear: ADI-239. A throwaway spike of the pipeline half is on branch `spike/bash-pipeline` in `/Users/adityabhargava/tarsec/.claude/worktrees/spike-bash-pipeline` (commit `4b76ff3`); it used a binary operator with a flattening `apply`, which this plan replaces with `sepBy1`. Do not merge the spike.

## Global Constraints

- Combinators only. No manual input slicing, no parse-state access, no position arithmetic (`lib/` conventions in `/Users/adityabhargava/tarsec/CLAUDE.md`).
- `lib/` must stay browser-safe: no Node imports (`tests/browserSafe.test.ts` enforces it).
- `|&`, a trailing `|`, a leading `|`, and any `>&` spelling other than a single digit on each side stay rejected. The header comment in `lib/parsers/bash/index.ts` lists what is supported and what is rejected and must stay true.
- The round-trip property in `tests/parsers/bash/astToBash.test.ts` holds for every new shape: `bashParser(astToBash(ast))` gives an equal AST.
- `npx vitest run` (whole suite), `npm run build`, and `npm run test:tsc` before the PR. `test:tsc` has 8 pre-existing errors in `parsers.test.ts` on `main`; the count must not grow.
- The owner releases tarsec and writes the CHANGELOG line; the PR does not bump the version.
- Work on a branch in a worktree under `/Users/adityabhargava/tarsec/.claude/worktrees/`, never on `main`.

## Review Focus

- `a || b` must stay an `or`, and `a|b` with no spaces must be a pipeline. Pinned in Task 1.
- `(a && b) | c`: a parenthesized stage must be allowed, and `a && (b | c)` must group the pipeline inside the right operand. Pinned in Task 1.
- A redirect on a stage (`cat f 2> err | wc -l`) must stay on that stage. Pinned in Task 1.
- `cmd 2>&1 >out` and `cmd >out 2>&1`: two redirects on one command, one of them a dup, both kept in order. Pinned in Task 2.
- `cmd 2>&12` and `cmd 2>& 1`: rejected, not parsed as a dup to fd 1 followed by junk. Pinned in Task 2.

---

### Task 1: The `Pipeline` node

**Files:**
- Modify: `lib/parsers/bash/types.ts` (the `Command` union)
- Modify: `lib/parsers/bash/parsers.ts` (`commandParser` and a new `pipelineParser` above it)
- Modify: `lib/parsers/bash/astToBash.ts` (`commandToBash`, `isCommand`)
- Modify: `lib/parsers/bash/index.ts` (header)
- Test: `tests/parsers/bash/parsers.test.ts`, `tests/parsers/bash/astToBash.test.ts`

**Interfaces:**
- Produces: `export type Pipeline = { tag: "pipeline"; stages: Command[] }` with two or more stages, each a `SimpleCommand` or `Parens`; `Command = SimpleCommand | Pipeline | And | Or | Parens`; `export const pipelineParser: Parser<Command>` which returns the lone stage when there is one and a `Pipeline` otherwise; `astToBash` renders stages joined with ` | `.

- [ ] **Step 1: Write the failing parser tests**

Append to `tests/parsers/bash/parsers.test.ts` a `describe("pipelines")` with a local `simple(name, ...args)` builder, and these cases (assertions on the full AST with `toEqual`):

- `ls | wc -l` → `pipeline` of `ls` and `wc -l`
- `a | b | c` → one `pipeline` with three stages (not nested)
- `a | b && c` → `and(pipeline(a, b), c)`
- `a && b | c` → `and(a, pipeline(b, c))`
- `(a && b) | c` → `pipeline(parens(and(a, b)), c)`
- `a && (b | c)` → `and(a, parens(pipeline(b, c)))`
- `a || b` → `or(a, b)`
- `a|b` → `pipeline(a, b)`
- `cat f 2> err | wc -l` → first stage carries the redirect `{ fd: 2, op: ">", target: literal "err" }`

In the existing `describe("unsupported syntax is rejected, not mis-parsed")`, replace the `["pipeline", "ls | wc -l"]` row with `["stderr-merging pipe", "ls |& wc -l"]`, `["pipe with no right side", "ls |"]`, and `["pipe with no left side", "| ls"]`.

In `describe("error positions")`, the example `echo hi | wc` now parses; change it to `echo hi $(date)` with expected rest `$(date)`.

Append to the `corpus` in `tests/parsers/bash/astToBash.test.ts`: `"ls | wc -l"`, `"grep -rn foo src | head -20 | sort"`, `"a | b && c"`, `"a && b | c"`, `"(a && b) | c"`, `"a && (b | c)"`, `"cat f 2> err | wc -l"`.

- [ ] **Step 2: Run the two files to see the new cases fail**

Run: `npx vitest run tests/parsers/bash > /tmp/tarsec-t1.txt 2>&1; tail -8 /tmp/tarsec-t1.txt`
Expected: the pipeline cases fail; the rest pass.

- [ ] **Step 3: Add `Pipeline` to `types.ts`**

The doc comment says: each stage's stdout feeds the next; a stage is a simple command or a parenthesized group, never a chain, because `|` binds tighter than `&&` and `||`; flat, always two or more stages.

- [ ] **Step 4: Write `pipelineParser` and make it the atom in `parsers.ts`**

```ts
const pipeOperator: Parser<string> =
  map(seqR(blanks, char("|"), not(oneOf("|&")), blanks), () => "|");

/** One or more stages separated by `|`. One stage is that command; two or
 * more are a flat Pipeline. */
export const pipelineParser: Parser<Command> = trace("pipelineParser", map(
  sepBy1(pipeOperator, or(lazy(() => parensParser), simpleCommandParser)),
  (stages) => stages.length === 1 ? stages[0] : { tag: "pipeline", stages },
));
```

`commandParser` keeps its single `&&`/`||` level and passes `pipelineParser` as the atom in place of `simpleCommandParser`. The `parensParser` argument to `buildExpressionParser` stays, so `(a && b) | c` reaches the pipeline through the atom and `a && (b | c)` reaches it through the paren parser. Check `sepBy1`'s behavior when the separator matches but the following element does not (`ls |`): it must fail the whole parse, not succeed with one stage and leave `|` as rest; the `pipe with no right side` test pins this. If `sepBy1` backtracks past a matched separator, wrap the operator and element in `committed` per the tarsec `committed(prefix, rest)` convention.

- [ ] **Step 5: Render it in `astToBash.ts` and update the header in `index.ts`**

`case "pipeline": return command.stages.map(commandToBash).join(" | ");` in `commandToBash`; `"pipeline"` added to `isCommand`. In `index.ts`, add a supported line "Pipelines (`a | b | c`), flat, binding tighter than `&&` / `||`" and change the rejected line to name `|&` instead of pipelines.

- [ ] **Step 6: Run the two files to see everything pass**

Run: `npx vitest run tests/parsers/bash > /tmp/tarsec-t1.txt 2>&1; tail -5 /tmp/tarsec-t1.txt`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add lib/parsers/bash tests/parsers/bash
git commit -F /tmp/msg.txt   # "bash parser: pipelines"
```

---

### Task 2: Dup redirects `2>&1` and `>&2`

**Files:**
- Modify: `lib/parsers/bash/parsers.ts` (`redirectParser`)
- Modify: `lib/parsers/bash/astToBash.ts` (`redirectToBash` and the operator sets near line 52)
- Modify: `lib/parsers/bash/index.ts` (header)
- Test: `tests/parsers/bash/parsers.test.ts`, `tests/parsers/bash/astToBash.test.ts`

**Interfaces:**
- Produces: a `Redirect` with `op: ">&"`, `fd` the digit before `>&` or `undefined` when there is none, and `target` a `LiteralWord` whose text is the single digit after. `astToBash` renders it as `${fd ?? ""}>&${digit}` with no spaces.

- [ ] **Step 1: Write the failing tests**

In `tests/parsers/bash/parsers.test.ts`, a `describe("dup redirects")`:

- `make 2>&1` → one redirect `{ tag: "redirect", fd: 2, op: ">&", target: literal "1" }`
- `echo x >&2` → `{ tag: "redirect", op: ">&", target: literal "2" }` with no `fd` key
- `cmd >out 2>&1` → two redirects in that order
- `cmd 2>&1 >out` → two redirects in that order
- `make 2>&1 | tail -100` → pipeline whose first stage has the dup redirect

Rejected rows added to the unsupported list: `["dup to a two-digit fd", "cmd 2>&12"]`, `["dup with a space", "cmd 2>& 1"]`, `["dup to a name", "cmd 2>&out"]`.

Corpus additions in `astToBash.test.ts`: `"make 2>&1"`, `"echo x >&2"`, `"cmd >out 2>&1"`, `"make 2>&1 | tail -100"`.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/parsers/bash > /tmp/tarsec-t2.txt 2>&1; tail -8 /tmp/tarsec-t2.txt`

- [ ] **Step 3: Add the dup alternative to `redirectParser`**

A new first alternative in the `or`, before the fd form, so `2>&1` is not read as `2>` followed by a failed word:

```ts
seqC(
  set("tag", "redirect"),
  optional(capture(map(digit, parseInt), "fd")),
  capture(str(">&"), "op"),
  capture(map(digit, literalWord), "target"),
)
```

`wholeWord` around the digit target makes `2>&12` and `2>&out` fail (the next character is not a word boundary); use it the way `literalWordParser` does.

- [ ] **Step 4: Render it in `astToBash.ts`**

Add `">&"` as a third operator class beside the fd and bare sets: it takes an optional fd and renders `${fd}>&${target text}` with no space. The existing check that an fd is only allowed on fd-taking operators must accept it.

- [ ] **Step 5: Header, run, commit**

In `index.ts`, add `2>&1` and `>&2` to the supported redirects and remove `2>&1` from the rejected list. Run the two test files, then:

```bash
git add lib/parsers/bash tests/parsers/bash
git commit -F /tmp/msg.txt   # "bash parser: dup redirects 2>&1 and >&2"
```

---

### Task 3: Whole suite, build, type-check, PR

- [ ] **Step 1: Run everything**

Run: `npx vitest run > /tmp/tarsec-full.txt 2>&1; tail -5 /tmp/tarsec-full.txt; npm run build > /tmp/tarsec-build.txt 2>&1; echo build $?; npm run test:tsc > /tmp/tarsec-tsc.txt 2>&1; grep -c "error TS" /tmp/tarsec-tsc.txt`
Expected: suite green, build exit 0, error count 8 (the pre-existing set; compare against `main` with the same command if it differs).

- [ ] **Step 2: Anti-pattern and prose check**

Run `/anti-pattern-check` on the diff (the tarsec repo has its own `anti-patterns.md` at the root). Check new comments against `~/.claude/skills/simplify-speech/verbal-tics.md`.

- [ ] **Step 3: PR**

Body in a file: the two node shapes, the precedence rule, what stays rejected, and the Linear issue. Title: `bash parser: pipelines and dup redirects (ADI-239)`. The owner releases; ADI-241 bumps the pin in agency-lang.
