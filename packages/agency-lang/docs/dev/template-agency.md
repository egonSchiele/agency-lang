# Template Agency: implementation

How templates (holes, `fill`, hygiene) work under the hood. The user-facing story is in `docs/site/guide/templates.md`; the design history is in `docs/superpowers/specs/2026-07-22-code-templates-design.md`. This doc is for changing the implementation without re-learning it. Shipped in #665.

## The one rule, stated first

**Nothing supplied to `fill` is ever parsed as Agency source.** Plain values lift to literal AST nodes; `Code` values graft as trees; identifier fillers become names only after validation. If you ever find yourself parsing a filler value, stop — you are reintroducing the injection bug the feature exists to prevent. The single deliberate exception is `parseExpr` / `parseStatements`, whose entire job is parsing, and which a template author calls explicitly.

Everything below is machinery in service of that rule plus one workflow: **filling composes**. A partially filled template is an ordinary `Code` value; grafting it into another template carries its remaining holes along, and a later fill completes them. Several design decisions only make sense as protections of that workflow, and they are flagged where they appear.

## Where things live

| File | Owns |
| --- | --- |
| `lib/types/hole.ts` | The `Hole` node, `HoleSort`, `isHole`, `declaredName` |
| `lib/parsers/parsers.ts` | Hole parsing (all positions), `LEGAL_IDENTIFIER`, `RESERVED_WORDS` |
| `lib/utils/holes.ts` | `findHoles` / `holeNames` / `holeInfos` / `positionInferredTypes` |
| `lib/runtime/template/code.ts` | `Code`, `kindOf`, `isCode` |
| `lib/runtime/template/literals.ts` | Typed literal-node constructors (the only place lift shapes live) |
| `lib/runtime/template/lift.ts` | `liftValue` — plain value → literal node |
| `lib/runtime/template/fill.ts` | `fillHoles` — substitution, sort/kind/type checks, origin stamps |
| `lib/runtime/template/hygiene.ts` | Collision detection, scope-keyed renames, `__hyg` seeding |
| `lib/stdlib/template.ts` | The `_loadTemplate` / `_fill` / `_holesOf` / `_parseExpr` / `_parseStatements` / `_toSource` wrappers |
| `stdlib/agency.agency` | The Agency-level surface (`loadTemplate`, `fill`, `holesOf`, `toSource`, `parseExpr`, `parseStatements`, `Code`, `HoleInfo`) |

`Code` sits under `lib/runtime/` (not `lib/stdlib/`) to break an import cycle: `stdlib/template.ts` imports the fill machinery, which needs the type. Hole queries sit under `lib/utils/` because three layers need them — the builder (AG8001), the type checker (AG8002, definite returns), and the template runtime — and none of those may import across the others.

## The Hole node and its sorts

```ts
type Hole = {
  type: "hole";
  name: string;
  sort: "expr" | "statements" | "identifier" | "decl";
  splice: boolean;
  typeAnnotation?: VariableType;
  loc: SourceLocation;
};
```

The sort is **derived from position, never written by the user**, and position means parser wiring:

- **expr** — `holeParser` (wrapped as `exprHoleParser`, which rejects splices) is the first alternative in `baseAtom`, the operand alternation `exprParser` is built on. That one wiring point covers every expression position at once: binop operands, conditions, call and named arguments, array/object elements, interpolations.
- **statements** — `statementHoleParser` sits in `_bodyNodeParser` ahead of `binOpParser`; ordering IS the tie-break rule (a bare hole occupying a whole statement is a statements hole; inside a larger expression it stays expr). It only matches when the hole is followed by a statement boundary — and note the boundary set includes `BLANK_LINE_SENTINEL` (``), because `replaceBlankLines` runs before parsing, so a hole followed by a blank line is followed by the sentinel, not `\n`.
- **identifier** — `identifierHoleParser`, wired into three sites: def names, node names, and import specifiers. It rejects splices at parse time (a name position holds one name), and the def/node name capture (`declNameParser`) deliberately has **no raw-string fallback for `#`-initial input** — without that, a rejected form like `def #...name(` would be silently consumed as the literal name `"#...name"` by `many1Till("(")`.
- **decl** — `topLevelHoleParser` in `lib/parser.ts`'s top-level alternation only, never in block bodies. It reuses `statementHoleParser`'s boundary check and rewrites the sort.

