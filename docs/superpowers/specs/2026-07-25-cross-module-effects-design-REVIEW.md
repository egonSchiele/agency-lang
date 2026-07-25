# Review: Effects across file boundaries

Review of
`/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-25-cross-module-effects-design.md`
(design for GitHub issue 680).

Written 2026-07-25.

---

## Verdict

The diagnosis is right, the measurements hold up where I re-checked them, and
the chosen fix — compute the transitive list once, at the end of building the
symbol table, and overwrite the field every consumer already reads — is the
right shape. The honest correction in Part 5 about `eligibility.ts` having no
effect check is accurate; I read the file and the comment says exactly what the
spec says it says.

Six things need to change before this becomes a plan. One of them (the first)
may change what you think the feature is worth.

---

## 1. The `.invoke()` call form is invisible to the effect walk, and the new pass inherits that

This is the finding I would act on first.

Agency lets you call a function two ways: `read("a.txt")` and
`read.invoke("a.txt")`. These parse into completely different trees. The plain
form is a `functionCall` node whose `functionName` is `read`. The `.invoke()`
form is a `valueAccess` node whose base is the variable `read` and whose chain
holds a method call — and that method call is itself a `functionCall` node whose
`functionName` is the string `"invoke"`.

Every effect walk in the codebase keys on `functionCall` nodes and reads
`functionName`. So for `read.invoke(...)`, the analysis records a call to a
function named `invoke`, finds nothing under that name, and moves on. The call
to `read` is never seen.

I measured this on a single file, with no imports involved at all:

```
node main() { let y = read("a.txt") }
  agency tc          → warning AG3009: 'read' may throw [std::read], not inside a handler
  agency policy gen  → "This agent can produce the following interrupts: - std::read"

node main() { let y = read.invoke("a.txt") }
  agency tc          → "No type errors found."
  agency policy gen  → "No interrupt effects found in this agent. No policy needed."
```

So the headline sentence in Part 3 — that a program which reads your filesystem
reports needing no permissions, as long as the reading happens in an imported
file — is understated. It does that in one file too, with no import anywhere,
if you write the call the way the project's own style prefers.

Why this matters for the design specifically: Part 4 says the new pass records
"the names of everything it calls," and Part 4's risk section proposes sharing
the walk with the type checker's `collectFromBody`
(`lib/typeChecker/interruptAnalysis.ts:139`). Sharing that walk means sharing
this hole. A helper in another file called as `h.invoke()` will still come back
clean, so the flagship repro is only fixed for one of the two ways to write it.

Three options, in the order I would prefer them:

1. Handle it in the shared walk as part of this work. When a `functionCall`
   node's name is `invoke` and the node sits in a `valueAccess` chain whose
   base is a plain variable name, record the base name as the callee.
   `lib/typeChecker/functionTypeRaises.ts:106` already inspects
   `ancestors[ancestors.length - 1]?.type === "valueAccess"` to detect this
   shape, so the ancestor information is available from `walkNodes` and the
   precedent exists. This is a small change with a large payoff, and it fixes
   the in-file case at the same time.
2. Fix it as its own issue, landing first, so this work builds on a walk that
   already sees both call forms.
3. If it is deliberately deferred, then say so in Part 4's blind-spot list and,
   critically, add it to Part 5's list of reasons to refuse running a
   generator. An empty effect list from a walk that cannot see `.invoke()`
   means nothing, which is exactly the argument Part 5 already makes for the
   other blind spots.

Whichever you pick, Part 8 needs `.invoke()` versions of the cross-module tests.

## 2. The blast radius is bigger than four consumers, and some of them produce errors, not warnings

Part 1 says four parts of the toolchain read the effect list, and Part 6 bounds
the breakage with the observation that the unhandled-effect warning only fires
for graph nodes. That bound does not hold, because several other consumers read
the same map and three of them push errors rather than warnings. An error
breaks a build; a warning does not.

The ones I found, all reading `interruptEffectsByFunction`, which is seeded from
the symbol-table field this design changes:

- **Callback bodies may not interrupt.** `checkCallbackBodyInterrupts`
  (`lib/typeChecker/interruptAnalysis.ts:485`) looks up the lifted callback
  function's effects and pushes the `interruptInCallback` **error** if the list
  is non-empty. Today a callback body that calls an imported wrapper looks
  clean and compiles. After this change it will not. That is arguably the
  correct new behaviour, but it is a hard error appearing in user code that
  compiles today, and it is not in Part 6.
- **Declared `raises` clauses.** `checkRaisesDeclarations` and
  `checkFunctionTypeRaises` (`lib/typeChecker/functionTypeRaises.ts:206-210`)
  compare a function's computed effects against what a `raises` clause allows,
  and emit `valueEffectExceedsRaises` / `valueMayRaiseAnyEffect` **errors**.
  A function whose true effect list grows will newly exceed a declaration that
  used to fit, and an imported function passed into a slot typed with a `raises`
  clause will newly be rejected.
