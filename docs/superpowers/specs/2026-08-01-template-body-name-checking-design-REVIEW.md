# Review: Templates can only use names they declare themselves

Reviewing `2026-08-01-template-body-name-checking-design.md`.

The core decision is right and well argued. A hole is opaque, so code around a
hole cannot depend on what the hole supplies, and the direction of the argument
(this is the same collision hygiene already guards, pointed the other way) is
convincing. The "what other languages do" section earns its place. What follows
is mostly about the one part the spec itself flags as the risk: getting the
literal body's scope right in the strict direction.

## Blocking: the scope rule as written rejects the spec's own recommended example

The spec defines a literal body's scope as "its own declarations plus its own
imports. It is not the host file's scope." Taken literally, that scope contains
nothing else.

But the recommended self-contained fragment is:

```ts
static const llmCall = [|
  const res = llm(#prompt)
  print(res)
|]
```

`llm` and `print` are neither declared in the literal nor imported by it. They
are prelude names — `stdlib/index.agency` exports auto-imported into every
Agency file (see `lib/prelude.ts`, `PRELUDE_NAMES`). Under the rule as stated,
`llm` and `print` do not resolve, and the fragment the spec holds up as the fix
gets rejected.

So the scope rule needs a third component it does not currently name: the
prelude (and builtin variables / builtin functions — whatever
`resolveVariable` already consults that is not file-local). Concretely,
`checkUndefinedVariables` today resolves against `functionDefs`, `nodeDefs`,
`importedFunctions`, `importedNodeNames`, `jsImportedNames`, and the lexical
`scope` (`lib/typeChecker/undefinedVariableDiagnostic.ts:133`). For a literal
body the file-local halves of those (host `functionDefs`, host imports) must be
dropped, but the prelude/builtin halves must be kept. The spec reads as if the
whole base scope is dropped.

Please state the rule as: **a literal body's scope is the prelude and builtins,
plus the literal's own declarations, plus the literal's own imports — and
nothing the host file adds.** The current two-part phrasing is the strict-side
mistake the "Risk" section warns about, and it is in the spec text itself.

## Can a literal body even have "its own imports"?

The rule leans on "or imports" and the testing section has a case "a literal
body that imports what it uses. Silent." Imports are top-level in Agency, and a
code literal's body is inferred smallest-first as expr, then statements, then
program (`parseCodeLiteralBody`). Only the program form could carry an `import`.

Two things to pin down:

- Is `import { ... } from "..."` actually legal and parsed inside a
  program-kind literal body today? If not, the "imports what it uses" test case
  is untestable and the "or imports" half of the rule is dead text for
  literals (it still applies to template *files*, which do have imports). Worth
  confirming before writing the test, so the test isn't asserting a shape that
  cannot occur.
- If a literal body cannot import, then in practice the only names a literal
  can legitimately use are: prelude/builtins, plus what it declares itself.
  That is a simpler and more honest statement of the rule for the literal case,
  and it makes the prelude point above unavoidable rather than an aside.

## The always-on diagnostic and the silent code path

The spec wants the literal-body check to fire regardless of
`undefinedVariables`. Note that today the entire walk short-circuits at the top:
`if (mode === "silent") return;` (`undefinedVariableDiagnostic.ts:42`). So the
name-resolution machinery does not merely downgrade to no output when silent —
it never runs. "Reusing AG4007 would inherit the silent default" understates
this: you cannot reach the resolution logic at all in the default config.

This is fine for the design, but it means the literal-body check is a genuinely
separate pass (or an unconditional branch that runs before the silent guard),
not a severity tweak on the existing one. The spec should say so, because "walk
the body in its own scope" reads like it reuses the existing walker, and the
existing walker is gated off by default. One concrete question for the plan:
does the new pass share `resolveVariable` (good — same resolution semantics) but
own its own always-on entry point and its own diagnostic code? That is the
shape I'd expect; please make it explicit so the implementer doesn't try to
thread a flag through `checkUndefinedVariables`.

## The host-helper case is a real policy choice, not just "the same bug"

The `def helper()` in host / literal calls `helper()` example (lines 83–89) is
presented as "the same bug in a different costume." It is stricter than the
hole-opacity argument, and worth calling out as its own decision.

Hole opacity is unarguable: nobody can see into a hole, so depending on it is
always wrong. But "a literal cannot use a host-file declaration" is a choice
about composition. A plausible mental model is: literals are fragments I build
up *in this file* from *this file's* helpers, then assemble. That model is
exactly what the rule forbids. The spec's justification — the host declaration
won't exist in the generated program at `runCode` time — is sound for the
`toSource`/`runCode` path. I think the strict choice is defensible and I'd keep
it. But say plainly "a literal cannot reference host-file declarations, on
purpose" as a named rule, rather than folding it into the hole argument, because
this is the part most likely to generate friction and the part a future reader
will want the rationale for.

## Smaller points

- **Diagnostic number.** `AG####` is a placeholder. Allocate a real code and
  add its `agency explain` prose — `diagnosticExplanations.ts` is exhaustive by
  type, so a new code without prose is a compile error (per the template-agency
  internals doc). Worth a one-line note in the spec so it isn't discovered late.

- **When does the check run relative to fills?** State it: the check runs at the
  enclosing file's type-check time, when the literal still has its holes open,
  which is precisely why `res`-supplied-by-`#body` is catchable (the name is
  genuinely unresolved at that moment). This is the load-bearing timing fact and
  it is currently only implicit.

- **Sweep specifics.** Good that the spec names `literalCompose.agency` and says
  to sweep. From reading that fixture, note the breakage is not one line: the
  whole flagship compose fixture is built on `#helpers` supplying `guarded()`
  which `mainTpl` then calls, and `guardTpl` uses `#minutes` inside a
  declaration it owns (that part is fine). So "delete it" means losing the
  inline compose-then-parameterize execution coverage. The spec's "one execution
  fixture: build a self-contained fragment, fill it, run it" needs to also
  preserve the *composition* coverage that fixture currently carries, or that
  coverage silently drops. Call out that the replacement fixture must still
  exercise fill-then-compose-then-run, not just a single self-contained
  fragment.

- **Testing matrix vs. the imports question.** The case "a literal body that
  imports what it uses. Silent." depends on the open question above. If literals
  can't import, replace it with "a literal body that uses a prelude name (`llm`,
  `print`). Silent." — which is the case that actually protects the recommended
  pattern and is the one most likely to regress if the base scope is built
  wrong.

## Verdict

Ship the design after fixing the scope rule to include prelude/builtins — that
one is blocking because the spec's recommended fix fails its own rule as
written. The imports question and the always-on-pass mechanics should be
resolved in the plan, not left implicit. The host-helper strictness and the
fixture-coverage note are things to state explicitly rather than change.
