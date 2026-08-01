# Review: Accepting the syntax variations agents actually write

Reviewing `2026-07-31-agent-friendly-syntax-variations-design.md`.

## Summary

This is a strong spec. The central design rule — a variation belongs here only if
the AST can forget which spelling was used — is the right rule, it is stated
explicitly, and it genuinely does make the formatter work fall out for free. The
`await`/`sync` precedent is a fair one. The exclusive-range decision is argued
better than most language decisions get argued, including the part where the
author counts the languages that disagree with them.

I checked every code claim in the spec against the source. **All of them are
accurate**, including the line numbers. That is unusual and it made this review
much faster. Details are in the last section.

I found one issue I think blocks implementation, two that need answering before
someone writes code, and a handful of smaller notes.

The blocking one is section 4: the spec does not actually say what the range
syntax *is*, and the two readings available produce different values.

---

## Blocking: what exactly is a range literal?

Section 4 uses two different syntaxes interchangeably and they do not mean the
same thing.

The scope list (line 102) and the `..` is exclusive section (lines 268-269) say
the syntax is **`[3..6]`**, brackets included, and that it means `range(3, 6)`.

The changes section (line 257) says something different: "**`a..b` produces an
ordinary `range(a, b)` `functionCall` node**" — no brackets. And the test list
(line 348) asks for a test of a range "as a standalone expression," which only
makes sense if `..` is an ordinary infix operator.

These cannot both be true, because Agency already has array literals:

- If `..` is an **infix operator** producing a `range()` call, then `3..6` is an
  expression evaluating to `[3, 4, 5]`, and `[3..6]` is an *array literal
  containing that array* — `[[3, 4, 5]]`. One element, not three.
- If **`[a..b]` is a single bracketed form**, then the brackets are part of the
  range syntax and the array-literal parser has to recognize and peel them.

The spec's own example is the one that goes wrong. Line 245:

```ts
for (i in [3..6]) { print(i) }
```

Under the infix reading this loop runs **once**, binding `i` to the array
`[3, 4, 5]`, and prints an array. It does not error. That is the same class of
failure the spec rightly worries about in the exclusive-vs-inclusive discussion —
a silent wrong answer rather than a message — and it would land on the exact
example the guide is going to show people.

If the answer is the bracketed form, three follow-on questions need answers,
because the array-literal parser is the same parser:

- `[1, 3..6]` — is that an error, or `[1, 3, 4, 5]`, or `[1, [3,4,5]]`?
- `[3..6, 8..9]` — same question.
- `[[3..6]]` — how does someone write an array that genuinely holds one range?

I do not think any of these are hard. But they are decisions, and right now the
spec reads as though it has made them when it has not.

**Recommendation:** pick the infix-operator reading, since it is the smaller
change and composes with everything else, and then fix the examples to drop the
brackets — `for (i in 3..6)`. If brackets are wanted for looks, that is a
separate argument and the three cases above need answers.

---

## Needs an answer: section 2 says "Ambiguity: None" and there is one

The spec's ambiguity analysis for `->` as a return-type separator (lines 186-188)
asks what can follow a return type, and answers `!`, `raises`, or `{`. That is
correct but it is the wrong question. The problem is what the return type can
*contain*.

**A return type can itself be a function type, and function types use `->`.** I
verified this parses today:

```ts
def f(): (string) -> string { return g }         // parses
def f(): (string) -> string raises <*> { return g }  // parses
def f(): (string) -> string! { return g }        // parses
node main(): (string) -> string { return g }     // parses
```

So after the change, this is legal input:

```ts
def f() -> (string) -> string { return g }
```

Two arrows, and the parser has to decide that the first is the separator and the
second belongs to the type. I expect greedy left-to-right consumption gets this
right, and I am not claiming it breaks. But "Ambiguity: None" is not an accurate
description of the situation, and this shape needs a test, not an assumption.