- **Handler analysis.** `collectRaisableEffects`
  (`lib/typeChecker/interruptAnalysis.ts:430`) feeds both handler-offender
  detection and inline handler parameter typing. More effects means handler
  parameter types change shape. Given that handlers are the project's safety
  infrastructure, a change to what a handler's parameter is typed as deserves
  its own line in Part 6 and its own test, not an inherited consequence.

Please rewrite Part 1's "four parts" into the actual list, and have Part 6 count
breakage per consumer, separating errors from warnings. The promise to count and
report before fixing is good; it just needs to be counting the right set.

## 3. Re-exports break the file-and-name key

Part 4's identity scheme is `file:name`, resolved through the symbol table's
`resolveImport`. I read that method (`lib/symbolTable.ts:361`). It resolves the
import path to a file and looks the name up in that file's symbols. When the
file it lands on is one that re-exports the name from somewhere else, the symbol
you get back is a merged copy whose real home is recorded separately, in a
`reExportedFrom` field holding `{ sourceFile, originalName }`
(`lib/symbolTable.ts:674`).

So for `export { h } from "./helper.agency"` in `barrel.agency`, an importer of
`barrel.agency` produces the key `barrel.agency:h`. The new pass builds its
per-function summaries from parsed function definitions, and `barrel.agency`
defines no `h`. The lookup finds nothing and the effect is dropped — the exact
failure this design exists to remove, one hop further out.

The prelude happens not to hit this, because `stdlib/index.agency` defines
`read` itself with a literal `interrupt` rather than re-exporting it. So this
will not show up in the repro. It will show up in user code and in npm packages
that use a barrel file, which is the normal way to organise a library.

The fix is small: follow `reExportedFrom` to its origin when qualifying a
callee, and follow it repeatedly, since a barrel can re-export a barrel. Add it
to Part 4 and add a test to Part 8 — an effectful helper reached through one
re-export hop, and through two.

## 4. `guard` is one instance of a general problem: the two sides see different trees

Part 4 catches that the new pass sees a `guardBlock` node where the type checker
sees a `_guard` call, and handles it. Good catch. But it is presented as a
one-off, and it is not. The symbol table walks raw parse trees. The type checker
walks trees that several rewriting passes have already been through. Any pass
that creates, moves, or renames a call is another instance.

`lib/preprocessors/` currently holds: `guardDesugar`, `liftCallbacks`,
`expandSplices`, `parallelDesugar`, `hoistCalls`, `injectSchemaArgs`,
`prunePreludeShadows`, `resolveReExports`. The spec addresses one of these
directly and one (`expandSplices`) as a named blind spot.

The one I would look at hardest is `liftCallbacks`. In the raw tree, a
`callback("onX") { ... }` block sits inside the enclosing function's body, so a
walk over that body picks up the calls inside it and attributes them to the
enclosing function. By the time the type checker's interrupt analysis runs, the
block has become a call to a separately lifted top-level function named
`__cb_scope_N` — `checkCallbackBodyInterrupts` says so in its own comment
(`lib/typeChecker/interruptAnalysis.ts:476`) and looks the lifted name up
directly. If attribution differs between the two sides, then the same function
has two different effect lists depending on which side of an import you stand
on. That is the bug in a new costume, which is precisely the failure mode Part 4
already says it is trying to avoid.

I did not fully confirm the attribution difference — I confirmed only that a
graph node containing a `callback` block whose body calls `read` reports
`std::read` at the file level, which does not distinguish "attributed to `main`"
from "attributed to the lifted function". Worth ten minutes during planning.

What I would like in the spec: a short table with one row per preprocessor pass,
saying whether it creates, moves, or renames calls, and what the new pass does
about it. Even where the answer is "nothing, it does not touch calls," writing
the row is what makes the next person's addition safe.

## 5. Part 5's refusal rules are scoped to files, which will refuse nearly everything

Part 5 says to refuse running a generator if "the generator, or any file it
reaches," contains a splice, calls a function received as a parameter, or passes
a function around as a value.

"Any file it reaches" includes the prelude, which every file auto-imports, and
everything the prelude pulls in. Passing a function as a value is ordinary
Agency — `llm(..., { tools: [deploy] })` is the shape the spec itself cites in
Part 4. One occurrence anywhere in the reachable set refuses every generator in
the program, forever, with a message about a file the user never opened.

This is the same over-broad test the existing comment in
`lib/compiler/splice/eligibility.ts:181-194` rejects for effects, applied to
blind spots instead. Part 5 even says it is narrower than that approach. As
written it is not.

