# Review: Effects across file boundaries — implementation plan

Review of
`/Users/adityabhargava/agency-lang/docs/superpowers/plans/2026-07-25-cross-module-effects.md`.

Written 2026-07-25.

---

## Verdict

The task breakdown is right, the ordering is right, and the churn-counting steps
in Tasks 2 and 3 are exactly the discipline this change needs. Most of the code
in the plan will work as written.

Two things will not, and both are the kind that a passing test suite would not
catch on its own. The first silently deletes an effect from the whole program.
Fix those two before starting, because both change code the later tasks build
on. Then four more things are worth changing, and one is a question about
altitude that I think has a good answer the plan should record.

---

## Blocking

### 1. Task 3 wipes `std::guard` out of the entire program

`buildSummaries` computes a function's direct effects by walking its body:

```ts
const facts = collectBodyFacts(node.body);
summaries[keyOf({ file, name })] = { ..., effects: [...facts.effects], ... };
```

and `writeBack` then overwrites `sym.interruptEffects` with that summary.

But a body walk is not where `_guard` gets its effect. I read
`stdlib/index.agency:595`. The body of `_guard` contains no `interrupt`
statement at all — it calls three TypeScript helpers, and the trip is raised on
the TypeScript side at runtime. Its `std::guard` label comes entirely from the
seed table `TS_SIDE_EFFECT_SEEDS` in `lib/symbolTable.ts:509-520`, which
`collectDirectInterruptEffects` applies by name.

So the new pass gives `_guard` a summary of `[]`, `writeBack` replaces its
seeded `["std::guard"]` with `[]`, and then every function that resolves a
callee to `_guard` inherits nothing. Cost caps stop being visible to the policy
file, to the docs, to the `raises` checks, and to the editor.

That is a safety regression of the same shape as the bug being fixed, and it
would land in the commit whose message says "Closes #680". Task 3's own
`std::guard` test catches it, which is good, but the plan's Step 5 debugging
hint sends the reader after import resolution instead of the seed. They will
look in the wrong place.

**The fix, and it is a simplification.** Do not recompute direct effects. The
symbol table already computed them, seeds included, when `classifySymbols` ran.
Seed each summary from the symbol:

```ts
const sym = table.getFile(file)?.[name];
const direct = (sym?.kind === "function" || sym?.kind === "node")
  ? (sym.interruptEffects ?? []).map((e) => e.effect)
  : [];
summaries[keyOf({ file, name })] = { file, name, effects: [...direct], calleeKeys: ... };
```

`collectBodyFacts` is then used only for `callees`, which is what the propagation
actually needs from it. One place computes direct effects, not two, which is the
same argument the plan makes for sharing the walk.

Worth a comment saying why, because the next person will see a body walk sitting
right there and wonder why its `effects` field is ignored.

I checked whether other standard library functions have this shape. They do not:
the `git` functions declare `raises <...>` **and** contain a literal `interrupt`
(`stdlib/git.agency:136-146`), so the walk finds them. `_guard` is the only
seed-only case today, which is what makes it easy to miss and worth a named
test.

### 2. Task 2's end-to-end tests cannot pass, because AG3009 has its own walk

Task 2 Step 3 asserts that `node main() { let y = read.invoke("a.txt") }` starts
producing the AG3009 unhandled-interrupt warning once the shared walk understands
`.invoke()`. It will not, and the plan has no step that would make it.

`checkUnhandledInterruptWarnings` (`lib/typeChecker/interruptAnalysis.ts:385-415`)
does not use `collectFromBody` at all. It runs its own walk and looks up the call
site directly:

```ts
if (node.type !== "functionCall") continue;
const kinds = interruptEffectsByFunction[node.functionName];
if (!kinds || kinds.length === 0) continue;
```

For `read.invoke(...)` the node it reaches has `functionName === "invoke"`, so
the lookup misses and the warning never fires — regardless of what the shared
walk now knows. The same function's `displayName` line, which rewrites `_guard`
to `guard` for the message, would print `invoke` if the lookup ever did hit.

