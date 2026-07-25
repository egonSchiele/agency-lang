# Review: Code Literals implementation plan (`2026-07-24-code-literals.md`)

Reviewing `/Users/adityabhargava/agency-lang/docs/superpowers/plans/2026-07-24-code-literals.md` against `origin/main`.

Feedback lives here in a sibling `-REVIEW` file, not on the plan itself.

## Verdict

This is a well-built, execution-ready plan. The task ordering is genuinely thought through, the risky parts are named as risky, and — importantly — it reuses existing machinery (the canonical generator, `parseAgency`, `Code`-as-source serialization, the #668 walker-coverage tripwire) instead of reinventing any of it. I verified the load-bearing code references against `origin/main` and they hold. I'd let an executor start on it after four fixes, only one of which is likely to bite the happy path.

**First, a correction I owe you:** my earlier *spec* review flagged `WALKER_EXCLUDED_FIELDS` as a non-existent mechanism and called it "blocking." That was my error — I grepped a **stale local `main` tree**. The mechanism is in `origin/main` (`lib/utils/expressionSlots.test.ts`, from #668), and **this plan uses it correctly**. I've annotated the spec-review file with the retraction. Net effect on this plan: Task 4 is right, not blocked.

## What I re-verified against origin/main (all correct)

- `parseAgency(input, config, applyTemplate=true, lower=true)` — 4-arg (`lib/parser.ts:262`). The plan's `parseAgency(src, {}, false, false)` = no prelude template, no lowering, exactly the format/template mode. Correct everywhere the plan uses it.
- `exprParser` (`parsers.ts:3088`), `bodyParser` (`parsers.ts:4379`), `baseAtom` (`parsers.ts:2937`) — all real, names and line correct.
- The `[`-led ordering discipline the plan cites in `baseAtom` is real (`parsers.ts:2683-2694`), and inserting the literal first among `[`-led parsers is the right call.
- `Code` type (`stdlib/agency.agency:522`): `{ type: "agencyProgram"; kind?: "program"|"statements"|"expr"; nodes: any[]; docComment?: any }`. Matches `CodeLiteral`'s `nodes`/`kind`.
- `WALKER_EXCLUDED_FIELDS` (keyed `ownerType.field`, shields the whole subtree), `WALKER_EXCLUDED_TYPES` (wrapper-only, subtree stays covered), and the `structuralNodes` reachability invariant that runs in **both** lowered and unlowered modes — all present. The plan's choice of `WALKER_EXCLUDED_FIELDS["codeLiteral.nodes"]` (not `WALKER_EXCLUDED_TYPES`) is correct: we *do* yield the `codeLiteral` node (it's an expression value walked through the assignment) and we *don't* want its body walked, which is precisely "shield the subtree."
- `walkNodesArray` exported (`node.ts:549`); runtime→parsers import has precedent (`fill.ts:3` imports from `parsers/parsers.js`), so Task 6's runtime constructor importing `parseAgency` is fine.
- `synthesizer.ts` and `holes.test.ts` exist; `agencyGenerator` has `increaseIndent`/`indentStr`/`processTypeAlias`. Task 5/7 file references are real.

The "No `walkNodes` changes — an unregistered node is a leaf for free" global constraint is correct: I read `walkNodes` (`node.ts:339`), the expression descent is a per-type `else if` chain with no catch-all, and the only generic descent is the `bodySlots`-driven body walk at the tail — which returns `[]` for an unregistered node. So leaf-ness genuinely falls out of not registering `codeLiteral` in the switch *and* not adding `.nodes` to `bodySlots`. Both levers named. Good.

## Fix before executing

### 1. (Most likely to bite) Task 7's synthesized type may not be assignable to `Code`

The plan synthesizes the literal's type as `{ type: string, kind?: string, nodes: any[], docComment?: any }` and relies on structural compatibility to carry it into `fill(template: Code, ...)`. But `Code`'s `type` field is the **string-literal** `"agencyProgram"`, and `kind` is the **union** `"program"|"statements"|"expr"`. A value typed `{ type: string }` is *wider* than `{ type: "agencyProgram" }` — in a structural checker that respects string-literal types (Agency has them; `Code` itself uses one), `string` is not assignable to `"agencyProgram"`, so the `fill()` call could fail to typecheck. This is the plan's happy-path proof (its own "the test that matters"), so if it breaks, it breaks visibly — but the plan predicts success.

**Fix:** synthesize the exact literal and union — `type: "agencyProgram"`, `kind?: "program" | "statements" | "expr"` — not `string`. The plan already parses the type via the type-hint parser at module init, so this is a one-string change to the literal it parses. Add a sentence to Task 7 saying the synthesized `type`/`kind` must match `Code`'s literal/union fields exactly, precisely because structural assignability into a literal-typed field is directional.

### 2. (Fiddliest area) Task 3 Step 3's location mapping ignores the `trim()` offset

`parseCodeLiteralBody` does `const trimmed = body.trim()` and parses `trimmed`, but the post-hoc loc shift adds only "the literal's start position." It does not account for the leading whitespace `trim()` stripped. In the normal case the body starts with `\n` + indentation (every multi-line example in the spec does), so every mapped node lands too early by the trimmed-prefix length. The dedicated location-mapping test *happens* to use a body with leading whitespace (good), so it may catch this — but only if the expected line is pinned tightly, and the plan says "pin whatever line the message carries," which risks pinning the wrong line as correct.

**Fix:** either (a) don't `trim()` — let `exprParser`/`bodyParser` skip leading whitespace themselves and keep offsets honest, or (b) fold the stripped-prefix length into the additive shift. State the choice in Task 3 Step 3, and make the location test assert the *exact* expected line computed by hand, not "whatever it carries."

### 3. Task 6 Step 1's shown code contradicts its own subtlety note

Step 1 shows `__codeLiteral` calling `parseAgency(..., false, false)` (program grammar) for all kinds, then the note immediately says that grammar rejects a lone expression, so reconstruct with the same per-kind entry points (`exprParser` for `expr`, `bodyParser` for `statements`, program parse for `program`). An executor who implements the shown block first will get a confusing runtime failure on the very first `expr` literal (`[| print(1) |]` — the Task 6 Step 4 smoke test).

**Fix:** replace the Step 1 code block with the per-kind dispatch that actually ships (share the exact entry points `parseCodeLiteralBody` used, as the note already argues), so compile-time and runtime literally run the same reconstruction path. This also strengthens the "indistinguishable from file-loaded" claim.

### 4. Task 3 Step 3's "program-grammar entry point inside parsers.ts" is a cycle trap — default to injection

The plan's option (a) is "call the program-grammar entry point already inside `parsers.ts`, skipping the lowering/offset wrapper." But the thing `parseAgency` wraps is `_parseAgency`, which lives in **`parser.ts`**, not `parsers.ts` — importing it back into `parsers.ts` is the cycle the plan is trying to avoid. The actual in-`parsers.ts` top-level production exists (it's what `_parseAgency` ultimately calls), but finding the right export mid-implementation is a rabbit hole.