Scope the rules to the set of functions transitively reachable **from the
generator through the call graph** — which the new pass has to build anyway —
rather than to the set of reachable files. Then a generator that calls one
harmless helper from a file that also holds a function-valued argument
elsewhere still runs. Part 8's test list should include the case that motivates
this: a generator importing one clean function from a file whose other exports
are messy.

## 6. Sharing `collectFromBody` is the right instinct, and it is not sufficient

You asked for this part to be reviewed hardest, so:

Sharing the walk is correct and I would do it. But the walk is only one of three
places the two analyses can disagree, and sharing it makes the remaining two
easier to overlook because the shared piece looks like the whole answer.

- **Which units get summarised.** The type checker iterates `ScopeInfo` values
  and skips the one named `top-level`, with a comment
  (`lib/typeChecker/interruptAnalysis.ts:96-98`) explaining that skipping is
  needed because `walkNodes` descends into nested function bodies and would
  otherwise double-count. The new pass will iterate top-level `function` and
  `graphNode` declarations instead. Those two enumerations are not the same set
  — nested `def`s, block arguments, and lifted callbacks all land differently —
  and nothing forces them to stay in step. Write down which units each side
  produces and why that is the same answer, or make the enumeration shared too.
- **How a callee name becomes an identity.** The type checker's
  `makeCalleeResolver` (`lib/typeChecker/interruptAnalysis.ts:330`) resolves
  through `ctx.importedFunctions` and `resolveImportedNodes`. The new pass will
  resolve through `resolveImport`. Two resolvers, same job, and finding 3 above
  is already an example of them differing. Consider extracting the resolver too,
  or at least a shared test fixture that asserts both give the same key for the
  same source.
- **The extra work the type checker keeps.** Fine, as long as it is only ever
  additive — the type checker may find more effects, never fewer. Say that as an
  invariant in the spec, because it is what makes "the pass under-reports" a
  safe direction rather than an inconsistency.

Also: put the completeness tripwire on the **shared** function, not on the new
pass. A tripwire guarding a copy is worth much less than one guarding the
original.

---

## Smaller notes

**The command name is wrong.** The spec writes `agency policy yourprogram.agency`
in Part 1. The real command is `agency policy gen <file>`, and it is registered
as hidden (`scripts/agency.ts:1604-1616`). Worth fixing so a reader who tries it
does not get "unknown command", which is what I got.

**Where `agency serve` gets its list.** Part 4 lists the HTTP and MCP adapters as
readers of the symbol field. The `serve` CLI path threads an
`interruptEffectsByName` map out of the compile result
(`lib/cli/serve.ts:33-79`) rather than reading the symbol directly. Both end up
better with transitive effects, so the conclusion stands, but the sentence
"nothing wants the direct list" should be backed by the actual list of readers.
Worth also naming the consequence out loud: MCP tool descriptions handed to
language models will start listing more effects per tool.

**Incremental builds.** Nothing in the spec addresses cache invalidation. After
this change, what `main.agency` compiles to — and what `agency policy gen` says
about it — depends on the contents of files `main.agency` imports, in a new way.
Please check during planning whether the build manifest already treats a change
in a transitively imported file as invalidating, and say so in the plan either
way.

**The performance test.** Part 8 asks for a test asserting the pass does not
measurably slow the symbol table build, against a 2ms figure. A wall-clock
assertion at that magnitude will flake in CI. This repo just landed a
scaling-ratio performance suite that runs informational-first, which is the
right home for this. Use it rather than a raw millisecond threshold.

**Part 4's "thirteen callers" aside.** Fine, but it is used to support a claim
about `agency doc`, `agency pack`, and the editor paying for generator
expansion. Since type-checking and the editor already expand splices, the
argument that survives is purely about performance. Part 4 mostly says this
already ("This is a performance decision, not a safety one") — I would just cut
the surrounding sentences that imply the editor does not already do it, since
they invite the reader to re-litigate a point you have already conceded.

---

## What is good, and should not be lost in a rewrite

- Part 1 is the best background section I have read in this directory. Someone
  who has never seen the compiler can follow the bug from it.
- Every claim I spot-checked against code was accurate, including the small
  ones: the `_guard` seed table, the `resolveImport` behaviour, the
  `eligibility.ts` comment, the `policy.ts` merge line.
- Correcting your own earlier claim about `eligibility.ts` in the body of the
  document, rather than quietly, is worth keeping.
- The "what this does not do" and "what could go wrong" parts are specific
  rather than ceremonial. The promise to count breakage and report the number
  before fixing anything is exactly right.

---

## Suggested order of work

1. Decide the `.invoke()` question. It changes how much of the safety surface
   this actually closes.
2. Rewrite Part 1's consumer list and Part 6's breakage estimate against the
   real set of readers, separating errors from warnings.
3. Add re-export following to Part 4, and the preprocessor table.
4. Re-scope Part 5's refusal rules from files to the call graph.
5. Then write the plan.
