# Effect patterns in `match`

An effect pattern lets a `match` arm name an interrupt effect directly and
optionally destructure its payload, instead of comparing `intr.effect` against
a string by hand. Inside a handler:

```
handle {
  a = act(dir: ".")
} with (intr) {
  return match (intr) {
    app::write({ data }) if data.dir == "/tmp" => return approve()
    app::write => return reject()
    _ => return reject()
  }
}
```

Before this feature the same handler was written with `match(intr.effect)` and
string arms, pulling the payload out by hand with `const data = intr.data`.

## What it is

An `effectPattern` is a new `MatchPattern` variant (`lib/types/pattern.ts`),
modeled on `resultPattern` (`success(s)` / `failure(e)`). It has two forms:

- `app::write` — matches any interrupt whose effect is `app::write`, binds
  nothing.
- `app::write({ data })` — the same match, plus an object-pattern binding over
  the whole interrupt. `{ data }` binds `data = intr.data`.

Match on the whole interrupt, written `match(intr)`. The older form matched on
`intr.effect`; an effect pattern matches the interrupt itself so the binding can
reach its other fields. Those fields are `effect`, `message`, `data`, and
`origin`, so `app::write({ data })` binds the payload (which lives under
`intr.data`), and a deep destructure like `app::write({ data: { dir } })` binds
`dir = intr.data.dir`.

Like `resultPattern`, an effect pattern lives only in `MatchPattern` — legal in
a match arm and after `is` (`intr is app::write`, `if (intr is app::write({ data }))`),
never in `let`/`const`/`for`. It is kept out of `BindingPattern`.

## How it lowers

The pattern lowers (`lib/lowering/patternLowering.ts`) to existing nodes — no
new runtime helper. `app::write({ data })` becomes:

1. a shape check on the scrutinee (`intr != null && intr is object`),
2. an equality `intr.effect == "app::write"`, and
3. the object binding's own checks and bindings against the same source.

The shape check goes first so the `.effect` read is guarded: a null or
non-object scrutinee fails the arm rather than throwing. This keeps the lowered
condition a total function of the value, the invariant
`patternGuards.tripwire.test.ts` enforces across the whole corpus.

The binding is an ordinary `objectMatchPatternParser` object pattern, so it
carries full object-pattern semantics: value matchers add checks
(`app::write({ data: "x" })` also tests `intr.data == "x"`) and deep
destructures work (`app::write({ data: { dir } })`).

## The sites it touches

Every place that switches on `resultPattern` gains a parallel `effectPattern`
case. Grepping `effectPattern` across `lib/` is the checklist: the type and the
`MatchPattern` union (`lib/types/pattern.ts`), the parser and its two wiring
sites (`lib/parsers/parsers.ts` — `_matchPatternBase` and `_isRhsParser`, both
before the binder / type parsers), lowering (`extractBindings`, `collectChecks`,
`walkPattern`, the arm-value type list), the formatter
(`lib/backends/agencyGenerator.ts`), and the per-node registries
(`lib/utils/topLevel.ts`, `lib/utils/identifierSlots.ts`).

## Limitations

- **Only namespaced effect names.** The parser intercepts a `::`-containing
  name (`namespaceIdentifier`). A bare `foo` in case position stays a
  `variableName` binder, as before — a `::` name can never be a
  variable, so there is no ambiguity. Effects are not required to be
  namespaced, so a **bare-named effect** (`deploy`) has no effect-pattern
  spelling. Handle it with `match(intr.effect)` and string arms. Do not reach
  for a quoted `"deploy"` arm under `match(intr)`: that compares the whole
  interrupt object to a string and never matches.

- **Duplicate effect arms are first-wins**, like duplicate literal arms — the
  first matching arm runs. The #926 `on`-clause handler alias instead rejects a
  duplicate effect at parse time, because that alias is generated code where a
  duplicate is almost certainly a bug. A `match` is ordinary code, where
  first-wins is the language-wide rule.

- **A non-interrupt scrutinee** (`match(5) { std::read => ... }`) surfaces as a
  member-access diagnostic on the lowered `.effect` read — phrased on generated
  code, so it names `.effect` rather than the arm the author wrote. This is the
  same class of edge as the type-pattern edges, and a known v1 limitation.

## Exhaustiveness

An effect pattern pins the `effect` discriminant, so it behaves like the
`{ effect: "app::read" }` object pattern it is sugar for
(`matchExhaustiveness.ts`, `armDiscriminantValue`). What that means depends on
the scrutinee's type:

- Over a real inline handler param, which is re-typed to a discriminated union
  keyed on `effect` (`handlerParamTyping.ts`), effect-pattern arms discriminate
  the union: covering every effect makes the match exhaustive with no `_`, and
  a missing effect is reported by name. A bound arm only covers its member when
  the binding is irrefutable — bare (`app::read`) or pure binders
  (`app::read({ data })`). A value-matching binding
  (`app::read({ data: { path: "p" } })`) matches only some interrupts of that
  effect, so it does not cover the member and a `_` is still required.
- Over an open scrutinee (an `intr: any`, or a param the handler-typing pass
  did not narrow), the match is open/unsupported territory — the checker stays
  silent and requires nothing. Include a `_` there so an expression match does
  not fall through to `undefined`.

An effect-pattern arm never counts as a catch-all; only `_` and a bare binder
do.

## Not covered here

This is the parser/lowering side. The user-facing guide page under
`docs/site/guide/` is the owner's to write; nothing in this PR edits
`docs/site/**`.
