# Plan review: guard annotation threading (#580)

**Reviewing:** `docs/superpowers/plans/2026-07-17-guard-annotation-threading.md`
**Verdict:** Executable, and unusually well-verified — every code fact I
spot-checked held, including the one the whole design rests on. Both spec-review
round-2 fixes are genuinely folded, not just name-checked. **One substantive
gap:** the return-target reset rule keys on `blockAncestor`, which marks only
`functionCall` block arguments — but inline handler bodies and finalize bodies
*also* retarget `return`, so they inherit the def's type and can be mis-stamped.
That is the same bug class the plan exists to fix, just through a different
slot. Plus one cheap coverage gap the plan's own honesty note implies. No
blockers.

All line references are `packages/agency-lang/`, verified today on the
`guard-annotation-threading` worktree.

---

# What I verified (so these can be taken as settled)

- **`blockAncestor` is real and covers non-inline blocks.** `bodySlots.ts`'s
  `case "functionCall"` sets `blockAncestor: block` for *any* `n.block`, with no
  `inline` check. This matters: guards desugar with `inline: false`, so had the
  marker been inline-only the entire reset rule would silently no-op. It isn't.
  (Note the `BodySlot.blockAncestor` doc comment *says* "the functionCall's
  inline `block:` argument" — the comment is misleading, the code is right.
  Worth fixing that comment while you're in there.)
- **Every AST type string the tests assert on is correct:** `assignment`
  (`types.ts:221`), `returnStatement` (`types/returnStatement.ts:5`), `function`
  and `graphNode` and `functionCall` (all confirmed as `bodySlots` switch cases).
  `Assignment.typeHint?: VariableType` exists (`types.ts:225`), and
  `ResultType.successType` is at `types/typeHints.ts:158-160`. Task 1 can be
  written as drafted.
- **Targeting only the ~1775 push site is correct.** There are three
  `scopes.push({ type: "block", blockName })` sites. 1775 is inside
  `processBlockArgument` — the one guards reach (the desugared `_guard`
  `functionCall.block` flows through `processBlockArgument`, called at 2734 /
  2781 / 2802). 1829 is `processBlockAsExpression` (a block as a standalone
  expression / named-arg value) and 2852 is the fork lowering; neither ever
  carries a guard's block argument. **The plan is right — but say so** (see
  minor 4), because a reader who greps will find three sites and wonder.
- **The nesting composition is sound.** `desugarGuardBlock` stamps the unwrapped
  `T` and then walks its own body with `{ returnTarget: T }`, and a nested
  `return guard(){}` unwraps *again* via `yieldTypeFrom`. I traced
  `Result<Result<string>>`: outer stamp `Result<string>`, inner stamp `string`. ✓
  And the degenerate `Result<string>` case correctly stamps nothing on an inner
  return-position guard (`yieldTypeFrom("string")` → undefined), which is right,
  because a guard returning `Result<T>` into a `string` slot is a type error the
  checker owns.

# Substantive

## 1. The reset rule misses two other return-retargeting boundaries

`slotContext` resets the return target on exactly one condition:
`slot.blockAncestor`. But `blockAncestor` is set by `bodySlots` for *one* node
kind — `functionCall` with a block. Look at what else `bodySlots` yields:

- **`handleBlock`** returns two slots: `n.body` and, when
  `n.handler.kind === "inline"`, `n.handler.body`. Neither carries a
  `blockAncestor`. An inline handler compiles to its own arrow function
  (`async (i) => { ... }`), so a `return` inside it returns from the *handler*,
  not the def.
- **`finalizeBlock`** returns one slot, no `blockAncestor`. The finalize body
  compiles into the `__finalize` closure, so a `return` there returns the
  finalize's value.

Both therefore fall through `slotContext` to the `return ctx` inherit branch, and
a `return guard(){}` inside either gets stamped with the **enclosing def's**
`Result<T>`. That is exactly the mis-stamp the fork-branch test in Task 1 Step 1
exists to prevent — the plan closed the block-argument door and left the handler
and finalize doors open.

Severity is moderate-low (these are exotic shapes), but note the failure is
**silent**: the stamp only feeds `draftSchema` and `responseFormat`, which are
best-effort hints, so a wrong stamp produces a wrong schema, not a compile error.
Nothing catches it. That is the same reason the fork case was worth guarding.

