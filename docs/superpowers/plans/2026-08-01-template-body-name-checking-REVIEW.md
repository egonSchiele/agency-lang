# Review: Template body name checking — implementation plan

Reviewing `2026-08-01-template-body-name-checking.md`.

The plan is well organized, the TDD scaffolding is right, and it takes the
spec-review's prelude finding seriously (the prelude is called out as the
top constraint and gets its own test). But Task 1 picks the wrong scope model,
and it is wrong in exactly the direction the plan itself names as the whole
risk: over-rejection. As written it will reject most real templates, and the
test suite would stay green while it does. This is blocking.

## Blocking: one flat scope cannot model a template body's scoping

Task 1's `templateResolutionInput` builds **one** `Scope` for the entire
literal body:

```ts
const scope = new Scope("template");
walkScopeBody(nodes, scope, ctx);
```

and Task 2 then walks **every** `variableName` in the body — including names
inside nested `def`/`node` bodies — and resolves each against that single
scope. That does not match how Agency scopes work, and I verified it against
the code:

- `walkScopeBody` (`scopes.ts:418`) has cases for `assignment`, `importStatement`,
  `forLoop`, block/handler forms — but **no `function` or `graphNode` case**. It
  does not descend into a `def`/`node` body and it does not seed parameters.
- The real check does not use one scope. `buildScopes` (`scopes.ts:32`) returns a
  **list** of `ScopeInfo`, one per function/node body, and `buildDefScope`
  (`scopes.ts:57`) seeds each def's **parameters** into its own scope
  (`scopes.ts:71-73`) before walking that body. `checkUndefinedVariables` then
  iterates that list with `ctx.withScope(...)` and skips function/node bodies
  during the top-level pass (`hasFunctionOrNodeAncestor`).

So under the plan's model, this ordinary template:

```ts
static const t = [|
  def greet(name: string): string {
    return name
  }
|]
```

builds a flat scope that does **not** contain `name` (it is a parameter of a
nested def, which `walkScopeBody` never sees), yet the pass walks into
`greet`'s body, finds the reference `name`, resolves it → `unresolved` → emits
`AG8015` on a correct template. The same happens for any `const`/`let` declared
**inside** a nested def, since those locals are equally invisible to the flat
scope. In practice almost every non-trivial template defines a function that
uses its own parameters or locals, so the pass would fire on the common case.

There is also a second, opposite error hiding in the same model: because all
top-level bindings land in one scope, a name declared in one nested def would
resolve when referenced from a sibling def — an under-report. Less urgent than
the false positives, but it confirms the model is simply the wrong shape.

**Fix:** mirror `buildScopes`, do not hand-roll a flat scope. Build the same
per-body `ScopeInfo` list from the literal body (top-level scope plus one
param-seeded scope per nested def/node), and check each body against its own
scope, exactly as `checkUndefinedVariables` does — just with the template
resolution inputs (host dropped, prelude kept) and always-on. The cleanest
route is probably to run `buildScopes` against a context whose `programNodes`,
`functionDefs`, and `nodeDefs` come from the literal body's own
`buildCompilationUnit`, rather than to invent a parallel scope builder. Whatever
the mechanism, the requirement is: **parameters and nested-def locals must be in
scope; host names must not be.**

This changes the shape of Task 1's `templateResolutionInput` (it can no longer
return a single `scopeHas`) and Task 2's `checkBody` (it must iterate bodies,
not resolve everything against one scope). Worth reworking before writing code.

## The test suite hides this — add the cases that would have caught it

Every "says nothing" test in Task 2 uses either a top-level `const` in the
literal or a def with **no** parameters and **no** locals. None defines a
function that uses its own parameter, which is the exact pattern the flat scope
breaks on. So the suite would pass while the pass mis-fires on real templates.

Add these "says nothing" (green) cases before implementing, so the scope model
is forced to be correct:

- A literal defining `def greet(name: string): string { return name }` — must
  NOT report `name`. (Parameter in scope.)
- A literal defining a function with a local: `def f(): number { const x = 1; return x }`
  — must NOT report `x`. (Nested-def local in scope.)
- A literal with a `for` loop binder used in its body, and a block-argument
  lambda (`xs.map(\(y) -> y + 1)`) using its param — must NOT report the binder
  or `y`. (See next point — the existing check has explicit guards for both
  that this pass currently drops.)

And one "reports" case that pins the sibling-leak the flat model gets wrong:
two nested defs where the second references a local of the first — SHOULD
report.

## `isReferencePosition` alone is not the whole guard

Task 2 reuses `isReferencePosition` from `undefinedVariableDiagnostic.ts` —
good — but note the existing check does **not** rely on that function alone.
`checkVariableRef` (`undefinedVariableDiagnostic.ts:119-131`) adds two more
skips that the plan's `checkBody` omits: `for`-loop `itemVar`/`indexVar`, and
`blockArgument` params (`xs.map(\(x) -> x + 1)`), which the comment there notes
are **not tracked in the typechecker's Scope at all**. Drop those skips and a
template using a `map`/`filter` lambda gets a false `AG8015` on the lambda
parameter. Reuse that logic too, or factor the whole "is this a real,
resolvable reference position" decision into one shared helper and call it from
both passes. Do not reimplement half of it.

## Smaller points

- **Task 3 disables `AG4007` for the entire file when it has any hole.** The
  guard `if (holeNames(ctx.programNodes).length > 0) return;` means a template
  file gets **no** ordinary undefined-variable diagnostics anywhere, only the
  always-on template check. That is probably fine (the template check now covers
  the top level), but it is a real behavior change beyond "don't double-report
  the same name," and the plan frames it only as de-duplication. Say plainly in
  the commit/PR that a file with holes no longer emits `AG4007` at all, and
  confirm the template check's coverage is a superset for that file (it will be,
  once the scope model is fixed — another reason the scope fix is load-bearing).

- **Soft spot #2 lands on the wrong worry.** The self-review flags "walkScopeBody
  takes the host ctx… bindings might leak." The instinct (the scope is the risk)
  is right, but the actual defect is the flat-scope model above, not ctx state
  leakage. Once you adopt the `buildScopes` shape this note is moot.

- **`AG8015` is free** — confirmed the highest existing template code is
  `AG8014` (`diagnostics.ts:630`). Good. Don't forget the
  `diagnosticExplanations.ts` entry; the plan already notes it is compile-time
  mandatory.

- **Nested literals (soft spot #3):** correct that the parser refuses them, so a
  literal-in-literal cannot occur. Fine to leave, but keep the note.

## Verdict

Rework Task 1 and Task 2 around the per-body scope model (mirror `buildScopes`,
seed parameters, keep the host out and the prelude in) and add the
parameter/local/lambda "says nothing" tests that force it. Everything else —
Task 3's double-report fix, Task 4's fixture and guide work, the branch/verify
discipline — is sound and can proceed as written once the scope model is right.
The prelude handling, which the spec review flagged, is correctly carried
through; this review is about the scoping layer underneath it.