So Task 2 needs an explicit step: give `checkUnhandledInterruptWarnings` the same
receiver resolution, by exporting the helper from `effectWalk.ts` and using it
where `node.functionName` is read. Once you look, check every other consumer that
keys on a call site rather than on a function:

- `checkCallbackBodyInterrupts` (`interruptAnalysis.ts:485`) matches calls named
  `callback`, which is never written with `.invoke()`. Fine as is.
- `callFlows` in `lib/typeChecker/functionTypeRaises.ts:106` deliberately returns
  nothing when the parent is a `valueAccess`, with a comment explaining that a
  method call resolves against the chain rather than a same-named global. That
  exclusion stays correct for real method calls, but it now also excludes
  `h.invoke(cb)` argument flows from the AG3014/AG3015 checks. Decide whether
  that is acceptable and write the decision down; do not leave it undiscovered.

Until this is done, Task 2's second test — "agrees with the plain call form" —
is the one that matters, and it is the one that will fail.

---

## Important

### 3. The completeness tripwire does not test anything

Task 1 Step 7 is:

```ts
expect([...CALL_BEARING_NODE_TYPES].sort()).toEqual(
  ["functionCall", "gotoStatement", "guardBlock", "interruptStatement"].sort(),
);
```

This compares a constant to a copy of itself. It fails only when someone edits
`CALL_BEARING_NODE_TYPES` — which is the one situation where they were already
thinking about this file. The failure it is supposed to prevent is someone adding
a construct and never touching `effectWalk.ts` at all, and this test is silent
for exactly that.

The real exposure is not the four-name list. It is that `walkNodes` hand-enumerates
its expression descent, one `else if` per node type, from `lib/utils/node.ts:355`
onward. A new expression form that holds a call and is not added there is
invisible to every analysis in the compiler, not just this one.

A tripwire that would actually fire: parse every `.agency` file under `stdlib/`,
scan each parse tree for `functionCall`, `interruptStatement` and `guardBlock`
nodes with a plain recursive walk over object properties — deliberately not
`walkNodes` — and assert that `collectBodyFacts` reports every one of them that
sits inside a function or node body. That compares two independent readings of
real code, so it fails when the walker gains a blind spot. Keep the constant if
you like it as documentation, but do not count it as the tripwire the spec asked
for.

### 4. `.invoke()` detection handles only the first link in a chain

`invokeReceiver` requires two things: that the walked call is `chain[0]`, and
that the last ancestor is the `valueAccess`. Both are narrower than the shapes
that occur.

`fetchJSON.partial(method: "GET")` is real Agency —
`tests/agency-js/http-post/agent.agency:28` — and `tests/agency/pfa-bound-block-invoked.agency`
binds a partial and then invokes it. Written inline,
`fetchJSON.partial(method: "GET").invoke()` puts `invoke` at `chain[1]`, so
`first.functionCall !== node` and the receiver is dropped. `.rename()` chains the
same way (`tests/agency/tool-rename.agency`).

The ancestor requirement has a second hole. In `walkNodes`, the `assignment`
branch descends into an access chain passing `[...ancestors, node]` where `node`
is the assignment, not the `valueAccess` (`lib/utils/node.ts:394-417`). Any call
reached through that branch has an assignment as its last ancestor and returns
null.

Both cases fail closed, which is the right direction, but both fail silently. I
would write `invokeReceiver` to scan ancestors backwards for a `valueAccess`
whose chain contains a `methodCall` link whose `functionCall` is this node, and
attribute to the base when the base is a plain variable name. That covers the
partial-then-invoke chain and does not depend on descent order. Then add the
chained case to the tests, since it is the shape the standard library's own
fixtures use.

### 5. Task 5's agreement test is circular

The test compares the symbol table's `interruptEffects` for `caller` against
`getEffectsFromFile(entryPath)["caller"]`, and calls that two independent routes
to the same answer.