**Fix:** flip the preference order — default to option (b), the setter/injection that `parser.ts` registers at module init. It's the safe path, it's a known pattern, and it sidesteps the cycle entirely. Keep (a) only as an optimization if the executor happens to spot a clean exported production.

## Smaller notes (not blockers)

- **Commit footer.** Task 1 Step 3's template says `Co-Authored-By: Claude Fable 5`. The repo convention (and this session's) is `Co-Authored-By: Claude Opus 4.8 (1M context)`. Whichever model executes, match the repo's stated footer, not a hardcoded one.
- **Local main is stale.** Worth one line in the plan noting that `WALKER_EXCLUDED_FIELDS` and the reachability tripwire are in `origin/main` (the plan correctly branches from it after `git fetch`), because anyone eyeballing the *local* `main` checkout will not find them and may think the plan is wrong. It isn't — it's the local tree that's behind.
- **Task 2 graft hypothesis — verify once, don't just assert.** "In the AST an expression statement *is* the expression node in the body array, so only the admissibility check changes" is very likely true (the `statements` sort already admits `program` and grafts nodes directly, and body arrays already hold bare expression nodes as statements). But it's stated as fact. Add a half-line to Step 3: confirm the graft path (`nodesFor`/whatever splices) doesn't wrap the expr in a statement node that doesn't exist — one console check on the grafted tree, then move on.
- **Task 8 equivalence test.** Step 4 compares `toSource(literal)` to `generateAgency(file-template)`. Confirm `toSource` actually routes through `generateAgency` (or the same canonical printer) — if it takes a different path the equivalence is testing two printers, not the "indistinguishable" property. Likely fine; just verify the routing once.
- **`WALKER_EXCLUDED_FIELDS` entry added before any corpus literal exists (Task 4 before Task 8).** I confirmed there's no staleness guard forcing `WALKER_EXCLUDED_FIELDS` entries to be "live" (that guard only applies to `KNOWN_WALKER_GAPS`), so adding `"codeLiteral.nodes"` in Task 4 before the Task 8 fixture activates it is harmless. The plan's sequencing note is correct.