The spec already sets exactly the right standard for this in section 3, where it
says of the match-guard case: "The test exists to prove that, not because we
expect it to fail." Same treatment is needed here.

Worth noting the spec's own observation at lines 190-192 — that `->` is already
the function-type arrow — is what *creates* this case. The sentence is offered as
reassurance that the token is not gaining a new meaning, but it is also the
reason the two uses can now meet in one signature.

---

## Needs an answer: the number-parser fix does not do what section 4 needs

Section 4 says `numberParser` "must reject a numeric literal containing more than
one `.`." I read the parser (`lib/parsers/parsers.ts:600`) and confirmed the bug
report exactly — I parsed `for (i in [3..6])` and got:

```json
{ "type": "number", "value": "3..6" }
```

But "at most one dot" is not sufficient, and on its own it makes things worse
rather than better.

`many1WithJoin` is greedy. Given the text `3..6`, a parser that allows one dot
consumes `3.` and stops, leaving `.6`. The range parser then looks for `..` and
does not find it, because the first dot has already been eaten. So the range
never parses.

The same greediness undercuts the `1.2.3` test at line 347. With one dot allowed,
the parser consumes `1.2` and leaves `.3` — which is not obviously a parse error,
because `.` also begins member access. It may well produce a different silent
misparse rather than the error the spec asks for.

What is actually needed is a rule about the *boundary*: a number may contain one
dot, and may not be followed by another dot. That is lookahead, not a counting
change. It is a small edit but a different one, and whoever implements this from
the spec as written will get a surprise.

There is a second reason to be careful here that the spec does not mention:
**`...` is already real syntax in this language.** It is array spread
(`lib/parsers/parsers.ts:2337`), variadic parameters (`:5683`, `:6010`), and
splices (`:930`). I confirmed all three parse today. So the grammar now has to
keep `.`, `..`, and `...` apart, and a typo like `[3...6]` needs a defined
outcome.

This also gives the spec a stronger argument than the one it makes. Lines 298-303
reject `...` as an inclusive-range spelling on the grounds that it differs from
`..` by one character and is a known bug source in Ruby. True, but the decisive
reason is simpler: **`...` is already taken.** That is not a preference, it is a
conflict, and it makes the decision unarguable rather than merely well-argued.

---

## Smaller notes

**The "AST forgets the spelling" rule already has an exception, in the parser
being edited.** Lines 320-325 state the rule as load-bearing. It is. But the
match-arm parser at `lib/parsers/parsers.ts:3968` carries this comment:

```ts
// A block body is remembered as such (`blockBody`), so the
// formatter can preserve the author's choice of form.
```

So that parser already records an authorial choice for the formatter's benefit.
The arrow is not that choice, so section 3 is fine as proposed. But the rule
should be stated as "the *variations in this spec* are not recorded," rather than
as a general property of the AST, or the next person to apply the rule will trip
over the counterexample sitting six lines from their edit.

**`function` is a legal identifier today; this is a small breaking change.** I
confirmed `const function = 5` parses right now. Adding `function` to
`RESERVED_WORDS` and to the body-declaration probe makes that an error. I grepped
all `.agency` files in `stdlib`, `tests`, `examples`, and `lib/agents`: 101 files
mention the word, but every occurrence I sampled is prose inside a docstring, not
an identifier. So in-repo impact looks like zero. It is still a compatibility
break for user code and belongs in the changelog line the spec already plans for
`fmt` (line 423).

**The nested-`function` bug is real and live right now.** The spec argues at lines
131-152 that `bodyDeclarationParser` must learn the new keyword. It is right, and
the risk is not hypothetical. Today:

```ts
node main() {
  function inner() { print(1) }   // parses fine
  print("x")
}
```

parses without complaint, whereas the same code with `def` produces the targeted
error "node and def declarations are only legal at the top level of a file." So
the misparse the probe exists to catch is *already reachable* through the
`function` spelling. That is a small independent bug, and it strengthens the
spec's case: the probe change is not just bookkeeping that accompanies the
feature, it fixes something broken today.