They are not independent. `getEffectsFromFile` runs the type checker through
`runCheckerPipeline` (`lib/compiler/typecheck.ts:100-133`), which builds a symbol
table and hands it to `buildCompilationUnit`. `buildCompilationUnit:342-364` seeds
`interruptEffectsByFunction` for every imported name straight from
`sym.interruptEffects` — the field the new pass just wrote. For an imported
function, the type checker is reading the symbol table's answer back out. The
test cannot fail for the case it exists to guard.

It is still worth having as a regression test, but call it what it is. To actually
catch resolver drift you need a case each side computes for itself, which means a
function whose effects come from calls **within the file being checked** — a local
helper reached via `.invoke()`, a local `guard` block — where the type checker
propagates through its own scopes and the new pass through its own summaries.

There is also a genuinely independent oracle available; see the altitude note
below.

### 6. Task 8 builds a whole symbol table per splice, inside the compile path

`checkGeneratorEffects` starts with `SymbolTable.build(absolute, config)`. That
crawl walks and parses every reachable file including the whole prelude — the
plan's own numbers put it at about 55ms cold — and it now runs the propagation
pass on top. `checkGeneratorEligible` is called once per splice site from the
`CHECKS` array (`lib/preprocessors/expandSplices.ts:216-221`), so a file with ten
splices pays it ten times.

Thread a table in instead. `expandSplices` already takes an `options` argument,
and its callers have a table in hand — `runCheckerPipeline` builds one two lines
before it calls `expandSplices`. Passing it through `DecisionContext` keeps the
check honest and costs nothing.

While you are in there: `SymbolTable.build`'s crawl **skips a file it cannot
parse** and keeps going (`lib/symbolTable.ts:172-179`, deliberately best-effort).
A generator that imports an unparseable file therefore gets an empty effect list
from a reading that saw nothing. Given this check is fail-closed by design, that
is a fourth reason to refuse, alongside the three the plan names.

---

## Smaller things

**`declaredName` is already in a leaf module.** Task 3 says to import it from
`lib/symbolTable.ts` and, if that creates a cycle, move it somewhere leaf. It
lives in `lib/types/hole.ts:36` and `lib/symbolTable.ts` imports it from there.
No cycle, no move. Drop the contingency so the executor does not go looking.

**Task 1 Step 6 predicts churn that cannot happen.** It warns that `guardBlock`
handling may change what `collectFromBody` reports. It cannot: the TypeChecker
constructor calls `desugarGuardsInBody` on the whole program before anything
collects scopes (`lib/typeChecker/index.ts:111`), so no `guardBlock` node ever
reaches the type checker's walk. Harmless, but it sends someone hunting for a
diff that will not appear. The ordering note about `callees` is real and worth
keeping.

**The thrown-message assertion is a guess.** Task 7 Step 2 asserts
`.toThrow(/not defined in/)`. What was measured is that a relative import throws
`ImportResolutionError`; the message text was not. Assert the error type, or run
it once and paste the real message.

**Task 7's permissions test reimplements the thing it tests.** It copies the
union loop from `lib/cli/policy.ts:12-28` into the test rather than calling it,
so it will keep passing if `uniqueInterruptEffects` changes. Export that function
and call it. The comment about `policyGen` calling `process.exit` justifies not
driving the whole command, and that part is right.

**Counts to correct.** `lib/perf/` holds eight performance tests, not three
(compile, doc, fmt, harness, lint, lsp, parse, typecheck). The return in
`SymbolTable.build` is at `lib/symbolTable.ts:277`, after the re-export loop —
the plan's "around line 280" is close enough, and Task 4 Step 2 already names the
ordering constraint, which is the part that matters.

**Say why `parseAgency(src, {}, false)`.** The third argument is `applyTemplate`,
and passing false is what keeps the injected prelude import out of the test's
parse tree. That is fine here, but someone will copy the line into a test where
it matters. One clause of explanation.

---

## Addendum: does the test plan test what it says it does?

Three questions, taken in turn: will a test fail if the code breaks, will it fail
for a reason that has nothing to do with the code, and what is not covered at all.

