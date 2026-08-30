# The `on`-clause handler alias

When a coding agent is asked to write a handler and has no documentation in front
of it, it tends to write a handler shaped like an effect-handler language (Koka,
OCaml) crossed with a `match`:

```
let res: Result<string> = handle (foo(dir: dir)) with {
  on std::read(data) { approve() }
  on std::write(data) { if (data.dir == ".") { approve() } else { reject() } }
  on _ { reject() }
}
```

None of that used to parse. The agent got a parse error on its first draft, which
cost a whole round trip to the model. This feature accepts that shape as a
lenient alias, the way `===` is accepted as another way to write `==`: it parses,
and `agency fmt` rewrites it to the one canonical handler form. The alias is not
documented for users and not recommended — it exists so an agent that reaches for
it gets working code instead of an error. (Issue #926.)

## The two surface forms

**The `on`-clause handler body.** After `with`, a block of `on` clauses:

```
} with {
  on std::read(data) { approve() }
  on _ { reject() }
}
```

**Expression-position `handle`.** A `handle` on the right-hand side of an
assignment, wrapping a single call and yielding its result:

```
let res: Result<string> = handle (foo(dir: dir)) with { on ... }
```

`handle` is a statement everywhere else.

## Why a parse-time desugar

Every accepted form desugars **at parse time** into the existing `handleBlock`
AST — an inline handler `(intr) { return match (intr.effect) { ... } }`. Because
the alias leaves no distinct node behind, codegen, the type checker, and the
formatter are all unchanged, and `agency fmt` prints the canonical form for free.
The whole feature is a parser change plus a pure AST transform; nothing
downstream knows the alias exists.

This is the same by-hand, site-by-site wiring `match` in value position and the
`with` modifier already use (see `match-expression-positions.md` and
`with-approve.md`).

## What the desugar does

The desugar lives in `lib/parsers/onClauseHandler.ts`; the parser that drives it
is `onClauseHandlerParser` in `lib/parsers/parsers.ts`.

- **Effect-name matching.** Each `on <effect>` clause becomes a `"<effect>" =>`
  arm in `match (intr.effect)`. The name may be namespaced (`std::read`), bare
  (`deploy`), or quoted (`"std::read"`) — all normalize to the same string.
- **Parameter binding.** `on <effect>(param)` prepends `const <param> =
  intr.data` to the arm, so the clause reads `data.dir` (i.e. `intr.data.dir`),
  which is where the real effects put their payload. `on <effect>(_)` and `on _`
  bind nothing.
- **Tail-verdict lifting.** A clause may end in a bare `approve()` / `reject()` /
  `pass()` / `propagate()` with no `return`; a bare verdict call sets no verdict
  on its own, so the desugar turns a tail-position one into `return <call>`.
- **Clause completion.** After lifting, a clause that still does not return on
  every path gets `return pass()` appended — "no verdict means pass", the same
  default a canonical handler body has. Without this, a side-effect-only or
  else-less clause would trip the all-paths-return `LoweringError`
  (`lib/lowering/patternLowering.ts`) on a `match` the author never wrote.
- **The catch-all.** `on _` becomes the `_` arm. If it is omitted, the desugar
  appends `_ => pass()`, so unmatched effects fall through to the safe default.

`handle (expr) with H` desugars by pulling the assignment inside the handler
body — `handle { let res = expr } with H` — reusing the `with`-modifier trick.
The bound name escapes the handler body because locals live on `__stack.locals`,
not a JS `const`.

## Two deliberate boundaries

- **Lifting descends into a trailing `if`/`else` only** — with or without an
  else, each branch that exists is lifted — and nothing else. A trailing
  statement-position `match` is left as written; its bare verdicts stay calls and
  clause completion makes the clause pass. Write `return approve()` inside a
  `match` arm if you mean it.
- **Expression `handle` is wired at the assignment RHS only.** `return handle(…)`
  and a bare-statement `handle (expr) with H` are not accepted; they were not in
  the observed agent output.

## Parse errors

Three shapes are refused with their own committed messages (so the real message
surfaces, not a generic backtracked one):

- a duplicate effect (`on std::read` twice, compared on the normalized name),
- an empty `with { }` (no clauses),
- an `on _` that is not the last clause (it would shadow every clause after it).

The messages live in `lib/parsers/messages.ts` and are extraction-tested by
`lib/parsers/errorExamples.test.ts`.

## Tests

- `lib/parsers/onClauseHandler.test.ts` — the pure builders (lifting, completion,
  handler assembly), including an equality check of the built AST against a
  parsed canonical handler.
- `lib/parsers/handleBlock.test.ts` — the surface forms and the three parse
  errors.
- `lib/backends/onClauseHandlerFormat.test.ts` — `agency fmt` normalizes the
  alias to the canonical handler.
- `tests/agency/on-clause-handler.agency` — the safety gate: the alias reaches
  the same verdicts as the canonical form, so no clause shape is fail-open.

## Not in this feature

Making a single-object `raise effect::name({ ... })` fill `intr.data` rather than
`intr.message` is a separate, larger change (it alters every existing
single-argument raise) and is deferred to its own spec.
