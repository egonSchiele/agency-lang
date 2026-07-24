# Review v2: 2026-07-23-code-templates.md

Re-review of `/Users/adityabhargava/agency-lang/worktree-code-templates/docs/superpowers/plans/2026-07-23-code-templates.md` after the rewrite. First review: `2026-07-23-code-templates-REVIEW.md` (sibling file).

**Overall: this is a much stronger plan.** All four previous blockers are genuinely fixed, not papered over: fragment kinds on `Code` (Decision 1) solve the expression-fragment problem the right way; hygiene now compares template binders to filler *free names* and gives each filler its own rename map; "bindings are local to the hole" is honestly restated as a checking rule (Decision 3); and Tasks 7/15 moved to vitest instead of the `.test.json` format that can't express compile errors. The weak `toContain("42")` assertions, the missing splice-fill coverage, the escaping battery, reserved words, the handler-governance test, per-stage pipeline tests, and the anti-pattern items (walkNodesArray, single `LEGAL_IDENTIFIER`, literal constructors, `computeRenames` as a named function) are all addressed. I also re-verified the new draft's factual claims: `walkNodesArray` does yield `scopes` (`lib/utils/node.ts:401-404`), `compileSource` exists and returns a result rather than throwing (`lib/compiler/compile.ts:96` — the plan's hedge covers this), `definiteReturns` ships at warn (`lib/typeChecker/definiteReturns.ts:37`), an `undefinedVariable` error exists (`lib/typeChecker/diagnostics.ts:470-473`, supporting Task 15's fourth test), and the generator already escapes `\\` and `${` (more on that below).

Three real problems remain, all fixable without restructuring.

---

## 1. Hygiene again: the `computeRenames` interface cannot express what its own test demands

Task 14's sixth test — "does not rename an unrelated same-named binder in another function" — requires scope-aware renaming, and the prose says to use `walkNodesArray`'s `scopes` for it. But the sketched machinery is scope-blind in both directions:

- `captured` is computed as `bindersOf(template)` (the whole template) intersected with filler free names. `bindersOf` has no scope dimension, so `tmp` bound in `def a` and `tmp` bound in `def b` are the same string.
- The return shape is a flat `Record<string, string>` per side, and `applyRenames(code, renames)` takes only a name→name map. A flat map applied to the whole template *cannot* rename `tmp` in `def b` while leaving `tmp` in `def a` alone — the information isn't in the map.

So with the sketch as written, filling the hole in `def b` renames both functions' `tmp` (binder plus use in each), the output has 4+ `__hyg` occurrences, and the test's `toBeLessThan(3)` fails. Same shape of defect as the previous draft: the sketch cannot pass the test next to it.

The fix is to make scope part of the contract. Capture only matters in the scope chain *enclosing the hole*: the collision set for case 1 is "binders visible at the hole's position" ∩ "the filler's free names", computed per hole, and the rename must be applied within that binder's scope, not globally. Concretely: `computeRenames` should walk with `walkNodesArray`, and its output should identify *which* binder (scope + name, or the binding node itself), with `applyRenames` driven by the same scope walk. Specify the shapes; don't leave the executor to discover mid-task that the flat map can't work.

Also note the test itself is one-sided: `toBeLessThan(3)` also passes when hygiene does nothing at all (0 renames). It's rescued by the first test only if both run against the same mechanism. Add to this test: `def a`'s block still contains `const tmp = 1` verbatim, *and* `def b`'s binder is renamed — assert both directions in the one fixture.

## 2. A collision case fell through the rewrite: filler binder vs template binder

The previous draft compared binders to binders — wrong for capture detection, and the rewrite correctly replaced it. But binder∩binder was catching something real that the new sets miss: a filler that *declares* a name the template also declares in the surrounding scope. Fill `#setup` in the API-key template with `_parseStatements("const tmp = 99")`: `tmp` is a filler **binder**, not a free name, so case 1 doesn't fire; only one filler binds it, so case 2 doesn't fire. The completed program declares `const tmp` twice in one scope — a duplicate-declaration error (or silent shadowing) at run time, pointing at generated code far from the cause.

Add collision set 3: filler binders ∩ template binders visible at the hole's position → rename the filler's binder (the filler owns the noise, the template keeps its spelling). And add the test, because nothing currently exercises it.

## 3. Task 18 Step 2's template doesn't parse under the plan's own grammar

The handler-governance template puts `#tool` in **call-callee position**: `return #tool("/etc/passwd")`. Task 5 wires identifier holes into exactly three sites — def names, node names, import specifiers. A callee is none of them; `#tool` there is at best an `expr`-sort hole (making the fill lift `"readFile"` to a *string literal* and produce `return "readFile"("/etc/passwd")`), and at worst a parse error, depending on how the call grammar consumes its callee. Either way the fixture doesn't do what the test needs.

Two clean fixes; pick one in the plan:

- **Wire callee position as a fourth identifier-hole site** in Task 5. Defensible — a callee is a name — but it grows the grammar work and needs its own sort tests and round-trip tests.
- **Restructure the fixture to use what already works.** The driver can build the call itself, since Task 8 exposes `parseExpr` to Agency: fill the import's `#tool` with the identifier `"readFile"`, and fill a body `expr` hole with `parseExpr("readFile(\"/etc/passwd\")")`. That's the documented author-chooses-to-parse path, it exercises identifier fill, Code grafting, *and* handler governance in one fixture, and it needs no new grammar. I'd take this one.

---

## Smaller items

- **Task 11 Step 2's predicted failures probably won't happen.** The generator's escaping already handles `\\`, `\n`, `\t`, `\r`, `\0`, and escapes `$` precisely when followed by `{` (verified around `lib/backends/agencyGenerator.ts:95-120` — the comment even explains the bare-`$` case). The battery is still worth every line as regression coverage, but Step 2 says "Expect failures on at least the interpolation and backslash cases," which will send an executor hunting for a bug that isn't there. Reword to "these may already pass; if so, commit the battery as regression tests and move on."
- **`kind`-less `Code` values are unspecified.** The `parseAST` escape hatch (Decision 1's consequence) produces the old `AST` shape with no `kind` field, and `assertKindMatchesSort` doesn't say what happens then. Decide: treat missing `kind` as `"program"` (matching what `parseAST` semantically returns) and add one test, or reject with a message pointing at `parseExpr`/`parseStatements`. One line either way; without it the two-call injection path the guide is supposed to document has undefined behavior.
- **`_loadTemplateFromString` is used but never built.** Task 10's `fillAndPrint` helper calls it; no task produces it. It's three lines (`_parseAST` + `kind: "program"`), but name it in Task 10's file list or the first test run fails on an import error.
- **Splices in argument lists need a where-to-wire sentence.** Task 6 Step 4 rejects splice in the expression alternation and says to leave "the argument-list wiring permissive" — but argument lists usually parse arguments *via* the expression parser, so the rejection wrapper would swallow `f(#...args)` too. The test will catch it (good), but say explicitly that argument parsing needs its own splice-permitting hole alternative ordered before the general expression parse, so the executor doesn't treat the failing test as a mystery.
- **Trivial:** the plan cites `walkNodesArray` at `lib/utils/node.ts:510`; the export is at `:570`. Harmless, but since the previous draft's line refs were a selling point, keep them exact.

## Verdict

The four previous blockers are fixed and the plan's verification discipline is visibly better — the new draft's claims checked out everywhere I tested them. What remains is one design-level gap (scope-aware hygiene, item 1, plus its dropped sibling case, item 2), one broken fixture (item 3), and wording-level items. Fix items 1–3 and I'd call this executable.