The honest summary is that the fixtures are well built — temp directories, real
multi-file layouts, `safeDeleteDirectory`, assertions on effect lists rather than
on internals — and the two churn-counting steps in Tasks 2 and 3 are the strongest
safety net in the plan. But five of the tests cannot fail for the reason they
claim, three will fail because the Agency in them is not valid, and the walk's
riskiest property has no test at all.

### Tests that cannot fail for the reason they claim

**The handler-typing test (Task 6 Step 3).** It asserts `expect(report.errors).toEqual([])`
and comments that "the parameter carrying a `filename` field is what proves the
handler was typed from `std::read`". It proves no such thing. If the parameter
falls back to a loose type, reading `req.filename` off it is also fine, and the
test still passes — the fallback is exactly what the test says it is ruling out.
Make it bite by reading a field that does not exist on the `std::read` payload and
asserting that this **errors**. Only a parameter with the real payload type can
produce that error.

**The same-name test (Task 3).** It writes `risky.agency` and `safe.agency`, both
defining `h`, imports from `safe.agency`, and asserts no effect leaks. But
`SymbolTable.build` only crawls files it can reach from the entry point, and
nothing imports `risky.agency`. It is never parsed, never summarised, and cannot
collide with anything. The test passes today and would pass under a resolver that
ignored file identity entirely. Make both files reachable — import one name from
each — and the test starts guarding the `file:name` key it was written for.

**The deep-chain test (Task 2).** `expect(facts.callees).not.toContain("obj")`
passes when `callees` is empty, which it is for any reason at all, including the
walk silently dropping the whole statement. Assert the exact array you expect.

**The tripwire (Task 1 Step 7) and the resolver agreement test (Task 5)** are the
same problem in larger form; both are covered above under findings 3 and 5.

### Tests that will fail for reasons that are not the code

The plan writes Agency in several places that does not parse or does not check. I
ran each one.

**`guard(maxCost: 1.0)` is not valid** — `agency tc` gives
`AG6025: Unknown named argument 'maxCost' in call to 'guard'`. The parameter is
`cost` (`stdlib/index.agency:595`). This appears in Task 1's guard test and Task
3's guard propagation test, and it came in from the spec. Both of those tests
happen to run parse-only or symbol-table-only paths, so they may pass anyway — but
the snippet is wrong wherever it gets copied next.

**`handle std::read { approve() }` is not valid, and the structure is wrong too.**
The real form wraps the risky code:

```
handle {
  ...the code that can raise...
} with (intr) {
  return approve()
}
```

My attempt at the plan's version fails with "expected `{` to open handle block
body". More importantly, AG3009 suppression is purely lexical —
`isInsideHandler` (`lib/typeChecker/checker.ts:315-321`) walks the ancestor chain
for a `handleBlock` — so a call written as a *sibling* of the handle block warns
no matter what. The plan's "accepts the same call once it is handled" test has the
call outside the block and will report AG3009.

That matters more than a syntax slip, because the plan's note says: "If the last
test still reports AG3009 with a handler present, that is a real bug worth
stopping for. Handlers are safety infrastructure." That sends the executor into
the handler machinery chasing a fixture error. Rewrite the test with the call
inside the handle body, and delete that note or requalify it.

The handler-typing test (`handle std::read as req { ... }`) has the same problem.

**The AG3009 `.invoke()` tests (Task 2 Step 3)** will fail for a real reason —
see blocking finding 2 — but the plan predicts they will pass once the shared walk
lands, so the failure will read as a test problem rather than a missing step.

CLAUDE.md asks for Agency in plans to be checked against the guide and existing
fixtures before it ships. Worth doing a pass over every snippet: `docs/site/guide/interrupts.md`
for `handle`, `docs/site/guide/partial-results.md` for `finalize` (which the guide
places at the end of a function body, not alone in a node), and `stdlib/index.agency:595`
for `guard`.

### Missing coverage, most valuable first

