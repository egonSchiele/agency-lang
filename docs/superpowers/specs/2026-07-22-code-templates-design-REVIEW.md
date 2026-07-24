# Review: Code templates with typed holes

Reviewing `/Users/adityabhargava/agency-lang/docs/superpowers/specs/2026-07-22-code-templates-design.md`.

Overall: the shape is right. Building on the one canonical parse path and one canonical generate path is the correct altitude, the level ladder makes the scope defensible, and the decisions to skip nesting, reify, and lazy holes are all well argued. The file:line citations check out (I spot-verified `run`/`runFile`/`runCode`/`getEffects` in `stdlib/agency.agency`, the `#` description parser and its two wiring points in `lib/parsers/parsers.ts`, `raises` in `lib/types/function.ts:72-78`, and the round-trip machinery in `lib/stdlib/agency.ts:192-232`). The two-test-file blast radius for the `#` removal is accurate; a third grep hit (`tests/agency/agents/toolGaps.agency`) is `#` inside a comment, not the syntax.

But there are two findings I'd call blocking, because each one sits at the center of what the feature claims to provide.

## Blocking

### 1. The spec never says what a filler value *is*, and one reading reintroduces injection

`fill` takes "a record mapping hole names to values". The worked example fills an `expr` hole of type `string` with `userPrompt`, a plain string that a model produced. There are two readings of what happens next, and they have opposite safety properties:

- **The string is parsed as expression source.** Then the model can supply `readFile("/etc/passwd")`, which is a perfectly valid expression of type `string`. The skeleton is preserved, but the model now injects arbitrary calls into every expression hole. That is string-template injection again, just scoped to expressions. The example's claim that "the model cannot add a tool call" would be false.
- **The string is lifted to a string literal node.** Then the model's output is inert data, exactly as the safety argument requires, and the only way to put a *computation* into a hole is to supply a `Code` value that a template author deliberately constructed.

