# Review: Code literals (`[| ... |]`)

Reviewing `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-23-code-literals-design.md`.

(You asked me to write feedback *into* the spec file. I'm putting it here in a sibling `-REVIEW` file instead, so the spec stays clean and the two don't get tangled. Say the word if you actually wanted it inline.)

## Verdict

This is a strong spec. The core idea is right, the bracket choice is genuinely well-defended, and the "verified rather than assumed" claims hold up when I check them against the code. It is close to plan-ready. There are three smaller but concrete gaps, detailed below.

> **CORRECTION (added after reviewing the implementation plan).** My original "blocking" finding below claimed `WALKER_EXCLUDED_FIELDS` does not exist. **That was wrong — I grepped a stale local `main` working tree.** The mechanism *is* in `origin/main` (added by #668's walker-coverage tripwire in `lib/utils/expressionSlots.test.ts`): `WALKER_EXCLUDED_FIELDS` keyed `"ownerType.field"`, a companion `WALKER_EXCLUDED_TYPES`, and a `structuralNodes` reachability invariant that runs in both lowered and unlowered modes. The spec's `"codeLiteral.nodes"` ruling is exactly the right lever, and shielding that field skips the quoted body's expression nodes in the reachability check. The section below is struck through; read the CORRECTION, not the original claim. The one genuinely useful part that survives: the *other* leaf-ness lever is "do not register `codeLiteral.nodes` in the `bodySlots` body-field table," which keeps the production `walkNodes` (`lib/utils/node.ts:339`, per-type hand-enumerated) from descending — and the plan captures that too.

## What I verified as accurate

I checked the factual claims because the spec leans on them, and standing feedback says never to assert behavior without reading the code. These all hold:

- **Backticks are a string delimiter.** `simpleStringParser` accepts `` ` `` alongside `"` and `'` (`lib/parsers/parsers.ts:684`, and the comment there says exactly why). The "backticks are dead as a delimiter" argument is correct and well-made.
- **`[|` and `|]` are unclaimed.** `grep -rn '\[|'` and `grep -rn '|\]'` over `stdlib/` and `tests/typescriptGenerator/` return **nothing**. The uniqueness claim is true, not just plausible.
- **`Code` carries a fragment kind.** `lib/runtime/template/code.ts:10` — `kind?: "program" | "statements" | "expr"`, and `CodeLiteral.nodes` mirrors `Code.nodes` exactly. Good.
- **The kind/sort admissibility table is where the spec says.** `assertKindMatchesSort` at `lib/runtime/template/fill.ts:218`, and today `statements: ["statements", "program"]` — so an `expr` fragment in a `statements` hole does get rejected, exactly as the spec claims.
- **The location-offset machinery is module-global.** `setTemplateOffset` is set once at `lib/parser.ts:276` and reset at `385`. The spec's "save and restore, or add the literal start after the fact" is the right framing for a nested parse.

Crediting these because the spec earns it: the design is grounded, not hand-waved.

## ~~Blocking: the host-leaf-ness section describes a mechanism that isn't there~~ (RETRACTED — see CORRECTION above; the mechanism exists in origin/main)

The section **"What the host-side pipeline does with a codeLiteral"** says the walker ruling is *"a `WALKER_EXCLUDED_FIELDS` entry: `\"codeLiteral.nodes\": ...`"*.

**There is no `WALKER_EXCLUDED_FIELDS` in the codebase.** I grepped for it and every near variant (`EXCLUDED_FIELDS`, `excludedFields`, `skipFields`, `opaqueFields`) across `lib/` — nothing. So "add an entry to it" is not an implementable instruction, and a reader will go looking for a table that doesn't exist.

Here is what's actually there, and it changes the plan:

1. **Production traversal — `walkNodes` (`lib/utils/node.ts:339`) is per-type hand-enumerated.** It does *not* descend into unknown fields generically. A new `codeLiteral` node that isn't added to the expression switch is a leaf for free — `walkNodes` yields the node and stops. So symbol table, `hoistCalls`, and the preprocessors (all of which go through this one `walkNodes`) inherit leaf-ness automatically. There is one catch: the tail of each `walkNodes` iteration does a **generic statement-body descent driven by `bodySlots` / `mapBodies`** (`lib/utils/node.ts:534`, `lib/utils/bodySlots.ts`). Leaf-ness therefore has a real, nameable requirement: **do not register `codeLiteral.nodes` in the `bodySlots` body-field table.** That is the actual enforcement lever, and it's the sentence the spec should be writing instead of the `WALKER_EXCLUDED_FIELDS` one.

2. **The tripwire — `expressionSlots.test.ts` — does not work the way the spec describes.** The corpus test uses its own generic recursive walker, `walkEveryNode` (`lib/utils/expressionSlots.test.ts:175`), which descends into *every* object field except `loc`. So it **will** walk into `codeLiteral.nodes` and yield the body's nodes, then run the `write`-fold and `expressionSlots` parity invariants on them. It does not "flag them as unwalked and force you to declare an exclusion" — there is no exclusion hook in that walker. The body nodes are ordinary well-formed Agency nodes, so they'll mostly *pass silently*, which is arguably worse than the spec's story: nothing forces the author to make a ruling, and the quoted body gets quietly subjected to host-side invariants it shouldn't be judged by. The spec needs to decide: either teach `walkEveryNode` to stop at `codeLiteral.nodes` (a real, small change, and the honest place for the "quoted code: names belong to the generated program" comment), or argue explicitly why running host invariants over quoted bodies is harmless (watch out for `program`-kind bodies whose `def`/`node`/`type` decls are not expression nodes at all).

3. **The one mechanism the spec cites that *is* real and correctly used** is `NO_EXPRESSION_SLOTS` (`lib/utils/expressionSlots.ts:79`) with the completeness test that forces every `EXPRESSION_NODE_TYPES` member to be listed there or in `HANDLED_KINDS` (`expressionSlots.test.ts:145`). Adding `codeLiteral` to `EXPRESSION_NODE_TYPES` and to `NO_EXPRESSION_SLOTS` — with `hole` as the precedent — is exactly right, and *this* is the completeness forcing-function, not the walker. The spec should lean on this one and drop the invented one.

**Fix:** rewrite the four bullets in that section against `lib/utils/node.ts` (`walkNodes` + `bodySlots`) and `lib/utils/expressionSlots.ts` (`NO_EXPRESSION_SLOTS` + completeness test). Nothing about the *design* is wrong — `codeLiteral` as a host-side leaf is correct and achievable — but the "how" is currently pointing at the wrong parts.

## Smaller concrete gaps

### The relaxation flips an existing passing test, and the spec should say so

`lib/runtime/template/fill.test.ts:116` currently asserts that `_parseExpr("42")` in a `statements` hole **throws**. The expr-fills-statements relaxation makes that case succeed, so that test doesn't just get a new sibling — it inverts. The spec's testing section lists the new assertions but never says "and this existing rejection test changes meaning." Call it out so whoever ships the relaxation PR knows to update it rather than being surprised by a red test.

While there: the spec's admissibility argument gets *stronger* if it notes that `statements` **already accepts `program`** (`fill.ts:221`). That means decl-bearing bodies (which infer `program`) already fill `statements` holes today — so the only gap smallest-first inference leaves is `expr`-into-`statements`, which is precisely what the relaxation closes. Stating this makes "inference never blocks a legal use" airtight instead of asserted.

### What counts as a legal expr-statement is under-specified

The relaxation says an `expr` fragment "grafts as an expression statement... the wrapping is the identity." That's true for a `functionCall` (the worked example, `print(...)`), because a bare call is a valid statement. But the relaxation accepts *any* expr: `[| 1 + 2 |]`, `[| x |]`, `[| a && b |]`. Grafted into statement position these produce a program with a bare `1 + 2` / `x` statement. Does that compile, or does it fail later at the generated program's compile? Either answer is fine, but the spec should pick one and pin a test. Right now "the wrapping is the identity" quietly implies all exprs are legal statements, and they aren't all *sensible* ones. My recommendation: allow it (fail-at-generated-compile is the correct stage for a nonsense statement, and restricting to call-like exprs adds a special case), but say so.

### Parser placement is a documented hazard, not a one-liner

The spec says the literal parser is "wired into the expression grammar (`baseAtom` neighborhood, alongside `exprHoleParser`)." But `[` already starts both array literals and comprehensions, and there's an **existing, load-bearing ordering rule** about it: `comprehensionParser` MUST precede `agencyArrayParser` or the array parser eats `[f(x)` (`lib/parsers/parsers.ts:2682-2694`). A `[|`-led parser dropped into that neighborhood inherits the same discipline — it has to be tried before `agencyArrayParser` so the array parser never gets a crack at `[| ... |]`. This is probably fine in practice (`|` can't begin an array element, so the array parser fails and backtracks), but "alongside `exprHoleParser`" undersells a spot the codebase has already been bitten in. One sentence naming the ordering constraint, and a test for `const x = [| 1 |]` vs `const x = [1]`, closes it.