**Nothing tests that the walk descends into nested bodies.** Every unit test in
Task 1 uses a body with a single top-level statement. The walk's real job is
finding a call inside an `if` inside a `while` inside a `match` arm, or inside a
`guard` body, a `handle` body, a `callback` body, a `finalize`. `walkNodes`
hand-enumerates its expression descent, one branch per node type from
`lib/utils/node.ts:355` — that is where a hole would be, and no test looks there.
Add one fixture with a call nested three levels deep, and one with a call inside a
`guard` body (which also pins that a guard contributes both `_guard` and whatever
its body calls).

**Nothing tests calls in expression positions.** A call as an argument to another
call, inside an array or object literal, in a ternary branch, in a string
interpolation, as a `match` case value. Same reasoning as above.

**Nothing would catch propagation running the wrong way, or unioning everything.**
Every propagation test asserts that a caller gains its callee's effect. A buggy
pass that gave every function in a file every effect found anywhere in it would
pass all seven. Add two: a risky caller with a clean callee, asserting the callee
stays clean; and two unrelated functions in one file, asserting one does not pick
up the other's effects.

**No graph node anywhere in Task 3.** Every fixture uses `export def caller`. The
reported bug is `node main() { h() }`, and `agency policy gen` reads node symbols.
Task 6 and Task 7 use nodes, so this is covered downstream, but the propagation
suite should carry the shape the issue was filed about.

**`export * from` is untested.** Task 4 covers named re-export at one and two hops.
`mergeExportsFrom` has a separate `starExport` branch (`lib/symbolTable.ts:585-597`),
and a star re-export is the ordinary way to write a barrel. Add it, plus
`export { h as g } from`, since re-export renaming goes through a different path
than import renaming.

**`import node { ... }` is untested.** `makeResolver` handles `importNodeStatement`
via `resolveImportedNodes`; nothing exercises it.

**The invariant has no test.** The plan states in Task 9 that the type checker may
find more effects than the shared walk, never fewer. After Task 1's extraction,
deleting `calleeDeclaredEffects` and `functionRefsInArgs` from `collectFromBody`
would break nothing in the new suite — the type-aware half is exactly what the
refactor risks dropping. Add a direct test: a function-typed parameter carrying a
`raises` clause, asserting the type checker reports that label and the shared walk
does not.

**`_guard` itself.** Given blocking finding 1, assert directly that after the pass
`_guard` still reports `std::guard`. The cross-file guard test covers it
indirectly; this one names the regression.

**AG3014 and AG3015 have no test**, though the plan counts them among the five
error-pushing consumers and the `.invoke()` interaction with them is unresolved.

**The documentation consumer has no test.** Task 7 regenerates with `make doc` and
asks the executor to read the diff. The spec asked for a test covering a function
whose effects come from a call rather than a literal `interrupt`. Eyeballing a
diff once does not stop it regressing.

**Task 8 tests one blind spot of three.** The parameter case is there; the
unexpanded splice in a reachable callee and the function reference held in a
variable are not, and those are the two the design leans on hardest. There is also
no positive control that an ordinary clean generator still runs — "nothing existing
breaks" is doing that job implicitly.

**No test for a file that fails to parse mid-crawl.** The crawl is deliberately
best-effort (`lib/symbolTable.ts:172-179`), and the editor hits half-typed files
constantly. Cheap test, guards against the pass throwing where the crawl chose not
to.

### What is well chosen

Task 8's "allows a clean generator that imports from a messy file" is the test that
proves the call-graph scoping decision, and it would fail loudly under the
file-scoped rule the design rejected. Task 3's cycle test is real. The
`getEffectsFromSource` `runFile` test pins the exact hole the spec measured, with
the measured value. And Task 1 Step 6's full-suite parity check is the right
instrument for a refactor — it is worth more than any single assertion in the
file.

---

## Addendum: the plan's code against `docs/dev/anti-patterns.md`

Checked every code block in the plan against the catalog. The clean bill first:
no dynamic imports, no empty `catch`, no `...(cond ? { x } : {})`, no nested
ternaries, dictionaries keyed by file paths use `Object.create(null)` and
`Object.hasOwn` as the house pattern requires, file deletion goes through
`safeDeleteDirectory`, and no test would do damage if it failed — the temp-dir
tests are the good shape.