## What the plan gets right and shouldn't second-guess

- Ordering: gate first (it can change the owner-level fmt decision), relaxation as a standalone commit, parser before leaf-ness, formatter before codegen (shared body-print helper), fixtures last to make the tripwire live. This is the correct dependency order and the self-review's rationale is honest.
- The formatter gate as a *gate* (Task 1) rather than an afterthought — this was the riskiest v1 promise in the spec, and front-loading a whole-corpus unlowered round-trip is exactly the right de-risking. The "if a node kind can't round-trip, STOP and surface to the owner" escalation is the right instinct.
- The end-scan's interpolation corner (`"${ f("has |] here") }"`) is called out and tested — that's the subtle bug this whole design could have shipped, and the plan has a named test for it.
- The "known unknowns, called out in place" section is the mark of a plan written by someone who read the code: each unknown is a look-and-mirror, not a design hole.

## Anti-pattern audit (against `docs/dev/anti-patterns.md`)

**Direct answer to "does it write declarative interfaces that encapsulate imperative complexity?": mostly yes, with one important exception.** The *boundaries* are good — the end-scan returns a clean `{ ok: true, body, consumed } | { ok: false, error }` union and its caller is fully declarative; kind inference returns a discriminated union; codegen and the runtime constructor reuse `parseAgency`; the typechecker reuses the type-hint parser instead of hand-building a node tree. Complexity is walled off behind result types, and the "what" is separated from the "how." So the encapsulation *shape* is right. The exception is *what's inside one of those boxes*.

### Significant: the end-scan duplicates the lexer (Task 3, Step 2)

`scanCodeLiteralBody` and especially `skipStringForScan` hand-roll a raw character lexer — string delimiters, backslash escapes, `//` and `/* */` comments, and a manual `${...}` brace-depth counter with recursive nested-string skipping. **Every one of those already exists as a parser combinator** and handles the same cases (including the nasty ones): `commentParser` (`parsers.ts:294`), `multiLineCommentParser` (`:311`), and the interpolation-aware string parsers `_stringParser` (`:794`) / `simpleStringParser` (`:690`) / `interpolationSegmentParser` (`:505`), which already consume a string with its escapes and `${...}` interpolations — nested strings and all.

This is the **"Duplicating existing code"** anti-pattern, and it is not cosmetic:

- It stands up a **second lexer that must stay in sync with the real one**. The moment the real string grammar changes (a new escape, a template-literal tweak, an interpolation rule), this scanner silently drifts and a body that the real parser reads one way gets *scanned* another way — the exact class of bug the whole zero-escaping design was meant to eliminate. `skipStringForScan`'s hand-rolled brace counter is precisely where this breaks (escaped braces, `}` inside a nested string inside an interpolation, multi-line strings).
- The **spec explicitly asked for the reuse approach** and the plan quietly substituted raw scanning. Spec: *"the end-scan is string- and comment-aware... using the lexing rules the parser already has"* and *"it falls out of scanning with the lexer instead of scanning raw."* The plan scans raw.

**Fix:** drive the scan off the existing parsers. At each code position: try `commentParser` / `multiLineCommentParser` (consume and skip), try the string parser (consume and skip — it already advances past interpolations correctly), check for `|]` (done) or `[|` (nested-error), else advance one character. That deletes `skipStringForScan` entirely and makes "the scanner and the parser agree" true by construction rather than by hand-maintenance. This is the single most valuable change to the plan — it removes both the anti-pattern and the top correctness risk in one move.

### Real, smaller hits (all inside that same Task 3 Step 2 block)