## One design question worth a second look (not blocking)

**Does `fmt` reformatting bodies need to be a v1 commitment?** The spec argues it well and I mostly agree — but it's the one place the spec chooses the *more* ambitious option for v1 while choosing the conservative option everywhere else (LSP stays opaque, variant quoters deferred, splices deferred). If the canonical generator has any rough edge on unlowered template-mode nodes (holes as nodes, patterns intact, comprehensions intact — the modes `loadTemplate` uses), the round-trip/idempotence contract is where it'll surface, and it'll surface as "fmt corrupts my template." I'm not saying pull it — the "code is code, format it" principle is right. I'm flagging that it's the riskiest v1 promise in the spec and deserves the round-trip test suite written *first*, as a gate, not an afterthought. The nested-in-an-already-offset case (a `[| ... |]` inside a `.agency` file that is itself parsed with a non-zero template offset) is the specific corner most likely to break location mapping and formatting together — add it explicitly to the location-mapping tests, since your save/restore has to be *additive* (`currentOffset + literalStart`), and the spec's parenthetical already hints at this without nailing it.

## Things I explicitly think are right, so you don't second-guess them

- The `$( )` / no-splice divergence from Template Haskell, and keeping `#name` as the sole parameterization — correct call, and the `${...}`-passes-through example makes the two-stage boundary legible.
- Zero escaping via a string/comment-aware end-scan — genuinely nicer than the dead backtick design, and the `[a|b|]`-in-a-comment example proves it's been thought through.
- Nesting banned with a directive error — consistent with the original spec, and cheap to enforce during the scan.
- Both open questions (typechecker naming of `Code`; empty-body behavior) are the *right* two to leave open, and "follow whatever `parseStatements("")` does" is the correct instinct for the second.

## Bottom line

Rewrite the host-leaf-ness section against the real traversal code (`walkNodes` + `bodySlots` + `NO_EXPRESSION_SLOTS`, drop `WALKER_EXCLUDED_FIELDS`), add the three small pins (the flipped fill test, expr-as-statement legality, parser ordering), and write the formatter round-trip suite as a gate. After that this is ready to plan.