**Testing omits the formatter fixture suite.** The testing section covers
co-located parser tests and formatter idempotence, but there is a `tests/formatter/`
fixture directory and a `make fixtures` target. Parser changes usually mean
regenerating fixtures. If these variations need no fixture updates, saying so
explicitly would save the implementer a worried detour.

**Consider one execution test for ranges after all.** Line 352 says execution
tests are not needed because a range becomes a `range()` call that already works.
That reasoning holds for the three token swaps. For ranges it is doing slightly
more work, since the lowering is new and the loop-header position is where a
mistake would actually show. Agency execution tests need no LLM calls, so one
`for (i in 3..6)` test that asserts it prints three numbers is nearly free
insurance against the silent-single-iteration failure described above.

**The `range` shadowing note deserves one more sentence.** Line 305-308 correctly
flags that a file defining its own `range` would silently retarget every range
literal. Worth also confirming the reverse direction: the lowering assumes `range`
is in scope via the standard-library prelude, so it needs a defined behavior in
any file where the prelude is not injected — including the standard library's own
`index.agency`, where a range literal would be circular. Probably a non-issue, but
cheaper to answer now than to discover.

---

## What I verified, and what I did not

Every source claim in the spec checks out. I read each cited location:

| Claim | Location | Verdict |
|---|---|---|
| `await`/`sync` accepted and discarded | `parsers.ts:2857` | correct |
| `capture(str("def"), "keyword")` | `parsers.ts:5730` | correct |
| keyword destructured away and dropped | `parsers.ts:5848` | correct |
| `bodyDeclarationParser` probes `node`/`def` | `parsers.ts:4584` | correct |
| `RESERVED_WORDS`, doc comment says extend it | `parsers.ts:215` | correct |
| only consumer is template hole-filling | `runtime/template/fill.ts:375` | correct, sole consumer |
| `functionReturnTypeParser` uses `char(":")` | `parsers.ts:5703` | correct |
| both `def` and `node` delegate to it | `parsers.ts:5757`, `:5918` | correct |
| match arms require `str("=>")` | `parsers.ts:3968` | correct |
| inline blocks require `str("->")` | `parsers.ts:3795` | correct |
| block *types* already accept both arrows | `parsers.ts:1765` | correct |
| `numberParser` accepts unlimited dots | `parsers.ts:600` | correct |
| generator emits `def` unconditionally | `agencyGenerator.ts:1176` | correct |
| generator emits `:` before return type | `agencyGenerator.ts:1129` | correct |
| `range` documents an exclusive end | `stdlib/index.agency:281` | correct |
| `[3..6]` silently misparses | — | reproduced |
| trailing comments parse | — | reproduced |

I also checked the claim that the change surface is narrow, which the spec asserts
implicitly by saying the generator needs no changes. It holds. Outside the parser,
`"def"` appears only as an internal kind tag in the typechecker and
`lib/stdlib/agency.ts`, and as one completion label at `lib/lsp/completion.ts:97`.
There is no TextMate or tree-sitter grammar in the repo to keep in sync. So the
blast radius really is the parser plus documentation.

**Limitations of this review.** I read the parser combinators but did not run the
implementation, because these are unimplemented changes — my claims about greedy
consumption in `many1WithJoin` and about arrow disambiguation are reasoning from
the source, not measurements, and both should be settled by tests rather than by
my confidence. I did not evaluate the four variations against real agent
transcripts, so I have no opinion on whether these are the right four; the spec is
already honest that this list came from intuition, and its "measure before batch
two" section is the correct instinct. I did not review the documentation changes
in detail beyond confirming the trailing-comment claim in
`docs/site/guide/basic-syntax.md` is genuinely wrong.

---

## Recommendation

Fix the range syntax question, then implement. Sections 1 and 3 are ready as
written. Section 2 needs its ambiguity claim corrected and one added test.
Section 4 needs both the syntax decision and a sharper statement of the
number-parser fix.
