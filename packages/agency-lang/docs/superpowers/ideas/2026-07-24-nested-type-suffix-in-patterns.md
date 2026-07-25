# Allow a `: Type` suffix on a binder nested inside a pattern

## Status (2026-07-25)

**Implemented**, pending review. Wanted by the safeBash matcher, which
would like to say "this word must be a valid path" in the pattern rather
than in the arm body.

The syntax question this doc raised turned out not to exist: the suffix
attaches to a whole PATTERN, never to an object field, so there is no
`{ name: n: string }` form to design. Typing an object is
`{ name: "Ada" }: { name: string }`, which already worked at arm level.
The change is purely where the existing parser is wired.

## The Problem

The bind-and-test form works at the top of an arm:

```ts
match (input) {
  s: string           => s          // ok
  {name, age}: Person => greet(...) // ok
  [x, y]: number[]    => "pair"     // ok
}
```

but not on a binder *inside* an array or object pattern:

```ts
match (words) {
  ["echo", str: string] => print(str)
}
// Failed to parse: expected match cases of the form `value => expression`
```

A parse error, so there is no diagnostic pointing at the real problem —
the whole match block fails to parse and the message describes the block,
not the element.

The workaround is a guard (`["echo", str] if (str is string)`), which
today crashes codegen — see
[the guard lowering bug](2026-07-24-match-arm-guard-is-expression-not-lowered.md).
Once that is fixed the workaround exists, but it splits one idea across
two places and reads worse:

```ts
["cat", p] if (p is SafePath) => read(p)   // workaround
["cat", p: SafePath]          => read(p)   // wanted
```

## Why it matters beyond ergonomics

The suffix is not sugar for a type annotation — for any type that is not
one of the coarse built-ins, it runs the type's full `@validate` chain
(`docs/site/guide/pattern-matching.md`, "What a test checks"). So a
validated type becomes usable as a matching condition:

```ts
@validate(insideProjectRoot)
type SafePath = string

match (cmd.words) {
  ["cat", p: SafePath] => read(p)     // only matches paths that validate
  _                    => fallback()
}
```

That is exactly the shape the safeBash matcher wants: the safety
precondition lives in the pattern, where it cannot be forgotten, instead
of in the arm body, where it can.

## Proposed Behavior

Accept `<pattern>: Type` anywhere a pattern element is accepted — array
elements, object property values, and nested combinations — with the same
semantics the top-level form already has:

1. The test decides whether the arm matches.
2. The binder binds the **original** value, not the validator's
   transformed one (the existing rule, and it should not change here).
3. A type-suffixed element does not satisfy exhaustiveness, same as the
   top-level form.

Two syntax questions for design:

- **Ambiguity with object patterns.** Inside `{ }`, `key: value` already
  means "match this property". So `{ name: n: string }` needs a decision:
  require parens (`{ name: (n: string) }`), or accept the double colon as
  written. The array case (`[a: string]`) has no such conflict.
- **The existing footgun.** `{name: string}` inside an object pattern
  binds a variable *called* `string` (AG5004 warns). If nested suffixes
  land, that warning becomes more important, not less — someone who
  learns `[p: SafePath]` will try `{path: SafePath}` and get a binder.
  Consider whether AG5004 should become an error inside object patterns
  once a correct spelling exists.

## Resolution

`matchPatternParser` now parses a base pattern and then peeks for a
`: Type` suffix, so the suffix is available wherever a pattern appears —
array elements, object property values, any depth. Written as
parse-then-peek rather than as another `or` alternative on purpose: an
alternative that began by parsing a pattern would left-recurse, and even
guarded against that it would re-parse every nested element twice.

`ObjectPatternProperty["value"]` and `ArrayPattern["elements"]` gained
`TypePattern`, which DELETED the three "safe narrowing" casts that were
justified by "nested elements never carry a typePattern". Net removal of
casts, not addition.

Lowering needed no change at all: `collectChecks`'s `typePattern` case
already emitted the test and recursed into the inner pattern.

Two consequences worth knowing:

- A property value is itself a pattern, so `{ name: n: string }` parses
  as "suffix on the binder `n`". Legal but unidiomatic; type the object.
- `_: Type` works nested too, producing the same `pattern: null` node the
  arm-level `wildcardSuffixParser` does.

## Touch Points

- `lib/parsers/parsers.ts` — the pattern-element parsers for array and
  object patterns; the top-level arm parser already handles the suffix
  (`:3274` area handles `is Type =>` arms), so the work is threading the
  same suffix parse into element position.
- `lib/types/pattern.ts` — `typePattern` node already exists; nested use
  may need no new node, only new parse positions.
- `lib/lowering/patternLowering.ts:1078` — `collectChecks`'s `typePattern`
  case already emits the runtime test and recurses into the inner
  pattern, so nested lowering may work unchanged once parsing does.
- `lib/backends/agencyGenerator.ts` — the formatter must print nested
  suffixes back out.
- `lib/typeChecker/typePatterns.ts` / `matchArmNarrowing` — narrowing for
  a nested binder.

## Tests

- `["echo", s: string]` matches a string element, falls through on a
  non-string.
- `["cat", p: SafePath]` where the validator rejects → arm does not match,
  falls through (and the validator ran).
- The bound value is the original, not the transformed one — a repairing
  validator (clamp-style) still binds the un-repaired input.
- A nested suffix inside an object pattern, in whichever spelling design
  picks.
- Exhaustiveness: a match whose only arms use nested type suffixes still
  requires `_`.
- Formatter round-trip: `pnpm run fmt` on a file with nested suffixes is
  a fixpoint.

## Related

- `docs/site/guide/pattern-matching.md` — "Type patterns", which
  currently says the suffix works on "binders, object patterns, array
  patterns"; that is true only at the top of an arm, and the doc should
  say so until this lands.
- `docs/site/guide/type-validation.md` — the `@validate` chain the suffix
  runs.
- [safeBash command-to-tool matching](2026-07-24-safebash-command-to-tool-matching.md)
  — the consumer.