The module boundaries are good too, which is the part that matters most for the
"declarative interface over encapsulated complexity" question.
`collectBodyFacts(body) -> BodyFacts` and `propagateEffects(table, programs)`
are both interfaces a caller can use without knowing anything about walking or
fixpoints. The `makeResolver` closure is a genuinely nice one: callers say
`resolve(name)` and never learn what an import statement looks like.

What is not clean is the inside of two of those functions, and one case where
"declarative" was achieved by writing a second copy of code that already exists.

### Reimplementing the propagation loop that is already there

This is the biggest one, and it is the same argument Task 1 makes for the walk.

`runToFixpoint` is a triple-nested loop with a `changed` flag. The codebase
already has that algorithm, split into two named functions:
`propagateTransitively` and `propagateFromCallees`
(`lib/typeChecker/interruptAnalysis.ts:167-193`). Same fixpoint, same
membership check, same growth-only reasoning. The only difference is field
names — `kinds`/`callees` there, `effects`/`calleeKeys` here.

So the plan writes a third propagation loop into a branch whose entire premise
is that two copies of one analysis drift apart. If they drift — one dedupes,
one does not; one follows an edge kind the other skips — the symptom is an
effect meaning different things on either side of an import. That is the bug.

Extract it. Something like `propagateToFixpoint(nodes: Record<string, { effects: string[]; calleeKeys: string[] }>)`
in the same leaf module as the walk, called by both. The type checker's
profiles need renaming to fit, which is a small mechanical change and worth it.

If it turns out they cannot share — say the type checker's version must stay
keyed by local name — then say so in the plan in a sentence, the way Task 5
justifies keeping two resolvers. An unexplained duplicate is the problem, not
duplication that has been argued for.

Two smaller instances of the same thing:

- `addUnique` is copied verbatim into `effectWalk.ts`. The original is at
  `lib/typeChecker/interruptAnalysis.ts:247`, in the very file that will now
  import from `effectWalk`. Export it from the leaf module and delete the
  original.
- `originOf` follows `reExportedFrom`, and Task 5's debugging hint then says to
  make the type checker's `makeCalleeResolver` "follow `reExportedFrom` too".
  That is the same hop written twice, in the two functions the plan already
  worries will diverge. `originOf` needs nothing but `table.getFile`, so put it
  in the shared module and call it from both.

### Loops where the catalog asks for a pipeline

`collectBodyFacts` builds three arrays by mutating an accumulator inside a
four-branch `if`/`else if` chain. `buildSummaries` and `writeBack` are both
nested loops with `continue` guards writing into a dictionary. The catalog's
"imperative code everywhere" entry asks for the filter/map/dedupe form, and its
worked example is almost exactly the shape of these functions.

I would not insist on rewriting `collectBodyFacts`: the branch chain mirrors
the type checker's existing walk, which makes the two easy to compare, and
that is worth something on this branch specifically. But `buildSummaries` and
`writeBack` have no such excuse and read better as pipelines over
`Object.entries`.

One phrase repeats three times across the module:

```ts
const summary = Object.hasOwn(summaries, key) ? summaries[key] : undefined;
```

and in `writeBack` it recomputes `keyOf(origin)` on two consecutive lines. Give
it a name — `summaryAt(summaries, key)` — and the three call sites read as what
they mean.

Finally, `propagateEffects` is three steps where the second mutates what the
first returned and the third reads the result, so the order is load-bearing and
invisible. Having `runToFixpoint` return the settled summaries instead of
mutating in place makes the pipeline say so:

```ts
const settled = runToFixpoint(buildSummaries(table, programs));
writeBack(table, settled);
```

The existing `analyzeInterruptsFromScopes` mutates in place too, so this is a
preference rather than a violation. It is a one-word change and it removes the
order dependency the catalog warns about.

### A magic number guarding something that cannot happen

```ts
function originOf(table: SymbolTable, at: Origin, depth = 0): Origin {
  if (depth > 32) return at;
```

