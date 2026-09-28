# What may sit at the top level of a file, and where a splice may sit

**Revision 2 (2026-07-29).** Revised after review
(`2026-07-29-top-level-statements-and-splice-positions-design-REVIEW.md`).
Four changes of substance: a corrected and safety-relevant table row for
`handle`, an ordering requirement Part 3 depends on and never stated, a
measured verdict on top-level interrupts that removes them from the allowed
list, and the message-building consumers of `Splice["position"]`. See
"Response to review" at the end.

Three problems that look unrelated and share one root.

- Writing `if (true) { … }` at the top level of a file crashes the compiler
  with an internal error and no file, line or column (issue #713).
- A splice on its own line inside a node body cannot use a generator that
  returns statements, which is the obvious thing to want there.
- A splice at the top level *can* use one, and produces TypeScript that does
  not parse.

The root is that nothing in the compiler answers the question "may this
statement sit at the top level of a file?" — so the grammar says yes to
everything, the backend assumes it was asked something sensible, and the
splice checker guesses.

---

# Part 1: which statements belong at the top level

## What happens today

Every one of these was compiled at the top level of a file, above an
ordinary `node main()`:

| Written at the top level | Result |
| --- | --- |
| `if (true) { print(1) }` | **crash** |
| `while (false) { print(1) }` | **crash** |
| `for (x in [1,2]) { print(x) }` | **crash** |
| `match(1) { 1 => print(1) }` | **crash** |
| `thread { print(1) }` | **crash** |
| `handle { … } with (e) { … }` | **crash** |
| `guard { print(1) }` | parse error |
| `try { … } catch { … }` | parse error |
| `handle read(p) { … }` (effect-scoped form) | parse error |
| `interrupt("x")` | compiles, **crashes at run time** |
| `static interrupt("x")` | compiles, **crashes at run time** |
| `return 1` | compiles |
| `goto other` | compiles |
| `debugger` | compiles |
| `print(1)` | compiles |
| `x = 1` | compiles |
| `const y = 2` | compiles |
| `static print(1)` | compiles |

Four groups, and only one of them is intentional.

**The `handle` row deserves attention beyond the table.** The block form
crashes; only the effect-scoped form is a parse error. Handlers are safety
infrastructure in this codebase — a top-level `handle` is a handler its
author believes is registered. Today it crashes, which is at least loud. The
failure mode to avoid while fixing this is worse: a change that routes it
into `__initializeGlobals` instead would make it compile and never register,
turning a crash into a silently absent handler. The rule below excludes
`handle` for that reason, and the diagnostic should say where handlers may
live rather than just refusing.

The crash is always the same one:

```
Error: StepPathTracker: currentId() called with empty path
    at TypeScriptBuilder.processIfElseWithSteps
    at TypeScriptBuilder.processNode
    at TypeScriptBuilder.processNodeInGlobalInit
    at partitionProgram
```

## Why it happens

Two independent decisions, each locally reasonable.

**The grammar accepts them.** The top-level alternation (`nodeParser`,
`lib/parser.ts:75`) includes `ifParser`, `forLoopParser`, `whileLoopParser`,
`matchBlockParser`, `messageThreadParser` **and `handleBlockParser`**.
`guard` and `try` are absent, which is why those two fail cleanly — the
difference between "parse error" and "crash" is nothing more than which
parsers happen to be in that list. It is not a design boundary, which is
why the fix belongs in a check rather than the grammar.

That `handle` sits in the list and was missed by the first version of the
table is the spec's own thesis demonstrating itself: a statement form nobody
considered, in a hand-maintained list, discovered only by someone re-running
the measurement. An exhaustive predicate is the fix for exactly that.

**The backend routes what it does not recognize into global init.**
`partitionProgram` asks `isTopLevelDeclaration`
(`lib/backends/typescriptBuilder/nameClassifier.ts:105`), whose set is:

```ts
const TOP_LEVEL_DECLARATION_TYPES = new Set([
  "graphNode", "function", "typeAlias",
  "importStatement", "importNodeStatement",
  "comment", "multiLineComment", "newLine",
]);
```

Anything not in that set, and not a `static` assignment, goes into the
per-execution `__initializeGlobals` body. That is right for `const x = 1`
and `print(1)`. For an `if`, it means the step machinery is asked for a step
path in a context that has none, and it throws.

**Note what that set is for.** It answers "where should this node be emitted
in the generated TypeScript" — a placement question. It is not, and should
not become, the answer to "is this legal Agency". Two different questions
that happen to overlap.

## The rule, and why it is the rule

Top-level code is **initialization, not execution**. It runs in the module's
init phases, which have no step machinery, no control flow, and no notion of
"where in a node am I". So a top-level statement may *establish* something —
bind a name, call something for its effect — but may not *control* anything.

That is not a list to memorize; it explains the list:

**Allowed at the top level**

- Declarations: `node`, `def`, `type`, `effect`, `effectSet`, imports,
  re-exports, skills, tags
- Assignments: `const x = …`, `let x = …`, `static const x = …`, `x = …`
- Expression statements: a function call, a value access
- Trivia: comments, blank lines

**Not allowed**

- Control flow: `if`, `while`, `for`, `match`, `thread`, `guard`, `try`,
  `handle`, `finalize`
- Node-relative statements: `return`, `goto`
- Interrupts — see below, and note this is a change from the first draft

The expression-statement row is not invented here. `staticStatementParser`
(`lib/parsers/parsers.ts:4706`) already enumerates a set for
`static <expression>`:

```ts
const innerParser = or(
  interruptStatementParser,
  functionCallParser,
  valueAccessParser,
);
```

Someone answered this question once already, for one construct. This spec
makes that answer general — minus one entry, for a measured reason.

## Interrupts at file scope are broken, so the rule excludes them

The first draft took `staticStatementParser`'s list at face value and put
interrupts in the allowed column. Measured, both spellings compile and then
die at run time:

```
$ agency run i.agency          # top level: interrupt("x")
Agent crashed: __self is not defined
  const __response = getRuntimeContext().ctx.getInterruptResponse(__self.__interruptId_);

$ agency run i2.agency         # top level: static interrupt("x")
Agent crashed: __self is not defined
```

So the parser's enumeration records a design *intent* that the backend does
not implement. That fits what is already known about interrupts needing a
running node — there is no node at initialization, and the generated code
reaches for a `__self` that does not exist.

**Recommendation: exclude interrupts from the allowed set**, and file the
runtime crash separately. Two reasons. A compile-time diagnostic saying "not
supported at the top level" is a better experience than
`__self is not defined` from generated JavaScript. And no working program
breaks, because there are none — both spellings already fail.

If the runtime gap is closed later, this is a one-row change to the
predicate, and the predicate's test is where that decision gets recorded.
Worth flagging in review: this makes `static interrupt(...)` a compile error,
and that construct was deliberately designed even though it does not work.

## The three compiling cases that should stop

`return 1`, `goto other` and `debugger` all compile at file scope today.

`return` outside any function and `goto` from no node are meaningless, and
the rule above excludes them: both are node-relative. Refusing them is a
small breaking change to programs that are already nonsense, and the error
is far better than whatever they currently generate.

`debugger` is worth a decision rather than an assumption. It parses as a
bare name resolving to a builtin, so under the rule it is a value access and
stays legal. That seems right — a breakpoint at module scope is meaningful —
but it is an accident of how `debugger` is represented rather than a
decision, so it should be recorded as one.

## How to express it

A single predicate, exhaustive over the node type:

```ts
isLegalAtTopLevel(node: AgencyNode): boolean
```

**Exhaustive is the important word.** The codebase already uses this trick:
`identifierSlots.ts` is typed over `AgencyNode` so that adding a node type
without an entry is a compile error. The same applies here, and for a
sharper reason — the failure mode being fixed is precisely "a statement form
nobody considered reaches the backend and crashes it". A `switch` over
`node.type` with no `default`, returning `boolean`, makes that impossible:
the next person to add a statement form is asked, at compile time, whether
it belongs at file scope.

Where it lives matters less than that there is one of it, but it should be
somewhere both the compile path and the splice checker can import without
either depending on the other — `lib/utils/` is where `holes.ts` sits for
the same reason.

## What consumes it

**The compile path**, which reports a diagnostic instead of crashing — see
the ordering requirement in Part 3, which this check has to satisfy. It needs
a code in the AG-numbered space like its neighbours; `AG3017` is the next
free slot in the structural range (`AG3016` is the current highest). The
message should name the rule rather than the symptom:

```
`if` statements are not allowed at the top level of a file. Top-level code
runs at initialization, which cannot branch — move it inside a node or a
function.
```

**The splice checker**, in Part 3.

An open question worth deciding on purpose: should the grammar also stop
accepting these, or should the check do all the work? Keeping the grammar
permissive and refusing later gives a better message (a parse error cannot
explain *why*), and matches how `guard`/`try`/`handle` currently fail *worse*
despite being rejected earlier. Recommendation: leave the grammar alone,
refuse in the check, and let the three currently-clean parse errors stay as
they are rather than churn the grammar for consistency's sake.

---

# Part 2: a splice inside a body is in statement position

## What happens today

```ts
import { callFunc } from "greeter.agency"

node main() {
  $( callFunc() )
}
```

where `callFunc` returns a statements fragment:

```
AG8007: The generator `callFunc` returned a `statements` fragment, but this
splice is in expression position and needs a `expr` fragment.
```

## Why

A splice records where it sits, and there are only two possibilities
(`lib/types/splice.ts:20`):

```ts
position: "decl" | "expr";
```

`spliceRest` stamps `"expr"` unconditionally (`parsers.ts:3251`), and
`topLevelSpliceParser` rewrites it to `"decl"`. A splice occupying a whole
statement inside a body has its own alternative in `_bodyNodeParser` — it
has to, because the expression path cannot reach it — but nothing rewrites
its position, so it stays `"expr"`.

The kind table then does its job correctly on the wrong input
(`lib/preprocessors/expandSplices.ts:465`):

```ts
const KINDS_FOR_POSITION = {
  decl: [...KINDS_FOR_SORT.decl, "statements"],
  expr: KINDS_FOR_SORT.expr,      // ["expr"] only
};
```

So the one place a generated statement list is most obviously useful is the
one place it is refused.

## The fix

Add the missing position: `"statement"`, stamped by the body-level splice
alternative the way `topLevelSpliceParser` stamps `"decl"`.

It maps to `KINDS_FOR_SORT.statements`, which already exists and already
means the right thing:

```ts
statements: ["statements", "program", "expr"],
```

That set is not new and needs no argument — it is what a statements *hole*
accepts, and it is right for the same reason: an expression is a legal
statement, and a program grafted into a body is judged when the completed
program compiles.

Two details follow from the position being new rather than reinterpreted:

- The expression form keeps `"expr"`, so `const x = $( gen() )` is unchanged.
- A splice in statement position may expand to several nodes, so the
  substitution has to spread rather than require exactly one — the same
  distinction `substituteInArray` already makes for template holes.

## Every consumer of `position`, including the ones the type will not catch

Widening `Splice["position"]` to three values is type-forced in one place:
`KINDS_FOR_POSITION` is `Record<Splice["position"], string[]>`
(`expandSplices.ts:465`), so a missing entry is a compile error.

It is **not** type-forced two lines below the lookup, where the mismatch
message is built with binary ternaries (`expandSplices.ts:556-557`):

```ts
expected: splice.position === "decl" ? "program" : "expr",
position: splice.position === "decl" ? "declaration" : "expression",
```

A third value flows through these silently and describes a statement-position
mismatch as "expression position needs an expr fragment" — precisely the
confusion Part 2 exists to remove. Replace both with an exhaustive switch, for
the same reason the predicate is one: the compiler should be the thing that
notices a new position, not a reader.

---

# Part 3: a splice at the top level is held to the top-level rule

## What happens today

```ts
$( callFunc() )      // callFunc returns a statements fragment

node main() {
  print("x")
}
```

```
Error: Transform failed with 1 error:
<stdin>:210:92: ERROR: Expected ")" but found ";"
```

An uncaught esbuild failure. No diagnostic, no location in the user's file.

Verified that this is specific to the combination: the same splice with a
generator returning a `program` fragment (a `def`) compiles cleanly.

## Why

`decl` has `"statements"` appended to it in the table above. So a statements
fragment passes the check, reaches the backend, and produces TypeScript that
does not parse.

That entry cannot simply be deleted, and this is the heart of the matter.
**Kind is the wrong granularity for the question.** One statements fragment
can hold both of these at once:

```ts
const apiKey = getKey()      // legal at the top level
if (debug) { log("hi") }     // crashes the backend
```

No fragment kind distinguishes them, because kind describes the fragment and
legality is a property of each node inside it. `decl: ["program"]` would be
wrong in the other direction — it would refuse a generator producing
`const apiKey = getKey()`, which is legal hand-written and should be legal
generated.

## The fix

Replace the kind entry with the predicate from Part 1. For a splice in
declaration position: accept a `program` fragment, or a `statements`
fragment **every node of which satisfies `isLegalAtTopLevel`**.

That gives the property worth having: **generated code is held to exactly
the same standard as written code, by construction.** Not by two lists that
have to be kept in agreement — by both calling the same function. Today's
bug is precisely what happens when they diverge, and the divergence is
invisible until something crashes.

The rejection message should name the offending statement, not the fragment:

```
The generator `callFunc` returned a statement that cannot sit at the top
level of a file: an `if` statement. Top-level code runs at initialization,
which cannot branch.
```

## A `program` fragment can carry the same crash, so the check must run after expansion

Scrutinizing only `statements` fragments leaves a hole, and it is
constructible today. The grammar accepts `if` at the top level — that is the
bug — so a fragment holding an `if` can infer kind `program` and pass the
splice check unexamined. Verified:

```ts
export static const call = [|
  if (true) {
    print(1)
  }

  def helper(): number {
    return 1
  }
|]
```

That literal infers `"kind": "program"` — the statements attempt fails on the
`def`, so inference falls through to the program parser — and splicing it at
the top level reproduces `StepPathTracker: currentId() called with empty
path` exactly as a hand-written `if` does.

**So Part 1's compile-path check is the real backstop, and it only works if
it sees expanded output.** That ordering is load-bearing and the first draft
never stated it:

> The structural check must run on the post-expansion AST, on every path
> that expands splices.

`docs/dev/splices.md` records five such paths, and all five run
`expandSplices` before import resolution today, so there is a consistent
place to land: the check goes in the pass that already runs after expansion
on all of them. Naming that pass, and adding a test per path is overkill —
but the one test that matters is a top-level splice whose generator returns
a `program` fragment containing an `if`, asserting a diagnostic rather than
a crash.

Additionally, and only for the message: run the per-node check on `program`
fragments at the splice site too. It is not needed for safety once the
ordering above holds, but it lets the error name the generator
(`The generator \`gen\` returned …`) instead of pointing at expanded code the
user did not write.

---

# What this changes for users

| Case | Before | After |
| --- | --- | --- |
| `if` / `while` / `for` / `match` / `thread` at top level | internal crash, no location | diagnostic naming the rule |
| `return` / `goto` at top level | compiles, means nothing | diagnostic |
| `const x = 1`, `print(1)`, `static print(1)` at top level | compiles | unchanged |
| `$( gen() )` in a body, statements generator | AG8007 | works |
| `$( gen() )` in a body, expr generator | works | unchanged |
| `$( gen() )` at top level, program generator | works | unchanged |
| `$( gen() )` at top level, statements generator, all legal | broken TypeScript | works |
| `$( gen() )` at top level, statements generator, contains an `if` | broken TypeScript | diagnostic naming the statement |
| `$( gen() )` at top level, **program** generator containing an `if` | internal crash | diagnostic |

Breaking changes to programs that compile today, all of them to code that
does not work:

- `return` and `goto` at file scope — meaningless there, and currently
  compiling into whatever the init phase makes of them.
- `interrupt(…)` and `static interrupt(…)` at file scope — both crash at run
  time today, so the change is a worse error becoming a better one.

Small exposure, but real behavior changes rather than pure fixes, and they
belong in the PR description rather than being discovered.

One asymmetry worth naming so nobody "fixes" it in passing: `x = 1` at file
scope is legal and stays legal, while inside a body assigning to an
undeclared name is rejected. Keeping the top-level form is the conservative
call — this spec is not the place to tighten it — but the difference is real
and currently undocumented.

---

# Testing

**The predicate**, as a unit, exhaustively: one case per node type, asserted
against the allowed/not-allowed lists above. This is the test that stops the
rule drifting, and it should read as the rule.

**The compile path**: each crashing form from the table now produces a
diagnostic with a file, line and column; each compiling form still compiles.
The whole table becomes a test, because the table is what nobody had.
Include the **block-form `handle`** row explicitly — it is the row the first
draft got wrong, and the one where a wrong fix is worst.

**The three lists cannot drift.** After this change three things describe the
top level: the grammar alternation (permissive by design), the placement set
`TOP_LEVEL_DECLARATION_TYPES` (where a node is emitted), and
`isLegalAtTopLevel` (whether it may be there at all). One cheap test closes
the triangle — every type in the placement set, plus the static-assignment
special case (`nameClassifier.ts:105-109`), satisfies the predicate. Then
placement can never route a node the predicate would have refused.

**Splices in statement position**: a statements generator works in a body; an
expr generator still works; a multi-statement generator spreads rather than
producing one node; and a kind mismatch in statement position produces a
message that says *statement* position, not expression position.

**Splices in declaration position**: a program generator works; a statements
generator whose nodes are all legal works; a statements generator containing
an `if` is refused with a message naming the `if`; and — the Part 3 hole — a
**program** generator containing an `if` is refused rather than crashing.

**End to end**, as an execution fixture: `bar.agency` / `greeter.agency` from
the original report — a generator returning `const res = llm(…)` and
`print(res)`, spliced into a node body — fills, compiles and runs.

---

# Out of scope

- Whether the grammar should also stop accepting control flow at the top
  level. Recommendation above is to leave it and refuse in the check; either
  way it is a separate change.
- The `AG8006` question raised alongside this: the import check is
  file-scoped while the effects check beside it is call-scoped, so a
  generator is refused for an import it never uses. Real, and worth its own
  spec — it is about *which* generators may run, not about *what* they may
  produce or *where* the result may go.
- Anything about `Code` fragments in templates. `KINDS_FOR_SORT` is not
  changed by this spec; Part 2 consumes an entry that already exists.

# Risk

The predicate is the whole change: if it is wrong in the permissive
direction a crash survives, and if it is wrong in the strict direction a
program that compiles today stops. The exhaustive switch is what contains
the first, and the behavior table above — every row measured, not assumed —
is what contains the second.

The splice parts are small once the predicate exists, and neither can fail
open: both replace a check that is currently either absent or wrong.

---

# Response to review

Review:
`2026-07-29-top-level-statements-and-splice-positions-design-REVIEW.md`. All
findings were re-measured before acting; all held.

- **Finding 1 (top-level `handle` crashes, not a parse error): accepted, and
  it was the more serious kind of error.** Confirmed the block form produces
  the same `StepPathTracker` crash as `if`, and that `handleBlockParser` is
  in the top-level alternation — so my "guard, try and handle are absent"
  sentence was wrong about a third of its subject. The row, the mechanism
  text and the test list are corrected, with the handler-specific risk named:
  the wrong fix here is not a crash but a handler that compiles and never
  registers. The review is right that this is the spec's thesis proving
  itself — a hand-maintained list missed a statement form, which is what the
  exhaustive predicate exists to prevent.
- **Finding 2 (a `program` fragment smuggles the crash past Part 3):
  accepted, and it is constructible today.** Built the case: a literal
  holding an `if` and a `def` infers kind `program` (the statements attempt
  fails on the `def`), and splicing it at the top level crashes. The ordering
  requirement Part 3 silently depended on is now stated as a requirement, with
  the test, plus the optional per-node check on program fragments for the
  better message.
- **Finding 3 (`position` has consumers the type will not catch): accepted.**
  The two ternaries are listed and get the same exhaustive-switch treatment
  as the predicate.
- **Finding 4 (measure top-level `interrupt` before allowing it): accepted,
  and the measurement changed the rule.** Both `interrupt("x")` and
  `static interrupt("x")` compile and then crash with `__self is not defined`.
  So the parser's enumeration records an intent the backend never
  implemented, and interrupts move to the not-allowed list with the reasoning
  and the runtime bug recorded.
- **Smaller points: all taken.** The placement-implies-legality test closes
  the triangle between the three lists; the `x = 1` asymmetry is named; the
  diagnostic gets `AG3017`, the next free slot in the structural range.