- **One-line `if` statements** (anti-pattern §"One-line if statements"): `if (input[i] === "{") depth++;`, `if (input[i] === "}") depth--;`, and the braceless `while (i < input.length && input[i] !== "\n") i++;`. The doc requires block bodies. (These mostly disappear if the scanner is rebuilt on the existing parsers, which is another reason to do that.)
- **Magic numbers** (§"Magic numbers"): the bare `2`s — `input.slice(2)`, `2 + scanned.consumed`, `i += 2` — encode "length of `[|`" and "length of `${`" / "escape pair." Name them (`CODE_LITERAL_OPEN`, its `.length`, etc.).
- **Order-dependent mutable state does NOT apply here.** The scanner's `let i` / `let depth` mutation is exactly what the doc exempts ("this rule does not apply to parsers"). Not a violation — flagging so no one "fixes" it into something worse.

### Minor: location remap reimplements a walker (Task 3, Step 3)

"Walk every object with a `loc` (the `walkEveryNode` pattern) and add the literal's start" reimplements a generic recursive walk. `walkEveryNode` is a test-only helper. Check whether `walkNodesArray` (`node.ts:549`, and already imported elsewhere in the plan) covers the loc-bearing nodes you need before hand-rolling another recursive walker — mild "Duplicating existing code."

### Clean on the rest

No nested ternaries, no empty catch (Task 6's catch throws a descriptive error), no dynamic imports, no spread-conditional "ugly code," flat type definitions, no `unlinkSync`-style deletes, no catastrophic-failure tests. The formatter task explicitly says to study and mirror `processTypeAlias` — that's the "Inconsistent patterns" anti-pattern being actively avoided.

## Test-plan review: will these tests fail when the code breaks?

Mostly the tests are well-targeted and would catch real regressions. But two of the most important tests — the two guarding the two hardest parts of the feature — are written in a way that **would pass even if the code is broken**, and there are several missing cases around the feature's core semantic promises. Ordered by how much it matters.

### The location-mapping test cannot fail (most serious)

Task 3 Step 5's location test (`"a parse error inside the body maps to the enclosing file's line"`) asserts only `r.success === false`, and the comment says *"Pin whatever line the message carries."* That is backwards. Location mapping is called "the one genuinely fiddly implementation point," and I flagged a concrete bug in it earlier (the `trim()` offset is dropped from the shift). **This test is exactly where that bug should be caught — and as written it would not catch it.** "Pin whatever the message carries" means writing the assertion to match whatever the code currently does, so a mapping that reports body-relative line 2 instead of file line ~4 would be enshrined as correct and the test would go green on a broken implementation.

Fix: compute the expected line by hand from intent (literal opens on file line 3 / 0-indexed 2; body error on its own line 2 → reported at file line ~4) and assert that exact number, written *before* running the code. If the observed value disagrees, that's a bug to fix, not a number to copy.

And a missing sibling: the shown test uses `applyTemplate=false` (offset 0). The bug-prone case is the **additive** one — a literal inside a file parsed *with* the prelude template offset (`applyTemplate=true`), where the shift must be `preludeOffset + literalStart + trimmedPrefix`. The plan says "the additive property gets a dedicated test" but no such test is shown. Add it; it's the case most likely to be wrong.

### The end-scan tests need to assert body content, not just `.success` (second most serious)

The interpolation-corner test (`"|] inside an interpolation's nested string is inert"`, body `"${ f("has |] here") }"`) is the single most important correctness test in the plan — it's the safety net for the hand-rolled `skipStringForScan` lexer I flagged as duplicated. But its assertion is elided, and if it lands as just `expect(r.success).toBe(true)`, it may not catch early termination: if the scanner wrongly ends the literal at the inner `|]`, the remainder (`" here") }"\n...`) might still fail to parse — giving `success === false` and catching it — **or** might coincidentally parse into *something*, giving a false green. Don't rely on that coincidence.

Fix: assert the literal's captured body **structurally** — the string segment inside the body equals `has |] here` (or the body's node is a single string whose text contains `|]`). Same for the `"Pick: [x|y|]"` and comment-inert tests: assert the body content survived intact, not merely that the file parsed. Make these assertions strong precisely because the implementation underneath them is the riskiest.

### Missing end-scan case: `|]` in interpolation *code* position

Every shown end-scan test puts `|]` inside a string or a *nested* string within an interpolation. None puts `|]` in interpolation **code** position — the interior of `${ ... }` that is not itself inside a nested string. The plan's `skipStringForScan` descends into `${...}` tracking brace depth and skips it wholesale, so a `|]` there is treated as interpolation content and does **not** terminate the literal. That may be the right call (it's part of the generated program's string), but it's an unpinned semantic decision in the exact code path most likely to be buggy. Add a test that pins the decision either way.