Splices (`#...name`) are legal in statement position, decl position, and argument lists (argument lists get their own `spliceHoleParser` alternative *before* `exprParser`, because the expression path rejects splices). Quoted names (`#"any-chars"`) change only the name, nothing about filling.

## Identifier holes: `string | Hole` and `declaredName`

Declaration names and import specifiers hold **plain strings** in the AST (`FunctionDefinition.functionName`, `GraphNodeDefinition.nodeName`, `NamedImport.importedNames[i]`). Identifier holes therefore work by widening those three fields to `string | Hole`, and identifier fills produce validated plain strings — there is no `variableName` node involved.

The widening ripples: ~90 call sites read those fields as strings. They all go through `declaredName()` (`lib/types/hole.ts`), which is total — it returns the string, or `#name` for a hole. `#name` is safe as a registry or display key because `#` cannot appear in a user identifier, and codegen (the only consumer that would emit it) is unreachable for templates: AG8001 refuses first.

Identifier fillers are validated against three things (`identifierFillFor` in `fill.ts`): the identifier grammar (`LEGAL_IDENTIFIER`, defined next to `varNameChar` — one regex, imported by the generator and the filler, never restated), the keyword list (`RESERVED_WORDS`, also in `parsers.ts`; no such list existed before this feature), and the `__hyg` prefix (see hygiene — identifier fillers are the one place the prefix is still *rejected*, because plain strings are invisible to the seed scan and are caller-supplied by definition).

## `Code` and fragment kinds

```ts
type Code = { type: "agencyProgram"; kind?: "program" | "statements" | "expr"; nodes: AgencyNode[]; docComment?: AgencyMultiLineComment };
```

`Code` is the pre-existing `AST` shape plus a fragment kind, because a bare expression is not a parseable program — `AST` alone cannot represent "one expression", and an expr hole must be fillable with `Code`. A missing `kind` means `"program"` (that is what `parseAST`, the escape hatch, produces). `kindOf` normalizes; `isCode` checks the `type` tag **and** `Array.isArray(nodes)` — the array check is load-bearing, since `Code` is a plain record an Agency caller can hand-build, and without it `{ type: "agencyProgram" }` would crash in `nodes.map` instead of lifting as data.

Kind-versus-sort admissibility (`assertKindMatchesSort`): expr ← expr; statements ← statements or program; decl ← program; identifier ← never (strings only).

`_parseExpr` and `_parseStatements` reuse the real grammar (`exprParser`, `bodyParser`) — never a second grammar — and reject trailing input, which is what makes `parseExpr("const x = 1")` fail instead of silently parsing a prefix.

## Hole queries and the walker dependency

`findHoles` / `holeNames` / `holeInfos` (`lib/utils/holes.ts`) are filters over `walkNodesArray`, and so are hygiene's `bindersOf` / `freeNamesOf`. That makes **`walkNodes`' descent completeness load-bearing for safety**: a node kind whose expression children the walker misses under-reports free names, no test fails, and a filler silently captures a template binder — the exact bug hygiene exists to prevent, failing open.

This is not hypothetical. Three real gaps were found during the feature's development, each by a test rather than by reading:

1. `guardBlock` head arguments (`guard(time: #minutes)`) — caught by the compose execution fixture.
2. `tryExpression.call` — caught by the hole-position battery on its first run.
3. `isExpression.expression` (`tmp is string`) — caught in review; the fix mirrors the `typeTestExpression` case that already existed. (`expressionChildren`'s deliberate emptiness for is/typeTest is a *flow-view* decision and was not touched.)

The tripwire is the **hole-position battery** in `lib/parsers/hole.test.ts`: one source snippet per expression position, asserting the walker reaches a hole there. If you add a node kind with expression children, add its position to the battery. A structural version derived from `expressionSlots` (the completeness-checked table) is a recorded follow-up. `typeTestExpression` needs no battery entry: it is a lowering artifact, and templates parse with `lower: false`.

`holeInfos` reports one entry per distinct name — `{ name, sort, splice, type }` — with `type` from the hole's annotation or, failing that, `positionInferredTypes` (currently the annotated-assignment position only; **first occurrence wins**, so a second position of a different type is validated only at run time).

## `fill`

`fillHoles` runs, in order: arity check (every supplied name must be a hole), hygiene (below), then substitution over a deep clone. Substitution has two modes and the distinction is what makes splices and multi-statement grafts work: `substituteInArray` (statement bodies, argument lists, import-specifier lists) **spreads** a multi-node replacement into the sequence; `substituteAny` (single-value positions) requires exactly one node. Expr holes additionally enforce arity one even in array positions.

### Lifting

`liftValue` maps plain values to literal nodes via the typed constructors in `literals.ts` — the only place those node shapes live (they were verified against `pnpm run ast` output; arrays use `items`, not `values`). Three rejections, each closing a real hole:

- **`__proto__` keys**: in a JS object literal that key sets the prototype *even when quoted*, so a lifted record's shape would silently differ from the data.
- **Non-finite numbers**: `Infinity` / `NaN` have no Agency literal — `String(value)` would print a bare identifier token that re-parses as a *name reference*. Reachable from ordinary model output: `JSON.parse("1e400")` is `Infinity`.
- **Unsupported types** (functions, symbols): plain error.

### Escaping — where and why

The injection guarantee is only as strong as the printer's escaping, because generated programs are printed and re-parsed in the subprocess. Two distinct surfaces:

- **String values**: segments store raw text; the *generator* escapes at print time (`escapeStringText`, mirrored against the segment parser — handles the delimiter, backslashes, control characters, and `$` exactly when followed by `{`). The escaping battery (`escaping.test.ts`) pins this by exact value equality through print → re-parse, including interpolation openers.
- **Object keys are the opposite convention**: the AST stores keys in **source form, escapes intact** (verified: `{ "a\"b": 1 }` stores the key `a\"b`), and the printer wraps them verbatim. So key escaping happens in the `objectLiteral` **constructor** — the first place raw runtime strings become keys. Escaping in `addQuotesToKey` instead would double-escape every parser-sourced key. The battery has a key-side mirror of every value case plus the original smuggled-call repro, asserted against the re-parsed AST.

If you add a new string-bearing surface to lifting, decide which convention it follows and add battery cases for it.

### Fill-time type validation

Deliberately **validation, not a guarantee**: it rejects only when both sides are certainly known — plain JS primitives, or literal expression fragments (an *interpolated* string literal reports unknowable, in both directions). Expected types come from the hole's annotation or `positionInferredTypes`. Checking arbitrary fragments against the completed program's module scope needs a checker entry point that does not exist yet; the seam is marked in `fill.ts` and is the recorded follow-up that would let this narrow.

### Origin stamping

Every node of a grafted fragment gets `loc.origin = { kind: "filler", name }` — recursively, because inner nodes carry positions into a fragment source string that no longer exists. Only objects that already have a `loc` are stamped (loc-less sub-records like text segments keep their exact shape, which formatter invariants depend on); a loc-less *top* node falls back to the hole's own position.

Two readers consume the stamp. Fill-path errors append ``(in code grafted by the fill for `#helpers`)`` when the offending hole carries a filler origin (`originSuffix` in fill.ts), and `holesOf` reports it as `HoleInfo.origin` so a model composing templates sees which sub-template each remaining hole came from. Two boundaries are deliberate: re-grafting **overwrites** the stamp, so in a nested composition origin means "the fill this node *most recently* arrived through" — the outermost graft, which is the one the current caller performed; and attribution is **best-effort** — a loc-less inner node carries no stamp and yields `origin: null` with no error suffix. Compile-side and run-time attribution stay impossible until an AST-in compile entry point exists: `toSource` prints and `runCode` re-parses, and `loc` does not survive that boundary (the fragment-checker follow-up).

## Hygiene

The bug: substitution matches names by spelling, and spelling is a coincidence. A filler mentioning `tmp` must not capture a template's `const tmp = getApiKey()`.

Renaming is used (not scope metadata) because `Code` values get printed and re-parsed at the subprocess boundary — metadata on nodes dies at print, silently, exactly where capture is most dangerous. Renamed names use the ASCII prefix `__hyg<n>_<original>` so they survive re-lexing.

**Three collision sets**, each computed against the binders **visible at the hole** (its scope chain), never `bindersOf(template)`:

1. Visible template binder ∩ filler **free names** → rename the *template's* binder, inside its own scope only. (Free names, not binders — `tmp` used as an expression binds nothing; comparing binders to binders was a first-draft bug that detected no captures at all.)
2. Filler binder ∩ visible template binder (a redeclaration) → rename the *filler's* binder; the template keeps its spelling.
3. The same name bound by two fillers grafted into the same scope → each gets its own fresh name.

**Renames are scope-keyed** (`fn:name` / `node:name` / `global`), because a flat name→name map cannot express "rename `tmp` in `def b` but not in `def a`". `applyScopedRenames` threads the active-rename list through the recursion — a deactivation must hold for a whole subtree — and an inner def that *rebinds* the name stops an outer rename at its door (the shadowing filter; its test needs a renamed **global** plus a nested rebinding def, since sibling defs never activate each other's renames). Filler-side renames stay flat maps: a filler is one fragment grafted into one place.

Rename application is a bespoke rewriting walk, and that is documented rather than accidental: binder fields (`assignment.variableName`, parameter names, for-loop binders) are neither expression slots nor body slots, and `walkNodesArray` is read-only.

**`__hyg` seeding, not rejection.** The first design rejected any input containing the prefix ("impossible by construction"). That is fundamentally incompatible with composition: a rejected `__hyg1_tmp` may be the *previous fill's own output*, and rejection cannot tell renamer-produced names from caller-supplied ones — so a second fill failed exactly when the first had done its job. Instead, `maxHygieneIndex` scans the template and every filler for `__hyg<n>` across *all* name classes — binders, uses, and declaration names (function/node/type-alias names matter: `def __hyg1_x()` would otherwise collide with the very first fresh rename) — and the fresh counter starts above the max. Collisions stay impossible; nothing is rejected. Per-site `bindersOf`/`freeNamesOf` results are hoisted onto `GraftSite` at construction, so the collision loops are intersections over precomputed arrays rather than O(n²) sibling re-walks.

**Pattern binders** (object, array, rest, for-loop, comprehension) are tracked: `bindersOfNode` reads the `pattern` field a destructuring assignment carries next to its `"__destructured"` sentinel `variableName`, and the same `patternBinders` helper serves for-loop and comprehension binders (identical `itemVar` shape). The rename nuance is shorthand: in `{ tmp }` the one token is both the property being read and the binder, so a renamed shorthand expands to `{ tmp: __hygN_tmp }` (the generator collapses back to shorthand only when key and name match, so the expansion prints as written). Rest identifiers rename via `isNameField` (`restPattern.identifier` is a plain string field); every other pattern-held binder is a `variableName` node the generic walkers already rewrite.

**Known limits:** result-pattern bindings (`is success(v)` binds `v`) and match-arm pattern binders are not tracked for collision *detection* — both are branch-scoped bindings, which need flow-aware rename planning; the guide documents them. Renames stay *consistent* through them, though: `resultPattern.binding` is a name field (`isNameField`), so a scope-wide rename moves the arm binding together with the arm's uses instead of silently retargeting the arm at the renamed outer variable, and match-arm shorthand patterns go through the same `expandShorthand` as binding-position ones.

**Proto-safety:** hole names, filler keys, and scope keys are user-controlled strings (`__proto__` is a legal hole name), so every dictionary keyed by them is null-prototype and every membership test is `Object.hasOwn` — the house pattern from `lib/optimize/registry.ts`.

## Refusals and pipeline tolerance

A template flows through the normal pipeline, so every stage before codegen must tolerate holes and exactly one stage refuses:

- **AG8001** is a pre-pass at the top of `TypeScriptBuilder.build()`: collect *all* holes (the message names every one, not the first) and throw `AG8001: ...`. The throw propagates as a `CompileFailure` through `compileSource`'s catch and as a nonzero exit through the CLI, which is what the `expectedCompileError` fixtures match. `processNode`'s own `case "hole"` is an *internal* error — reaching it means the pre-pass broke.
- **AG8002** (`checkTemplateHoles`, wired into `typeCheck`) fires for an expr hole with neither an inline annotation nor a position-supplied type — v1 recognizes the untyped-assignment position only. The synthesizer types a hole as its annotation, else `any`.
- **Definite returns** (`definiteReturns.ts`) skip any function whose body contains a *statements* hole — the only return may be inside it; the completed program is checked in full at run time. Note the check ships at `"warn"`, so tests must set `typechecker.definiteReturns: "error"` to observe it.
- **"Bindings are local to the hole" is a checking rule, not runtime isolation.** The checker cannot see into a hole, so template code referencing a filler-introduced name fails ordinary name resolution at template-check time. At runtime a grafted `const` genuinely shares the enclosing scope; real isolation would require renaming every filler binder unconditionally, which would make generated code unreadable.
- **Tolerance details**: `hole` is registered in `expressionSlots.ts` `NO_EXPRESSION_SLOTS` (the #659 tripwire rejects unregistered expression kinds by name — it fired during development, as designed); `importResolver` and `SymbolTable.resolveImport` skip hole specifiers (`typeof name !== "string"`); the unused-imports lint rule never reports a hole specifier; the AG8001/AG8002 messages have `agency explain` entries (`diagnosticExplanations.ts` is exhaustive by type — a new code without prose is a compile error).

## Serialization

Needed **no code**. `Code` is plain JSON data, and interrupt checkpoints carry it as-is — the verify-first fixture (`codeAcrossCheckpoint`) proved the predicted failure never existed and stays as the regression guard. The formatter round trip is what makes printed source a *canonical* interchange form: holes print (`formatHole` in `agencyGenerator.ts`, quoting non-identifier names) and re-parse to the same tree, pinned by two-round-trip stability tests. Corollary: never store checker state on a `Hole` node expecting it to survive — `formatHole` prints sigil, name, and annotation only, so anything else (e.g. an inferred expected type) dies at print. Expected types are recomputed from the tree instead.

## Test map

| Suite | Pins |
| --- | --- |
| `lib/parsers/hole.test.ts` | Parsing per position, splice legality, quoted names, sort tie-breaks, **the hole-position battery** |
| `lib/backends/agencyGenerator.hole.test.ts` | Round trips (two-pass stability), filled-program identity |
| `lib/backends/holeRefusal.test.ts` | AG8001 via `compileSource` (assert the `code` field, not thrown text — codes and messages are separate fields joined only by `formatErrors`), per-stage tolerance |
| `lib/runtime/template/fill.test.ts` | Lifting (value-vs-string assertions), kinds, splices, identifier validation, compose-then-parameterize, structural guards, type validation |
| `lib/runtime/template/escaping.test.ts` | Print→re-parse inertness for string values AND object keys |
| `lib/runtime/template/hygiene.test.ts` | All three collision sets, scope ownership, the shadowing filter, `__hyg` seeding, fill-twice composition |
| `lib/typeChecker/holes.test.ts` | AG8002, name-resolution-after-hole, definite-return exemption (with a sanity anchor so the exemption test cannot pass vacuously) |
| `tests/agency/templates/` | Six execution fixtures: AG8001 + AG8002 (`expectedCompileError`), checkpoint survival, end-to-end injection, parent-handler governance over a generated subprocess, compose-then-parameterize |

## Easy-to-miss nuances, collected

- Import syntax is `import { x } from "std::fs"` — there is no `import std::fs { x }` form.
- `guard`'s named argument is `time:`, and a `return` inside a `guard { }` yields the **guard's** value; it does not escape to the enclosing node.
- Blank lines reach parsers as ``, not `\n\n` — any "end of statement" check must include the sentinel.
- `Json` used in a stdlib signature needs `import { Json } from "std::validation"` in the `.agency` file.
- The doc generator renders `type: string | null` as `type?: string` — same type by construction (the optional-property parser desugars `?:` to a null union), not a docs bug.
- `dist/` and `stdlib/docs/` are build outputs; `make doc` (not plain `make`) regenerates `docs/site/stdlib/*.md`.