There is a wrinkle that makes the naive fix awkward: `slotContext(node, slot, ctx)`
receives the *node*, and for `handleBlock` the two slots need **opposite**
treatment — `n.body` should inherit (a return in the guarded body returns from
the def), `n.handler.body` should reset. A `node.type === "handleBlock"` check
cannot tell them apart.

Two ways out, in order of preference:

- **Mark it at the source of truth.** `bodySlots` already exists to be the one
  place that knows the shape of every body-bearing node ("Adding a new
  body-bearing node type means adding ONE case here"), and it already carries a
  per-slot marker for a structurally similar fact. Add
  `retargetsReturn?: boolean` to `BodySlot`, set it on the `functionCall` block
  slot, the inline-handler slot, and the `finalizeBlock` slot. Then the rule is
  one line — `if (slot.retargetsReturn) return { returnTarget: slot.blockAncestor?.declaredYieldType }`
  — and the next construct that retargets `return` gets handled by whoever adds
  its `bodySlots` case, instead of silently regressing this feature.
- **Or scope it out explicitly.** Keep `blockAncestor`, and add a Task 1 test
  asserting a `return guard(){}` inside an inline handler and inside a finalize
  stamps **nothing**, with a comment saying handler/finalize return positions are
  deliberately unstamped. That is honest and cheap, but it is a decision that
  should be written down rather than an omission.

Either is fine; the first is better altitude and is a genuinely small change.
**Do not leave it undecided.**

## 2. No codegen test that a structured annotation produces a structured `draftSchema` — the one assertion the fixture provably cannot make

The plan's Background says plainly (and correctly) that no fixture outcome can
distinguish a threaded schema from the fallback, so "the distinguishing
assertions live in the codegen tests." Good. But then check what the codegen
tests actually assert for a structured type:

- The four threading tests assert `draftSchema: z.string()` — a **primitive**,
  and in the return-position case indistinguishable from the pre-change
  `Result`-shaped thread only by absence.
- The one structured test (`Result<{ title: string }>`) asserts **only**
  `responseFormat: z.object(...)`. It never asserts the `draftSchema`.

So the object-schema path for `draftSchema` — rendering a structured
`VariableType` through `zodSchemaFor` into the tool definition — is asserted
**nowhere**: not in the codegen tests, and not in the fixture (by the plan's own
admission). The spec's Part 3 test list explicitly asked for "a structured
`Result<Report>` annotation threads the object schema for **BOTH** consumers";
only one consumer got the assertion.

**Fix:** extend the existing structured test to assert both in one shot —
`expect(out).toMatch(/draftSchema: z\.object\(/)` alongside the `responseFormat`
match. One line, and it closes the only untested rendering path in the feature.

# Minor

## 3. Nothing pins the double-run idempotency, and the second run computes context differently

The desugar runs twice (`typescriptPreprocessor.ts:331`, `typeChecker/index.ts:111`)
on the same in-place-mutated nodes. Run 2 finds no `guardBlock` nodes, so it
stamps nothing and the run-1 stamps survive — that reasoning is right. But note a
subtlety the plan doesn't mention: on run 2, `slotContext`'s
`blockAncestor.declaredYieldType` read is **no longer always undefined**, because
the guard blocks are now stamped. So the two runs walk with genuinely different
contexts. It's harmless today (nothing left to stamp), but it means the
`blockAncestor.declaredYieldType` read earns its keep only on run 2 — worth a
one-line code comment so it doesn't read as dead code, and worth a two-line test:
call `desugarGuardsInBody` twice on the same body and assert the stamp is
unchanged. Cheap insurance on an invariant the whole pass depends on.

## 4. Say why the other two block push sites are deliberately unstamped

Task 2 Step 3 targets `~1775` without explaining the other two. I confirmed
1775 is correct and exclusive (see verified facts), but add one sentence naming
`processBlockAsExpression` (1829) and the fork lowering (2852) as never carrying
a guard block — otherwise the first executor to grep will either wonder or
"helpfully" stamp all three.

## 5. Test-sketch hygiene and two fragile assertions

- Task 1 Step 1's code block defines `guardBlockArgOf`, whose body is
  `throw new Error("use direct path reads in each test instead")`, and the prose
  below then says to delete it. Just remove it from the block — a plan that tells
  you to write dead code and then delete it invites someone to paste it and move
  on.
- `expect(out).not.toContain("responseFormat")` matches against the whole
  generated file. It works for that specific source, but it's brittle to any
  unrelated emission. Scoping it to the guard's own call region (or asserting on
  the `runPrompt` args object) is sturdier.