### Relaxation: the table edit has no guard on the rows it didn't mean to touch

Task 2 edits `assertKindMatchesSort`'s `allowed` table. The new tests cover expr→statements (success) and expr-hole-rejects-statements (still throws). But nothing pins the rows the edit must **preserve**:

- **`program` still fills a `statements` hole.** Today `statements: ["statements", "program"]`; the edit appends `"expr"`. If someone instead *replaced* rather than appended (`["statements", "expr"]`), decl-bearing literal bodies (which infer `program`) would stop filling statements holes — and no shown test catches it, because the compose fixture happens to route `program` into a `decl` hole (`#helpers`), not a `statements` hole. Add: a `program` fragment fills a `statements` hole.
- **`decl` and `identifier` rows unchanged.** A one-line assertion that a `decl` hole still rejects an `expr`/`statements` fragment guards a fat-finger to the wrong row.

Also, the two success assertions are `toContain("print(99)")` / `toContain("1 + 2")` — position-blind and (for `1 + 2`) formatter-spacing-brittle. Consider asserting the grafted node lands in the body array, not just that the substring appears somewhere.

### Missing: the feature's headline promises have no end-to-end test

- **`${...}` in a body passes through to the generated program.** This is a core semantic guarantee (the spec dwells on it, the no-splice divergence from TH rests on it), yet no fixture exercises a literal whose body contains `${x}` and checks the *generated* program still has the interpolation intact and host-unfilled. Add one to Task 8.
- **A malformed literal fails *compilation* with a mapped error.** The whole pitch is "compile error, not runtime error." That's tested at the parser-unit level but never as an integration: does `agency compile` on a real `.agency` file with a broken `[| ... |]` actually fail, with the error at the right line? The repo just gained `expectedCompileError` (#662) — use it. Without this, the parser unit test could pass while the error never surfaces through the real compile path.
- **fmt output is eyeballed, not pinned.** Task 5 Step 2 ends with "`pnpm run fmt` ... and eyeball once." Eyeballing is not a regression test. The round-trip gate proves *structural* identity but not the actual *text* (indentation, inline-vs-multiline `[| ... |]`). Add a golden-file fmt fixture: input `.agency` with a literal → exact expected formatted output. That's the only thing that will catch a formatting regression later.

### Tests that are genuinely strong (keep as-is)

- **Leaf-ness** (Task 4): `bodySlots(lit) === []` **and** walkNodes never yields the quoted `print` — this fails loudly if either lever regresses, and the fresh-parse means the only `print` is the quoted one, so the negative assertion is sound. Good test.
- **NO_EXPRESSION_SLOTS needs no new test** — correct: adding `codeLiteral` to `EXPRESSION_NODE_TYPES` makes the existing completeness test fail until it's registered. That's a real forcing function.
- **The compose fixture** (Task 8): checks output *and* hole count *and* origin — a broken compose fails on at least one. Strong integration coverage.
- **The typechecker `fill(lit, {...})` test** is the right proof for finding #1, *and* the plan correctly mandates the explicit-severity harness from `holes.test.ts` so the check can't pass vacuously under default-suppressed diagnostics. One gap: the "no undefined-variable diagnostics for body names" test is only meaningful if the body actually contains a name that *would* be undefined in host scope — specify that (e.g. body references `helper`, undefined in the host), or the test is vacuous.

### One deferred-behavior smell

Both the empty-body test (`[| |]`) and the location test lean on "match whatever the runtime parser does." For empty-body that's a defensible tie-break on a genuine open question — but the plan should *decide* the behavior and assert it, not encode "whatever it currently does." A test whose expected value is defined as "the current output" can never detect a regression in that output.

## Bottom line

Fix #1 (synthesized type must use `Code`'s literal/union fields, not `string`) — that's the one that fails the happy path. Rebuild the **end-scan on the existing string/comment parsers** instead of the hand-rolled lexer — that removes the one real anti-pattern (duplicated lexer) plus its braceless one-liners and magic numbers, and it's also the top correctness risk. Fix #2 (trim vs. location offset) and #4 (default to injection, not the cycle-prone direct call) in the fiddliest area. Correct #3 (Task 6 Step 1's shown code) so the executor doesn't implement the contradicted version. After that, ship it.