The second reading is clearly the intended one, but the spec never states it, and the typing section actively muddies it: "A `string` hole can be filled with `"hello"`, with `getPrompt()`, or with `a + b`" reads like fillers are fragments of source text. Elsewhere, `fill(code`import std::fs { #tool }`, { tool: name })` fills an `identifier` hole with a runtime string, which is the parse-it reading.

The spec needs a section stating the lifting rule explicitly. My suggestion: plain values (string, number, boolean, null, arrays and records of these) lift to literal nodes and are never parsed; `Code` values graft as trees; an `identifier` hole accepts a string only after validating it against the identifier grammar (`lib/parsers/parsers.ts:842-186` — a letter or underscore, then `varNameChar`), rejecting anything else at fill time. Without that last rule, `{ tool: "x } import evil" }` is an injection through the identifier hole.

### 2. Renamed identifiers do not survive re-parsing

Hygiene produces names like `tmp·1`, chosen because "nobody could have typed" them. But the design's own argument for renaming is that Code values must become text and be re-parsed by the subprocess. Identifiers are ASCII-only: `varNameChar` is `oneOf("a…zA…Z0…9_")` (`lib/parsers/parsers.ts:184-186`), and the leading character is `letter` or `_` (`lib/parsers/parsers.ts:842-849`). `tmp·1` fails to lex, so every program that needed renaming fails to parse in the subprocess.

Two ways out, and the spec has to pick one:

- **Extend the lexer** to accept `·` in identifiers. But then users *can* type it, "impossible by construction" stops being true, and you have changed the identifier grammar of the whole language for one feature.
- **Use a reserved ASCII scheme**, e.g. `__hyg1_tmp`, plus a rule that `fill` rejects any template or filler that already contains an identifier matching the reserved prefix. The rejection rule is what restores "impossible by construction" — a name can't collide with the renamer's output if the renamer refuses inputs that use its namespace.

The second is cheaper and doesn't touch the grammar. Either way, the worked hygiene example needs updating.

## Should fix before implementation

### 3. Fill-time typechecking has no environment, and filler scoping is unstated

Two connected gaps. First: to check that `a + b` has type `string` at fill time, the checker needs types for `a` and `b`. Checked against what scope? Second, and prior: hygiene guarantees a filler's names *cannot* bind to the template's locals — so what *can* a filler reference at all? Presumably the completed program's module scope: imports, top-level declarations, the prelude. The spec should say so, and say that fill-time expression checking runs against exactly that environment (which the template knows, since it owns the skeleton). This also determines the right error for a filler referencing a genuinely unknown name — the spec's hygiene section shows that error occurring, but never says which checking point produces it.

### 4. A bare hole in statement position is sort-ambiguous

The sort table says position determines sort. But `#setup` alone on a line sits in expression-statement position, which is simultaneously a legal statement position and a legal expression position. The examples clearly intend it as a `statements` hole. State the tie-break rule: a bare hole (or splice) as an entire statement has sort `statements`; a hole is `expr` only when it appears inside a larger expression. Worth a parser test either way, since expression-statements make this genuinely ambiguous, not just pedantically so.

### 5. The sort table doesn't cover the spec's own examples

The splice example puts import statements through `#...imports` at top level, and puts an `identifier` hole in an import specifier (`import std::fs { #tool }`). But the `decl` sort is defined as "a function, node, or type declaration" — no imports — and the `identifier` sort's position list doesn't include import specifiers. Either widen `decl` to "any top-level form" (and decide whether that includes bare top-level statements, `static` blocks, callbacks) or enumerate exactly which top-level forms are allowed. The table is the contract; it shouldn't be narrower than the worked examples.

### 6. `Code` values must survive serialization, and the spec doesn't mention it

`Code` is a first-class value, so it will land in variables that cross interrupt checkpoints, in the GlobalStore, and potentially in `args` records crossing the subprocess IPC boundary. Checkpointing serializes the state stack; a `Code` value that can't round-trip through that machinery breaks resume in any program that holds one across a pause. The implementation-ripple list covers AST, parser, checker, runtime, stdlib, LSP, lint, and docs, but not serialization. Given how much of this codebase's recent history is state-restoration bugs, this belongs on the list explicitly, with a decision: is the serialized form the AST, or the printed source? (Printed source is tempting — it reuses the canonical paths — but re-parsing on deserialize must preserve hole nodes, which ties into how `parseAgency` treats holes.)

### 7. Hygiene must also consider filler-vs-filler collisions

"Compute the set of names that appear on both sides" frames renaming as template-vs-filler. But two different `statements` fillers grafted into the same scope can collide with *each other* — each declares `const tmp`, neither collides with the template. The collision set has to be computed across all grafted pieces jointly, not pairwise against the template. One sentence fixes it, plus one test in the hygiene test list.

### 8. The comprehension in the worked example uses wrong syntax

`fill(...) for (name in chosen)` — comprehensions take no parentheses around the binder: `[double(x) for x in xs]` (`tests/agency/comprehensions/basic.agency:18`). Should be `for name in chosen`. Also, this comprehension's body spans multiple lines with the `for` on its own line; worth confirming the comprehension parser accepts that layout before enshrining it in a spec example.

## Minor

### 9. "Targets levels 2 through 4" overstates level 4

Level 4 is defined as "you cannot build one that fails to typecheck" — a compile-time guarantee, per Template Haskell's typed splices. What this design delivers is runtime type validation at fill time, plus a full typecheck at run time. A completed program can still fail its full check (deferred definite-returns, filler referencing an unknown name). That's a fine place to land, but the ladder framing promises more than the design delivers. Say "levels 2 and 3, plus fill-time type validation" or redefine level 4 honestly.

### 10. Recommendations on the open questions

- **Partial fill (Q3):** return a template with fewer holes. It composes with the "build pieces, then splice" pattern the spec itself recommends, and the existing unknown-name error already catches the typo case that error-on-missing would protect against. Refusal-to-run already backstops a template that reaches `run` incomplete.
- **`type` sort (Q1) and literal-vs-file checking (Q2):** defer both; nothing in the primary use case needs them, and Q2's file path is the ergonomic one anyway.
- **Q4:** the description in `tests/agency/validation/jsonSchemaWithDescription.agency:11` sits on a property whose type is separately `@jsonSchema`-annotated, so the two mechanisms currently coexist rather than one replacing the other. The confirmation the spec asks for is genuinely needed — specifically that per-*property* (not per-type) descriptions can reach the emitted schema some other way.

### 11. Two small example nits

- The splice example builds `program` with an unfilled `#body` and stops. A one-line continuation (`fill(program, { body: ... })` then `run`) would make the example complete and would incidentally demonstrate the partial-fill answer chosen in Q3.
- The hygiene example's renamed output renames `result` (`result·2`) even though only `tmp` collides. Under the selective-renaming rule the spec itself states, `result` should be untouched. The example contradicts the rule two paragraphs below it.