- Every test uses `def`. `slotContext`'s `node.type === "graphNode"` branch is
  never exercised — one return-position test in a `node main(): Result<string>`
  would pin it.

# What is right

The Background section does real work: each of its six facts is load-bearing for
a later task, and I checked all six against the code rather than taking them —
they hold, including the `bodySlots` `blockAncestor` claim that the entire reset
rule stands on, and the "both consumers are already wired to the right lookups"
claim (`typescriptBuilder.ts:3190` really does call `scopes.returnType()`, so the
`responseFormat` half of this feature is genuinely free). That is the difference
between a plan that asserts and a plan that has been verified.

The round-2 fixes are folded for real, not cosmetically: Task 1 Step 4 is a
*rewrite* of the walk rather than a patch, which is the honest shape for adding
context to a context-free recursion, and the return-target reset is implemented
(via `slotContext`) *and* pinned (via the fork-branch test) rather than merely
described. The `desugarGuardsInBody(body, ctx = {})` default keeping both entry
points source-compatible is the right call.

Best thing in the plan: the Background's "what the e2e fixture can and cannot
pin" paragraph, repeated verbatim in the fixture's own comment. Naming the limit
of your own test at the point a future reader will meet it is exactly the rigor
that was asked for — finding 2 above is just holding the plan to that standard
one step further.

# Recommended next steps

1. Decide finding 1 — either add `retargetsReturn` to `BodySlot` (preferred) or
   add the handler/finalize no-stamp tests plus a written decision. This is the
   one correctness gap worth closing before execution.
2. Add the `draftSchema: z.object(...)` assertion to the structured test
   (finding 2) — one line, closes the only untested rendering path.
3. Add the double-run stamp-stability test and the `blockAncestor` comment
   (finding 3).
4. Fold findings 4 and 5 in as written; none change the design.

---

# Addendum: audit against `docs/dev/anti-patterns.md`

**Direct answer to "does it write declarative interfaces that encapsulate
complexity, or imperative code?": the instincts are right and applied
inconsistently.** Task 1 extracts the feature's two hard rules into pure,
named functions — and then writes a third rule of exactly the same kind inline
and imperatively. Task 2 goes further: it *argues itself out* of the declarative
form, on a premise I checked and found false. Six findings, ordered by how much
they bear on that question.

## A1. The stamp rule is inlined and imperative — while its sibling rule is extracted (*Imperative code everywhere* + *Order-dependent mutable state*)

The feature has exactly two rules. The plan extracts one and inlines the other.

Extracted, declarative, good — `slotContext(node, slot, ctx)` answers "what
context does this body walk under?" as a pure function. Inlined, imperative —
"what type does a guard in this position get stamped with?", sitting in the
middle of `desugarNode`:

```ts
let stamp: VariableType | undefined;
if (node.type === "assignment") {
  stamp = yieldTypeFrom(holder.typeHint);
} else if (node.type === "returnStatement") {
  stamp = yieldTypeFrom(ctx.returnTarget);
}
holder.value = desugarGuardBlock(valueNode as GuardBlock, stamp);
```

That is a `let` mutated across an if/else-if chain to produce one value — the
shape the *Order-dependent mutable state* entry says to replace with a `const`
derived from its inputs. And it is the *same kind of rule* as `slotContext`,
written the opposite way. Extract it:

```ts
/** The type a guard sitting in this node's `value` slot is stamped with:
 *  an assignment names its own slot; a return yields to the current
 *  return target; anything else stamps nothing. */
function stampFor(node: AgencyNode, ctx: DesugarContext): VariableType | undefined {
  if (node.type === "assignment") {
    return yieldTypeFrom((node as Assignment).typeHint);
  }
  if (node.type === "returnStatement") {
    return yieldTypeFrom(ctx.returnTarget);
  }
  return undefined;
}
```

Then the walk reads `holder.value = desugarGuardBlock(valueNode, stampFor(node, ctx))`,
and the whole feature is legible as two small pure functions — "what context does
a body get" and "what stamp does a guard get" — with `desugarNode` reduced to
pure traversal. That is the what/how split the catalog is asking for. Bonus:
`stampFor` reads `typeHint` off a properly-typed `Assignment`, so the `typeHint`
member drops off the `holder` cast and it narrows back to the original
`{ value?: unknown }`.