Three problems in two lines. `32` is a magic number. Exceeding it returns a
wrong answer silently, which is the empty-`catch` failure mode wearing
different clothes — an effect would go missing with nothing logged. And the
guard is defending against a re-export cycle that `SymbolTable.build` already
detects and throws on, by name, in its own `resolveReExports` walk (the
"Re-export cycle detected" error). By the time `originOf` runs, a cycle has
already been rejected.

So: drop the depth parameter, or, if you want belt and braces, throw with the
chain in the message the way the existing cycle check does. Do not return a
quietly wrong origin.

### The `programs()` accessor leaks the crawl's internals

Task 8 proposes adding a `programs()` accessor to `SymbolTable` so
`reachableFrom(table, programs, start)` can be called. That hands every caller
the raw parse trees and asks them to pass the table and its own programs back
in as two separate arguments — the caller has to know those belong together.
It is the catalog's leaky-abstraction entry.

`reachableFrom(table, start)` with the module getting bodies from the table
itself is the interface that hides the seam. The plan's self-review already
flags this function as the one place an executor must make a design call, so
this is the design call: keep the parse trees private.

`BodyFacts.calls` — handing back every call node so the type checker can
re-read arguments without a second walk — is a milder version of the same
thing, and I think it earns its keep. Keep the comment explaining why it is
there, since without it the field looks like an internal that escaped.

### Nits

Single-character names appear in the test helpers and the resolver loops (`p`,
`r`, `e`). The surrounding code does the same, so this is consistency against
the catalog rather than a clear violation, but `p` in a `write` helper may as
well be `filePath`. Two assertions in the resolver-agreement test pack a
condition, a map, and a sort onto one line; splitting them costs nothing.

---

## Altitude: there is already a cross-file interrupt analysis

`lib/analysis/interrupts.ts` builds a symbol table, type-checks **every reachable
file**, and merges the per-file call graphs by `${file}:${name}` key
(`loadCallGraph`, lines 84-94). That is the design the spec measured at roughly
fifteen times the cost and rejected — and it is already in the tree, already
shipping.

I do not think this changes the decision. The new pass has to run inside
`SymbolTable.build`, where type checking is not available, so it cannot be that
code. But the plan should say so in a sentence, because right now the branch adds
a third effect-propagation loop to a codebase that has two, and the next reader
will ask why.

It also hands you the honest oracle that Task 5 is missing. `analyzeInterrupts`
reaches its answer by type-checking each file separately, which does not read
`sym.interruptEffects` for its call edges. Comparing the new pass against it on
the same fixtures is a real cross-check rather than a round trip. Worth trying
before falling back to the in-file cases from finding 5.

---

## What is good

- Tasks 2 and 3 each stop and count breakage before fixing any of it, with the
  commands written out and a threshold for escalating. That is the right shape
  for a change with this reach.
- The three-way classification in Task 2 Step 6 (expectation was wrong, fixture
  regenerates, program always needed a handler) gives the executor a decision
  procedure instead of a judgement call, and the ban on suppressing with
  `@tc-ignore` is exactly right for this branch.
- Every API the plan calls, I checked, and they exist with the shapes given:
  `typeCheckSource(source, sourcePath?)` returning `{errors, warnings}`,
  `getEffectsFromSource`, `getEffectsFromFile`, `makeAgencyTempDir`,
  `safeDeleteDirectory`, `table.filePaths()`, `reExportedFrom`, the free AG8003
  and AG8004 codes. That is unusual and it saves the executor real time.
- The self-review names its weak points instead of claiming coverage, and
  refusing to guess a churn number is the right call.

---

## Suggested order

1. Fix finding 1 in Task 3's `buildSummaries` before writing any of it.
2. Add the `checkUnhandledInterruptWarnings` step to Task 2, and decide the
   `functionTypeRaises` question while you are there.
3. Rewrite `invokeReceiver` per finding 4, in Task 1, before Task 2 depends on it.
4. Replace the tripwire in Task 1 Step 7 with the corpus version.
5. Rework Task 5 around a case that is not circular.
6. Thread the symbol table into Task 8 rather than rebuilding it.
