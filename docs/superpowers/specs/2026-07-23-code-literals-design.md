# Code literals: inline templates with `[| ... |]`

Status: design, awaiting review
Date: 2026-07-23

## Background

### The problem we are trying to solve

Template Agency shipped with two ways to get a template: load it from a file (`loadTemplate`), or parse a runtime string (`parseExpr`, `parseStatements`). Files are the right tool for anything substantial — they get the formatter, the editor, and syntax checking on their own terms. But the composition workflow the feature was built for keeps producing *small* fragments, and for those, both existing routes are clumsy in a way that shows up in every real example we have written so far:

```ts
// A three-line fragment today: either a whole separate file...
const importTpl = loadTemplate(__dirname, "importOneTool.agency")

// ...or a runtime string with escaped newlines.
const step = parseStatements("const data: string = readFile(path)\nprint(data)")
```

The file route splits a five-line generator across two files, so the reader of the generator cannot see the shape being generated. The string route is worse in a quieter way: the string parses at *runtime*. A typo in that string is a runtime failure in whoever calls the generator, not a compile error in the generator itself. And a template author writing `\n`-joined strings has lost every property that made templates better than string concatenation in the first place — no highlighting, no formatter, no early checking.

The original spec anticipated this. Every example in it was written as a `` code`...` `` literal, labeled "the eventual shape," and the literal form was explicitly deferred to v2 ("files are the ergonomic route for anything longer than a couple of lines... the literal path is meaningfully more parser work"). This is v2.

### What we want

A way to write a template *inline*, as real Agency code inside an Agency file, such that:

- the body is checked when the enclosing file compiles, not when the program runs;
- the body contains holes (`#name`) exactly as a template file would;
- the resulting value is an ordinary `Code` value — everything `fill`, `holesOf`, `toSource`, and composition already do applies unchanged;
- the reader of a generator sees the shape being generated, in place.

### Why not the backtick form from the original spec

The original spec's examples used `` code`...` ``. That form is dead on a fact about the grammar: backticks are a **string delimiter** in Agency. `simpleStringParser` accepts `` ` `` alongside `"` and `'` (`lib/parsers/parsers.ts:684`), and the delimiter-aware segment rule exists precisely so the *other two* quote characters can appear unescaped inside a string. Template bodies are programs, and programs contain strings — including backtick strings. A backtick-delimited literal would terminate at the first backtick string inside the body, and every such template would need escaping. The delimiter would collide with the single most common thing bodies contain.

## What we are building

Agency gains **code literals**: Template Haskell's quotation brackets, containing Agency code with holes, producing a `Code` value.

```ts
const guardTpl = [|
  def guarded(): string {
    const ms: number = #minutes
    #body
  }
|]

const program = fill(mainTpl.value, { helpers: fill(guardTpl, { body: steps }).value })
```

A code literal is an expression. Its body parses when the enclosing file parses, so a malformed template is a compile error with a real location. At runtime it evaluates to the same kind of `Code` value `loadTemplate` returns, with its kind inferred from the body's shape.

Why these brackets, verified rather than assumed:

- `[|` is unclaimed: `const x = [| 1 |]` is a parse error today, and nothing in `lib/parsers/parsers.ts` touches the sequence.
- The closing sequence `|]` appears **nowhere** in the entire stdlib and generator-fixture corpus. Agency spells unions with spaces, pipe is `|>`, and there is no `|` bracket form — `|]` in code position is not something legal Agency produces.
- The variant-quoter fallback (`[e| ... |]`, `[d| ... |]`) is the established Template Haskell spelling if kind inference ever needs an explicit override — same bracket family, additive, no second syntax to invent. Those variants are **reserved, not built** (see kind inference below).

One divergence from Template Haskell to state up front, because TH-literate readers will expect it: we take TH's *quote* syntax and not its *splice* syntax. There is no `$( )`. Holes (`#name`) remain the only parameterization, and `fill` remains the only way values get in. `${...}` appearing in the body always belongs to the generated program's own strings and passes through untouched:

```ts
const tpl = [|
  node main(): string {
    const topic: string = #topic
    return llm("Summarize ${topic} in 50 words")   // the GENERATED program's interpolation
  }
|]
```

This keeps the rule everything rests on — fillers are never parsed; there is exactly one way to parameterize a template — and it keeps the two execution stages visually distinct.

## Design

### Finding the end: no escaping rules at all

The body runs from `[|` to the first `|]` **in code position**. The end-scan is string- and comment-aware: while searching for `|]`, the scanner skips over string literals (all three delimiters, with their existing escape rules) and comments (`//`, `/* */`), using the lexing rules the parser already has. So:

```ts
const quiz = [|
  node main(): string {
    // options render as [a|b|] in the UI — this comment is inert
    return llm("Pick one: [x|y|]")                 // this string is inert
  }
|]
```

Both `|]` sequences above are inside skipped regions; the literal ends at the final line. And since `|]` in *code* position is not legal Agency, there is nothing left that needs an escape. Zero escaping rules — which is strictly better than the backtick design ever was (it needed `` \` ``), and it falls out of scanning with the lexer instead of scanning raw.

An unclosed literal is a parse error reported at the opening `[|`, phrased in terms of the missing `|]` — not a cascade of confusing errors from the parser eating the rest of the file as body.

### Kind inference: smallest-first, with one admissibility relaxation

A `Code` value carries a fragment kind — `expr`, `statements`, or `program` (`lib/runtime/template/code.ts`) — and `fill` checks kinds against hole sorts. A literal's kind comes from its body, smallest first:

1. If the body parses as a **single expression** with nothing left over, the kind is `expr`.
2. Else, if it parses as a **statement list**, the kind is `statements`.
3. Else, it parses as a **program** (top-level declarations: `def`, `node`, `type`, imports), and the kind is `program`.
4. Else, the first parse failure is reported, at the mapped location inside the body.

The known ambiguity: `f(1)` parses as an expression, so `[| f(1) |]` infers `expr` — but a caller may have meant it as a statement, and today `assertKindMatchesSort` (`lib/runtime/template/fill.ts`) rejects an `expr` fragment in a `statements` hole. The resolution is a small, separately-shipped change to `fill`:

**The expr-fills-statements relaxation.** A `statements` hole accepts an `expr` fragment; the expression grafts as an expression statement (in the AST, an expression statement *is* the expression node in the body array, so the wrapping is the identity). This is a semantic widening of `fill` for all callers, not just literals — `parseExpr` results become usable in statement position too — which is why it ships as its own reviewed change with its own tests, before or alongside the literal work.

Two facts make the "inference never blocks a legal use" claim airtight rather than asserted. First, `statements` holes **already accept `program` fragments** (`fill.ts:221`), so decl-bearing bodies — which infer `program` — fill statements holes today; the `expr`-into-`statements` case is the *only* gap smallest-first inference leaves, and it is exactly the one the relaxation closes. Second, the relaxation **inverts an existing passing test**: `fill.test.ts` ("rejects an expr fragment in a statements hole", currently asserting `_parseExpr("42")` in a statements hole throws) changes meaning, not just gains a sibling — the relaxation PR updates that test deliberately rather than being surprised by it.

One legality ruling the relaxation must state: it accepts *any* expr, including ones that make odd statements (`1 + 2`, a bare `x`). The grafted program then carries a bare-expression statement, and whether that is meaningful is judged where it should be — at the generated program's own compile. No call-like-exprs-only special case; a nonsense statement failing at generated-compile time is the correct stage, and a test pins one such case.

If practice ever turns up a case where inference confuses anyway, the fallback is decided in advance: TH-style variant quoters (`[e| ... |]` for expression, `[d| ... |]` for declarations), added additively. v1 does not parse them; v1 also does not need to reserve them in the grammar, because `[e|` is just as unparseable today as `[|` and claiming it later breaks nothing.

### One thing the brackets forbid: nesting

A `[|` inside a literal body is a parse error, with a message that says what to do instead:

```
nested code literals are not supported; build the inner piece as its own
value and graft it into a hole
```

This is the original spec's nested-template ruling carried forward unchanged: a hole inside a nested quote has two plausible owners, TH resolves that with stage levels and stage errors (the single most bounced-off thing in TH), and composition through holes makes the whole question unnecessary. The end-scan makes the ban cheap to enforce — encountering `[|` in code position during the scan is immediately reportable.

### The AST node, and when the body parses

The parser produces a new expression node:

```ts
export type CodeLiteral = BaseNode & {
  type: "codeLiteral";
  /** The PARSED body — real AgencyNode trees, holes included. */
  nodes: AgencyNode[];
  /** Inferred fragment kind (see kind inference). */
  kind: "expr" | "statements" | "program";
};
```

The body is parsed **at parse time of the enclosing file**, by the literal's own parser, in unlowered template mode (the same mode `loadTemplate` uses — patterns intact, comprehensions intact, holes as nodes). Storing the parsed tree rather than raw text is what makes the formatter decision below possible, and it means "compile-time validation" is not a separate pass — a bad body simply fails the parse of the enclosing file.

Location mapping: positions inside the body must report in the enclosing file's coordinates. The offset machinery for "this text lives at an offset inside another parse" exists (`docs/dev/locations.md`, `setTemplateOffset` in `lib/parser.ts`) but is module-global and set once per `parseAgency` call — a nested parse mid-parse must **save and restore** it (or map locations after the fact by adding the literal's start position). This is the one genuinely fiddly implementation point in the parser work; it gets its own tests (a parse error on line 3 of a literal that starts on line 40 reports around line 43 of the file).

### What the host-side pipeline does with a codeLiteral

The body is *quoted* code: its names belong to the generated program, not to the host program's scopes. Every host-side pass must treat the node as a leaf. Leaf-ness is not one switch — it is four specific levers, each named here against the code that enforces it:

- **The production walker gives leaf-ness for free, with one requirement.** `walkNodes` (`lib/utils/node.ts:339`) is per-type hand-enumerated: a node kind with no descent case is yielded and not entered, so the symbol table, `hoistCalls`, and the preprocessors — all riding on this one walker — never see inside the body *unless someone adds a case*. The one active requirement is the walker's generic tail: every iteration ends with a statement-body descent driven by the shared `bodySlots` table (`lib/utils/node.ts:534`, `lib/utils/bodySlots.ts`). So the enforcement sentence is: **`codeLiteral.nodes` must NOT be registered in `bodySlots`** — it is quoted code, not a statement body the host owns. That non-registration is the lever, and it gets a comment in `bodySlots.ts` saying so, because that file's header documents exactly the drift ("each consumer hand-listed the node types and they drifted") that would otherwise re-add it helpfully someday.
- **The completeness forcing-function is `NO_EXPRESSION_SLOTS`.** `codeLiteral` joins `EXPRESSION_NODE_TYPES`, and the slot-table completeness test (`expressionSlots.test.ts`) then *requires* it to be registered either with slots or in `NO_EXPRESSION_SLOTS` (`lib/utils/expressionSlots.ts:79`) — an unregistered kind fails by name. It registers as slot-free with `hole` as the precedent: a leaf that stands for a value. `hoistCalls` inherits leaf-ness through this table.
- **The walker-coverage tripwire forces the ruling to be recorded.** The structural-reachability invariant (`structuralNodes` + `WALKER_EXCLUDED_FIELDS`, `lib/utils/expressionSlots.test.ts:367` as of #669/#670) crawls every field and demands every expression-typed node be walker-reachable unless its owning field carries a recorded ruling. Quoted body nodes are reachable and deliberately unwalked, so the invariant fails until the entry exists: `"codeLiteral.nodes": "quoted code: names belong to the generated program, not the host scope"`. The tripwire is what turns "we decided not to walk it" into a test-enforced decision.
- **The older corpus invariants DO look inside, and that is fine.** The write-fold round-trip, parity, and statement-ruling invariants in the same file use `walkEveryNode`, a generic crawl with no exclusion hook — they will descend into quoted bodies and apply their checks to the body's nodes. This is deliberate and harmless: those invariants are node-local properties of well-formed Agency nodes (slot writers are identities, statement kinds have hoistCalls rulings), and quoted nodes are well-formed Agency nodes — the checks hold for them for the same reason they hold for file-parsed ones. Running them over bodies is free extra coverage, not a leak; the spec states it so nobody "fixes" it.

Symbol table and typechecker do no name resolution inside the body (a quoted reference to `helper` resolves in the *generated* program at its own compile); the literal itself synthesizes the `Code` type — see the open question below. Note the symmetry with template hygiene: host hygiene must NOT see quoted names (a host variable named `tmp` must not collide with a quoted `tmp`), and quoted-code hygiene happens later, at `fill` time, on the runtime `Code` value, by machinery that already exists.

### Codegen and runtime construction

Generated TypeScript embeds the body as **printed source** and constructs the `Code` value at runtime through the canonical path (`_loadTemplateFromString`-style: the one source→AST route), with the inferred kind attached. This deliberately reuses the serialization decision — `Code`'s canonical form is printed source — instead of inventing an embedded-AST-JSON representation, and it means a literal-built `Code` value is indistinguishable from a file-loaded one everywhere downstream: `fill`, `holesOf`, hygiene, checkpointing (the Task-17 fixture already proves Code crosses checkpoints), and the subprocess boundary.

The printed source embedded by codegen is produced by the canonical generator from the parsed body — which, note, is already formatter-normalized (next section), so what codegen embeds and what `fmt` shows are the same text.

### The formatter owns formatting, including inside the literal

Decided: `pnpm run fmt` **reformats the body** of a code literal, exactly as it would format the same code in a file. The formatter prints `[|`, the canonically-formatted body (indented one level relative to the literal's position), and `|]`. There is no dedent feature and no verbatim-preservation mode: the body is code, and code is held to the formatter's standard wherever it lives. Consequences worth stating because they are deliberate:

- `fmt` rewrites text inside what looks like a quoted region. That is the point, not a bug — a template body in a literal gets the same treatment a template file gets.
- Round-trip tests are the formatter contract: parse a file containing literals, print it, re-parse, and the literal bodies are structurally identical; `fmt` is idempotent on files containing literals.
- Comments inside the body survive exactly as well as the formatter preserves comments in files — no better, no worse.
- **This is the riskiest v1 promise in the spec, and it is gated accordingly**: everywhere else v1 takes the conservative option (LSP opaque, quoters deferred, splices deferred), and here it takes the ambitious one. The generator has to be clean on unlowered template-mode nodes (holes, patterns, comprehensions intact — the modes `loadTemplate` parses in), and any rough edge surfaces as "fmt corrupts my template." So the plan sequences the round-trip/idempotence suite FIRST, as a gate the formatter work must pass before the feature ships — not as an afterthought. If the gate finds generator gaps, fixing them precedes the literal.

### Interaction with holes: nothing new

Holes inside a literal body parse by the existing position-driven rules — `#name` in expression position is an `expr` hole, on its own line a `statements` hole, in a name position an `identifier` hole, at the top level of a `program`-kind body a `decl` hole. Splices (`#...name`) and quoted names (`#"..."`) work unchanged. `holesOf` on a literal-built value reports the same `HoleInfo` records, `origin` included once the value has been through a graft. The AG8001 refusal applies unchanged when a still-holed program reaches the compiler. No hole machinery is touched by this feature.

## Worked example: the news agent, fully inline

The composition example from the guide, with no template files at all:

```ts
import { fill, holesOf, toSource, runCode } from "std::agency"

node main(): string {
  const guardTpl = [|
    def guarded(): string {
      const ms: number = #minutes
      const r = guard(time: ms) {
        #body
      }
      return "done"
    }
  |]

  const mainTpl = [|
    #helpers

    export node main(): string {
      return guarded()
    }
  |]

  const body = [| print("fetching news") |]          // infers expr; fills #body via the relaxation
  const partial = fill(guardTpl, { body: body })
  if (isFailure(partial)) {
    return "guard fill failed"
  }
  const program = fill(mainTpl, { helpers: partial.value })
  if (isFailure(program)) {
    return "compose failed"
  }
  // holesOf still reports the grafted #minutes with origin "helpers"
  const done = fill(program.value, { minutes: 120000 })
  if (isFailure(done)) {
    return "final fill failed"
  }
  return runCode(toSource(done.value)) with approve
}
```

Every property the file workflow has is visible here: partial fill, composition with a hole still open, origin attribution, the final full compile at `runCode`. The only change is that the shapes live where the reader is.

## Out of scope, and why

**`$( )` splices.** Covered above: holes are the single parameterization mechanism. A future `#{expr}` lifting interpolation (babel-template's ergonomic: a hole created and filled at construction through the lifting rule, never parsed) is *additive* if the two-step `fill` proves annoying in the template library — and deliberately deferred until that library exists to tell us.

**Variant quoters** (`[e| |]`, `[d| |]`, `[t| |]`). The decided fallback for kind inference, not part of v1. Nothing needs reserving; the sequences are unparseable today and claiming them later is non-breaking. `[t| |]` in particular waits on the `type` hole sort, which is its own deferred feature.

**Nested literals.** Forbidden with a directive error message; unchanged ruling from the original spec.

**Highlighting the body as Agency in editors.** The LSP treats a literal as an opaque expression in v1 (no false diagnostics inside the body — same tolerance the template file path already has). Semantic highlighting inside bodies is a follow-up.

## Implementation ripple

- **Parser** (`lib/parsers/parsers.ts`): the literal parser — string/comment-aware end-scan, nested-`[|` rejection, kind inference by smallest-first try-parse, template-offset save/restore for location mapping. Wired into the expression grammar in the `baseAtom` neighborhood — and subject to an ordering discipline that neighborhood has already been bitten by: `comprehensionParser` MUST precede `agencyArrayParser` because the array parser would consume `[f(x)` and die at `for` (`parsers.ts:2682`, documented there). The literal parser is a third `[`-led alternative and must be tried before `agencyArrayParser` for the same reason; a test pins `const x = [| 1 |]` against `const x = [1]` so the ordering cannot regress silently.
- **Types** (`lib/types/`): the `CodeLiteral` node; `EXPRESSION_NODE_TYPES` membership.
- **fill** (`lib/runtime/template/fill.ts`): the expr-fills-statements relaxation — **its own change, own tests, possibly its own PR**, since it widens admissibility for every caller.
- **expressionSlots / tripwire**: `NO_EXPRESSION_SLOTS` entry; `WALKER_EXCLUDED_FIELDS` ruling `"codeLiteral.nodes"`; hoistCalls inherits leaf-ness through the slot table.
- **Typechecker**: synthesize the `Code` type for the literal (open question below); no descent into the body.
- **Generator/formatter** (`lib/backends/agencyGenerator.ts`): print `[|` + formatted body + `|]`; round-trip and idempotence tests.
- **Codegen** (`lib/backends/typescriptBuilder.ts`): emit the canonical printed body + runtime construction call with the inferred kind.
- **LSP**: opaque-expression tolerance; verify no spurious diagnostics inside bodies.
- **Docs**: guide section in `docs/site/guide/templates.md` (the inline workflow, the no-`$()` note for TH readers, the fmt-reformats-bodies behavior); `docs/dev/template-agency.md` internals update.

## Testing strategy

Everything below runs without LLM calls.

- **End-scan**: `|]` inside strings (all three delimiters), inside `//` and `/* */` comments, and immediately after an escape sequence — all inert; the literal ends at the first code-position `|]`. Unclosed literal reports at the opening `[|`. Nested `[|` reports the directive message.
- **Kind inference**: a lone expression infers `expr` (including `f(1)`); two statements infer `statements`; a body with a `def` infers `program`; an empty body — decide and pin (recommendation: `statements` with zero nodes, matching `parseStatements("")`... which currently rejects empty; match whatever it does, and test it).
- **Location mapping**: a parse error on body line N of a literal starting at file line M reports at approximately M+N, not at line N and not at the `[|`. And the compounding corner: a literal inside a file that is *itself* parsed with a non-zero template offset (the prelude-template mode most files parse under) — the save/restore must be additive (`enclosing offset + literal start`), and this case gets its own test because it is the one most likely to break location mapping and formatting together.
- **The relaxation** (separate suite, lands with the fill change): `parseExpr` result fills a `statements` hole; the grafted expression round-trips as an expression statement; `expr` holes still reject multi-statement fragments; the existing "rejects an expr fragment in a statements hole" test is inverted deliberately; one odd-statement case (`1 + 2` into a statements hole) grafts fine and is judged at the generated program's compile.
- **Formatter**: round-trip structural identity; idempotence; a deliberately mis-indented body comes out canonically formatted; a body comment survives.
- **Host-side leaf-ness**: the completeness test forces the `NO_EXPRESSION_SLOTS` registration; the structural-reachability invariant forces the `WALKER_EXCLUDED_FIELDS["codeLiteral.nodes"]` ruling; a bodySlots-non-registration assertion (bodySlots(codeLiteral) is empty) pins the production-walker lever; and a host variable sharing a name with a quoted variable produces no host diagnostics and no hygiene interaction until fill time (execution test: host `tmp`, quoted `tmp`, filler using `tmp` — only the fill-time rename fires, and only on the quoted side).
- **End to end** (execution tests): the worked example above as a fixture — inline compose, partial fill, origin on the grafted hole, `runCode` under a handler; and a checkpoint test holding a literal-built `Code` across an interrupt (mirroring the existing `codeAcrossCheckpoint` fixture).
- **Equivalence**: `toSource` of a literal-built value equals the formatter output of the equivalent template file — pinning "indistinguishable from file-loaded" as a tested property, not a claim.

## Open questions

1. **How does the typechecker name the `Code` type?** The literal must synthesize the same type `loadTemplate`'s `Result<Code>` carries, but `Code` is declared in `stdlib/agency.agency`, and a builtin expression synthesizing a stdlib-declared nominal type needs a mechanism (the prelude auto-import machinery is the likely route; `std::index` re-exports could carry it). Recommendation: resolve `Code` through the auto-import path when available, and treat "literal used in a file that cannot see `Code`" as the same kind of situation as any other missing-type reference. Needs a decision during planning, not another spec.
2. **Empty body `[| |]`**: error, or an empty `statements` fragment? Recommendation: follow whatever `parseStatements("")` does today so the literal and the runtime parser never disagree; pin it in a test either way.