## A2. `enclosingDeclaredReturnType` abandons `.find()` for a hand-rolled loop — on a false premise (*Imperative code everywhere* + *Inconsistent patterns*)

Task 2 Step 4 replaces the existing `.find()`-based method with a `for...of` over
a reversed copy using `continue` and four `return`s, and justifies it in
parentheses:

> (A `for...of` over a reversed copy with an early `continue` — the two-list
> `.find` from #578 cannot express "skip unstamped blocks but stop at stamped
> ones".)

**It can.** That requirement is one predicate:

```ts
const owner = [...this.stack]
  .reverse()
  .find((scope) => scope.type !== "block" || scope.declaredYieldType !== undefined);
```

"The first scope that either isn't a block, or is a stamped block" is exactly
"skip unstamped blocks, stop at stamped ones." The existing method's `switch`
then needs one new arm (`case "block": return owner.declaredYieldType;`) and
nothing else changes. So the real diff is **one predicate edit plus one switch
case** — instead of a rewrite that discards the method's structure, its
explanatory comment about the push invariant, and the `.find` idiom the
neighbouring `returnType()` and the #578 original both use.

This is the most consequential finding in the addendum, not because the loop is
wrong (it works) but because the plan wrote down a justification for going
imperative and the justification doesn't hold. An executor will read that
parenthetical and not re-check it.

## A3. `desugarGuardBlock` builds by mutation what the original built as one literal (*Order-dependent mutable state* + *Ugly code* + *Inconsistent patterns*)

The current function returns a single expression. The plan's replacement builds
the same node in three ordered steps:

```ts
const block: { type: "blockArgument"; inline: boolean; params: never[];
               body: AgencyNode[]; declaredYieldType?: VariableType } = {
  type: "blockArgument", inline: false, params: [], body: [],
};
if (yieldType !== undefined) { block.declaredYieldType = yieldType; }
block.body = desugarGuardsInBody(g.body, { returnTarget: yieldType });
```

Three separate problems, all avoidable:

1. **Build-by-mutation.** Declare-empty → conditionally-add-field → assign-body
   is order-dependent accumulation replacing a declarative literal. Straight
   *Order-dependent mutable state*, and a regression from the code being replaced.
2. **The conditional-field dance is the banned idiom in a new spelling.** The
   catalog's *Ugly code* entry bans `...(x ? { x } : {})` outright; the `if`
   version is the same avoidance of an `undefined`-valued key. It isn't needed:
   the field is optional, and **an absent key is equivalent to a key set to
   `undefined` for every consumer here** — the Task 2 copy passes it through,
   the reads are `?? undefined` / `!== undefined`, `JSON.stringify` (so
   `pnpm run ast`) drops undefined-valued keys so no fixture churn, and the
   plan's own `toBeUndefined()` assertions pass either way. Just always assign it.
3. **The inline structural type annotation** exists only to make the conditional
   assignment typecheck, and is a nested object type written inline
   (*Nested objects in type definitions*). It disappears with the literal.

All three dissolve at once:

```ts
function desugarGuardBlock(g: GuardBlock, yieldType: VariableType | undefined): AgencyNode {
  return {
    type: "functionCall",
    functionName: "_guard",
    arguments: g.arguments,
    block: {
      type: "blockArgument",
      inline: false,
      params: [],
      declaredYieldType: yieldType,
      body: desugarGuardsInBody(g.body, { returnTarget: yieldType }),
    },
    scope: "imported",
    loc: g.loc,
  } as unknown as AgencyNode;
}
```

One literal, no mutation, no inline type, no conditional — and it preserves the
shape of the function it replaces, which is the *Inconsistent patterns* half.

## A4. Structural casts that shadow types the codebase already names (*Leaky abstractions* + *Nested objects in type definitions*)

```ts
slot: { blockAncestor?: { declaredYieldType?: VariableType } }
```

`BodySlot` is **exported** from `lib/utils/bodySlots.ts:34` (I checked), and
`BlockArgument` is a named type. This inline nested structural literal
re-describes a shape the codebase owns, so if `BodySlot` changes, `slotContext`
keeps compiling against a stale shadow. Use `slot: BodySlot`. Same for
`(node as { returnType?: VariableType | null })` — `FunctionDefinition` and
`GraphNodeDefinition` are already imported by `bodySlots.ts`, so the import is
free. The plan's prose actually says "adjust the casts to the actual types rather
than `any` where the imports are cheap" — the drafted code just doesn't do it,
and executors paste what's drafted.

## A5. A one-line `if` (*One-line if statements*)

```ts
if (t && t.type === "resultType") return t.successType;
```

Literal catalog entry. Brace it. (Task 2's code is correctly braced throughout —
this is the only instance.)

## A6. `?? undefined` on an already-optional field (*Useless special cases*)

```ts
case "block":
  return scope.declaredYieldType ?? undefined;
```

`declaredYieldType` is `VariableType | undefined`; the coalesce is a no-op.
`return scope.declaredYieldType;` says the same thing. (Note the surrounding
method uses `?? undefined` meaningfully — to collapse `null` from
`functionDefinitions[...]?.returnType` — so this reads as cargo-culted from its
neighbours.)

## Not anti-patterns (checked, to be fair)

- **No duplicated code.** I searched for an existing Result unwrapper: there is
  **no** `isResultType` and no shared `successType` helper anywhere in `lib/`.
  The unwrap is inlined at `checker.ts:1023`, `checker.ts:1073`, and inside
  `typeToZodSchema.ts` / `validationDescriptor.ts`, but nothing is exported to
  reuse. So `yieldTypeFrom` is **not** a duplication violation — writing it is
  correct. (Adjacent observation, not a finding: it becomes the fourth private
  spelling of the same unwrap. If a shared `resultSuccessType` is ever worth
  having, this is the natural moment — but do not build it as scope creep here.)
- **The context design is genuinely not order-dependent mutable state.** The
  context is a parameter threaded down the walk, never stored on the module or
  the walker, and `desugarGuardsInBody`'s default keeps both entry points
  source-compatible. This was the single biggest anti-pattern risk in the whole
  feature — the spec explicitly rejected a builder-side pending field for being
  order-dependent — and the plan got it right. Credit where due; the plan's own
  Task 3 Step 4 audit note names this correctly.
- No nested ternaries. No dynamic imports. No unlogged catch blocks. No magic
  numbers. No `unlinkSync`. No catastrophic-failure tests. The guard-clause early
  return in `desugarNode` is a readability improvement, not a special case.

## Test-code nits (minor)

The Task 1 tests lean on `(n: any) => ...` throughout and use the single-char
name `n` (*Single character variable names*). Test code, low stakes, and `n` is
the file's existing convention in places — but `node` costs nothing, and typing
the finds would catch a renamed AST field at compile time instead of at
assertion time.

## Where this lands

A1, A2, and A3 are one theme seen three times: the plan knows how to write the
declarative form (it did, in `slotContext`, `yieldTypeFrom`, and `DesugarContext`)
and then didn't, in the three places where the imperative version was slightly
more convenient to draft. None of them change the design — they are all local
rewrites of code the plan already specifies, and A2 in particular makes the diff
*smaller*. A4–A6 are one-line cleanups. Fix A2's parenthetical justification
first: it is the only one that will actively talk an executor out of the right
thing.

---

# Addendum 2: the test plan

Two questions: will each test fail when the thing it guards breaks, and what is
missing? The desugar tests are mostly honest and the fork test in particular is
a genuinely good discriminator. But **one codegen test asserts on a program that
does not compile**, and chasing why led somewhere much bigger than a test bug:
**the `responseFormat` half of this feature may not be reachable by any
type-correct program.** That finding is T1 and it should be settled before
execution starts.

Everything below marked "verified" was run against the current build on `main`
(which contains #574), not reasoned about.

## Tests that will not fail when the code breaks

### T1. Task 2 test 4 asserts on a program the checker rejects — and that exposes a possibly-dead feature half

The test source is:

```ts
def f(): Result<{ title: string }> {
  return guard(cost: $1) {
    return llm("hi")
  }
}
```

**Verified — this does not typecheck:**

```
AG2001: Type 'Result<string, any>' is not assignable to
        type 'Result<{ title: string }, string>' (return in 'f').
```

The checker synthesizes `llm("hi")` as `string` (no expected type is pushed into
it), so the block yields `Result<string>`, which is not the declared
`Result<{ title: string }>`. I checked the spec's *primary* annotation form too,
in case return-position was the problem — same error:

```
const r: Result<{ title: string }> = guard(cost: $1) { return llm("hi") }
→ AG2001: Type 'Result<string, any>' is not assignable to
          type 'Result<{ title: string }, string>' (assignment to 'r').
```

So the test is green-or-broken for the wrong reason either way: if `gen()` runs
the typechecker the test errors out; if `gen()` skips it, the test passes while
pinning codegen for a program the compiler would reject. Neither outcome tells
you the feature works.

**The larger problem this uncovers.** The `responseFormat` change is only
*observable* when the annotation is structured — a `Result<string>` annotation
produces the same string default the block already had. So ask: is there any
type-correct program where the stamp changes the emitted `responseFormat`? I
tried all three shapes and verified each:

| Program shape | Typechecks? | `responseFormat` today | After the stamp | Stamp observable? |
|---|---|---|---|---|
| `Result<string>` + `return llm("hi")` | ✓ (verified) | string default (none emitted) | string | **No** — identical |
| `Result<{title}>` + `return llm("hi")` | ✗ **AG2001** (verified, both forms) | — | — | **Unreachable** |
| `Result<{title}>` + `const x: {title} = llm(...)` | ✓ (verified) | **already `z.object({...})`** (verified in generated JS) | `z.object({...})` | **No** — the assignment annotation already did it |

That third row is the Task 3 fixture's own shape, and I compiled it: it emits
`responseFormat: z.object({` **today**, before any of this work, driven by the
assignment's type hint rather than the scope return type. So in the one shape
that both compiles and is structured, the stamp contributes nothing.

**I could not construct a type-correct program where the `responseFormat` stamp
changes behavior.** I am stating that as a failure to find one, not a proof that
none exists — but the plan should not proceed on the assumption that it does
without producing one.

This contradicts two things the plan and spec currently assert: the Background's
"Making both answer a stamped block fixes both features," and decision 1's
accepted "visible behavior change" for `responseFormat` inside annotated guard
blocks. If the change is invisible, the owner agreed to a trade-off that does not
occur.

The root cause is precisely the thing the plan excludes. "Why the checker needs
no changes" is right for `draftSchema` (a runtime hint the checker never sees)
and wrong for `responseFormat` (which describes a value the checker *does* type).
`return llm("hi")` infers `string` because `synthGuardCall` synthesizes from the
block's returns with no expected type pushed inward; teaching the checker to
propagate the block's declared yield into the `llm()` call is what would make row
2 compile — and only then is the stamp load-bearing.

**Three ways out, owner's call:**
- **(a)** Produce a type-correct program where the stamp is observable and rebuild
  test 4 on it. If someone finds one, everything else here stands and this is just
  a test fix.
- **(b) Descope `responseFormat` from this PR** — drop the `returnType()` block
  case, ship `draftSchema` alone (which is genuinely reachable and genuinely
  fixed), and record the `responseFormat` hole as still open, blocked on checker
  work. This is my recommendation: it shrinks the diff, removes the behavior
  change that needed justifying, and stops the feature claiming something it does
  not deliver.
- **(c)** Extend scope to the checker so row 2 compiles. Real work, and a
  different PR.

### T2. The vacuous negative assertions in Task 2 tests 1 and 3

```ts
expect(out).not.toContain("draftSchema: Report");
```

`zodSchemaFor` renders a *zod* schema, so the fallback for a `Report` return
emits `draftSchema: z.object({ title: z.string() })` — the literal text
`"draftSchema: Report"` never appears in generated output, with or without the
bug. The assertion cannot fire. The positive assertion in each test
(`toContain("draftSchema: z.string()")`) is doing all the work; the negative is
false comfort that reads like a second guard.

Replace with the shape the fallback would actually emit:
`expect(out).not.toMatch(/draftSchema: z\.object\(/)`.

## Tests that are weaker than they look

### T3. Task 1 test 1 does not visibly discriminate its two candidate sources

```ts
def f(): string {
  const r: Result<string> = guard(cost: $1) { return "x" }
}
```

The annotation's `successType` is `string` and the def's declared return is also
`string`. To be fair, I traced the likely bugs and the test *does* catch them (an
implementation reading `ctx.returnTarget` would call `yieldTypeFrom("string")` →
`undefined` → assertion fails). So this is not a false negative. But nothing in
the test *shows* a reader that the annotation is the source, and Task 2 test 1
gets this right by making the def `Report` and the annotation `string`. Make the
def's return type differ here too (`def f(): number`) so the test is
self-evidently discriminating rather than accidentally so.

### T4. Task 2 test 5's `not.toContain("responseFormat")` is correct today but scans the whole file

Verified: a string-typed llm call emits no `responseFormat` at all (only the
annotated-assignment probe produced one), so the assertion holds. But it matches
against the entire generated module, so any unrelated `responseFormat` emission
anywhere in the file — now or later — breaks it for reasons that have nothing to
do with this feature. Scope it to the `runPrompt` args for that call.

## Missing tests

### M1. Nothing unit-tests the `enclosingDeclaredReturnType` walk directly

`scopeManager.test.ts` already exists (it unit-tests `blockFrameVar` by pushing
scopes onto a `ScopeManager` directly), so the harness and precedent are both
there. The new walk is the trickiest logic in Task 2 — stamped block answers,
unstamped block defers outward, stamped-inside-unstamped, block under a `node`
rather than a `function` — and every one of those paths is currently tested only
through string-matching on generated TypeScript, two layers away. Four direct
unit tests would localize failures and cover combinations no codegen test spells
out. **This is the most valuable addition after T1.**

### M2. No regression guard that `returnType()` still answers `undefined` for an *unstamped* block

Task 2 changes `case "block"` on a method with five callers. Task 2 test 5 covers
it only indirectly (via absence of `responseFormat`). One direct assertion —
push an unstamped block scope, expect `returnType()` to be `undefined` — pins the
half of the change that must *not* move.

### M3. `slotContext`'s inherit branch has no coverage

Every `return`-position test puts the `return` directly in a def body, which is
the *capture* branch (the function's own body slot). No test puts a
return-position guard inside an `if` / `while` / `for` — slots with no
`blockAncestor` on a non-function node, which must **inherit**. If someone made
`slotContext` reset on every slot, all existing tests still pass. Add:

```ts
def f(): Result<string> {
  if (cond) { return guard(cost: $1) { return "x" } }
  return guard(cost: $1) { return "y" }
}
// expect the guard inside the `if` to be stamped `string`
```

That is the positive counterpart to the fork test, and together they pin both
directions of the rule.

### M4–M8 (carried from the main review, listed here for one checklist)

- **M4.** No `graphNode` test — `slotContext`'s `node.type === "graphNode"` branch
  is never exercised.
- **M5.** No handler / finalize retarget test (main review finding 1) — whichever
  way that decision goes, it needs a test.
- **M6.** No double-run stamp-stability test (main review finding 3).
- **M7.** No `let r: Result<T> = guard(...)` test; the spec says "`let` alike."
  One line, and it pins that the stamp reads the assignment node rather than
  const-specific handling.
- **M8.** No codegen assertion that a structured annotation yields
  `draftSchema: z.object(...)` (main review finding 2) — note this one survives
  even under option (b) above, since it is the `draftSchema` consumer.

## What the tests get right

The fork test (Task 1 test 5) is the best test in the plan and it is genuinely
load-bearing: I traced the no-reset case and it stamps `string` where the test
expects `undefined`, so removing the reset rule fails it loudly. That is the
round-2 spec fix pinned properly rather than merely described. The
`Result<Result<string>>` composition test is a real two-level check that would
catch a single-unwrap bug, and the `Result<number, string>` test correctly
discriminates `successType` from `failureType`. Task 2 test 2 is also a true
discriminator: pre-change that call site emits the whole Result-shaped zod, so
`z.string()` can only appear if the unwrap works. And the fixture's own comment
naming what it cannot pin is the right instinct — T1 above is what happens when
that same skepticism is applied one level further out.

## Priority

1. **Settle T1 before writing any code.** Either produce a type-correct program
   where the `responseFormat` stamp is observable, or descope `responseFormat`
   (my recommendation) and ship the `draftSchema` half, which is real. This is an
   owner decision, not an executor one — it changes what the PR claims.
2. Add M1 (direct `ScopeManager` walk unit tests) and M3 (the inherit branch).
3. Fix T2's vacuous negatives and T4's whole-file scan; strengthen T3.
4. Add M2, M4, M6, M7, and M8; M5 follows whichever way finding 1 is decided.
