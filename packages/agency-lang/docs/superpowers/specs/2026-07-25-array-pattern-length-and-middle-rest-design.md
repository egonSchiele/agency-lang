# Array patterns: exact length, and a rest binder anywhere

## Status (2026-07-25)

Spec, reviewed and updated — see
[the review](2026-07-25-array-pattern-length-and-middle-rest-design-REVIEW.md).
Ready to implement. Two changes to array patterns that share the same
arithmetic, so they belong in one design even though the first is a bug fix
and the second is a feature.

Came out of the safeBash matcher work, where a bash command's words are an
array and the interesting rules are "a verb, some flags, and a final path".

## Part 1: an array pattern matches any longer array

### The bug

```ts
match (["a", "b", "c"]) {
  ["a", "b"] => "shouldn't match"
  _          => "fell through"
}
// actual: "shouldn't match"
```

Every array pattern is currently a *prefix* match. `["a", "b"]` accepts any
array that starts with `a`, `b` — there is no way to say "exactly these two".

### Cause

`collectChecks` (`lib/lowering/patternLowering.ts:1179`):

```ts
const hasRest = pattern.elements.some((e) => e.type === "restPattern");
const namedCount = pattern.elements.filter((e) => e.type !== "restPattern").length;
const lenAccess = fieldAccess(source, "length", pattern.loc);
const op: Operator = hasRest ? ">=" : ">=";   // <- both branches
checks.push(makeBinOp(lenAccess, op, numberLit(namedCount, pattern.loc), pattern.loc));
```

The ternary computes `hasRest` and then ignores it. The intent is legible
from the shape of the code — the variable exists for no other reason — so
this reads as an unfinished edit rather than a decision.

### Fix

```ts
const op: Operator = hasRest ? ">=" : "==";
```

An array pattern with no rest binder requires an exact length. With a rest
binder it requires at least as many elements as the pattern names.

### Impact

Every construct that routes through `patternToCondition` is affected, not
just match arms: `match` arms, the `is` operator, `while` conditions, and
`match (x is [...])` heads. `if (xs is ["a","b"])` prefix-matches today —
confirmed against a current build.

**Binding position is untouched.** `const [a, b] = xs` goes through
`extractBindings`, which emits no length check at all, so destructuring
cannot change. Part 1 is about matching only.

Parsed all 1258 `.agency` files. Array patterns in those matching
constructs: **15**.

| form | count | meaning changes |
|---|---|---|
| with `...rest` | 2 | no — already `>=` |
| without a rest | 13 | yes |

All 13 are two-element patterns in test files, every one of them matched
against a two-element value, so none changes result. **Zero occurrences in
`stdlib/`.** The change is a behavior change on paper and a no-op in this
repo.

It is silent for anyone relying on the old behavior — code that matched
before may stop matching, with no diagnostic. That is unavoidable (the whole
point is that the pattern now means what it says) and is the reason to do it
before the feature below rather than after, while the blast radius is
provably this small.

## Part 2: `...rest` anywhere in the pattern

### What we want to write

```ts
["echo", a: string, b: string, ...rest, last: string]
["echo", a: string, ...rest, penultimate: string, last: string]
```

A type suffix on the REST binder itself (`...rest: string[]`) is deliberately
not here — it does not parse today and it raises a semantics question the
length arithmetic has no opinion on. Part 3.

Today the rest binder must be last. Anything else throws:

```
Error: rest pattern must be the last element of an array pattern
```

— a raw `throw new Error` from `enforceRestAtEnd` (`lib/parsers/parsers.ts:5846`),
so the user gets a stack trace rather than a diagnostic. That is a bug
regardless of whether we lift the restriction.

### Why this is normal, and why it looked unusual

Languages that match on a **sequence** support a rest in any position.
Languages that match on an **iterator** cannot.

| language | syntax | supported |
|---|---|---|
| Rust | `[first, .., last]` | yes |
| Python | `case [first, *rest, last]` | yes |
| Ruby | `[a, *middle, b]` | yes |
| MoonBit | `[e, .., f]` | yes |
| Scala | `case Seq(a, _*, b)` | yes |
| JavaScript destructuring | `const [a, ...rest, b]` | **SyntaxError** |

JavaScript is the outlier, and it is the one everyone has seen. Its
destructuring consumes an iterator — lazy and single-pass — so it cannot
know where the end is without buffering. That constraint is real for JS and
does not apply here: Agency arrays are JS arrays with `.length`, matched by
index.

So the feature is not exotic. It looks that way from a JavaScript vantage
point.

### Semantics

Adopt PEP 634's rules verbatim, since they are already precise and match
every other language in the table:

1. **At most one** rest binder per array pattern. It may occur in any
   position.
2. The pattern fails if the value's length is less than the number of
   non-rest elements.
3. Leading non-rest elements match from the front, by index.
4. Trailing non-rest elements match from the back, by index from the end.
5. The rest binder takes what is left in between, and binds `[]` when that
   is empty.

Rule 5 makes `...rest` **zero-or-more**, which is what Agency does today
(`["a","b",...rest]` matches `["a","b"]` with `rest = []`) and what every
language in the table does.

Worked against `["a", "b", "c"]`:

| pattern | matches | bindings |
|---|---|---|
| `["a", "b"]` | no | length must equal 2 |
| `["a", "b", ...rest]` | yes | `rest = ["c"]` |
| `["a", ...rest]` | yes | `rest = ["b", "c"]` |
| `["a", ...rest, "c"]` | yes | `rest = ["b"]` |
| `["a", "b", ...rest, "c"]` | yes | `rest = []` |
| `[...rest, "c"]` | yes | `rest = ["a", "b"]` — empty head |
| `[...rest]` | yes | `rest = ["a", "b", "c"]` — empty head and tail |

### No separate one-or-more form

Considered and rejected. It is already expressible with no new syntax:

```ts
["a", ...rest, "c"]         // zero or more between
["a", mid, ...rest, "c"]    // one or more — `mid` is the guaranteed element
```

Adding a second rest sigil would mean new syntax, a decision about what it
binds when empty, and another rule to explain, to say something the existing
form already says. No language in the table has one.

## Part 3: a type suffix on the rest binder

Out of scope for Parts 1 and 2, recorded because the motivating examples
reached for it.

`["echo", ...rest: string[]]` does not parse. `takesTypeSuffix` (#695) admits
`variableName`, `objectPattern`, `arrayPattern` and `wildcardPattern` — not
`restPattern` — so this is a parser change, and it shares nothing with the
length arithmetic that makes Parts 1 and 2 one design.

It also needs a semantics decision the other parts do not:

- **Validate the slice element-wise.** Cost scales with slice length, and a
  named type runs ~370 ns per value (#695's measurements), so a rest of 50
  elements would cost ~19 µs — dominating every number in the performance
  table below.
- **Assert only that the slice is an array.** Always true by construction, so
  the suffix is a no-op and should be rejected rather than silently accepted.

Neither reading is obviously right, which is why it gets its own design pass
rather than a bullet here.

## Lowering

`collectChecks`'s `arrayPattern` case currently assumes every element sits
at a fixed index from zero. The change is to split the element list at the
rest binder and index the two halves from opposite ends.

Given `elements`, `restIndex` (or none), `head = elements.slice(0, restIndex)`
and `tail = elements.slice(restIndex + 1)`:

```ts
// ["a", "b", ...rest, "d", "e"]  against  xs
xs != null && __coarseTypeTest(xs, "array")   // shape check, unchanged
  && xs.length >= 4                           // head.length + tail.length
  && xs[0] === "a"                             // head, indexed from the front
  && xs[1] === "b"
  && xs[xs.length - 2] === "d"                 // tail, indexed from the end
  && xs[xs.length - 1] === "e"
```

Tail element `i` (0-based within `tail`) reads
`xs[xs.length - tail.length + i]`.

Bindings follow the same split. `extractBindings` binds a trailing element
from the end, and the rest binder becomes a two-sided slice:

```ts
const rest = xs.slice(2, xs.length - 2);   // head.length, length - tail.length
```

**Requirement, not a hope:** when `tail` is empty the lowerer must emit the
one-argument form. `sliceCall` (`patternLowering.ts:1413`) is start-only
today, so a two-sided call would produce `xs.slice(2, xs.length - 0)` for
every existing prefix pattern — churning every rest fixture and burying the
interesting diff in noise. Keep the one-argument branch explicitly.

The IR already supports both: `AccessChainElement` is
`{ kind: "slice"; start?; end? }` (`lib/types/access.ts:7`), so the two-sided
slice is an argument to existing machinery, not a new node.

### Binding position gets this too

`const [a, ...rest, b] = xs` is legal. `extractBindings` is the shared path,
so a trailing binder costs the same index-from-the-end there as it does in a
match, and the JavaScript constraint that forbids it — destructuring consumes
an iterator — does not apply to an indexable array.

Part 1 is match-only because binding position emits no length check at all;
Part 2 applies to both, because binding is where the arithmetic lives.

Nesting composes without extra work: a trailing element's own sub-pattern
recurses with `xs[xs.length - n]` as its source, the same way a leading one
recurses with `xs[i]`.

### Errors

**At most one rest binder per array pattern.** Decided, not open.

```ts
["a", ...rest]              // ok
["a", ...rest, "c"]         // ok — Part 2 makes position free
["a", ...x, "b", ...y]      // ERROR: at most one rest binder
```

An error rather than a warning, because there is no sensible fallback: with
two rests nothing decides where the split falls, so any behavior we chose
would be arbitrary. Every language in the table forbids it for the same
reason.

The budget is **per array pattern**, not per arm — nested arrays are separate
patterns and each gets its own:

```ts
["cmd", ...outer, [x, ...inner]]    // legal, one rest each
```

This REPLACES the current rule rather than adding to it. `enforceRestAtEnd`
(`lib/parsers/parsers.ts:5839`) goes from "rest must be the last element" to
"at most one rest": Part 2 removes the position constraint, this keeps the
count constraint. Same function, different job — rename it accordingly.

It also stops being a crash. Today a misplaced rest is a raw
`throw new Error` with a stack trace.

**Where the check lives: pattern lowering, as a `PatternLoweringError`.** Not
the typechecker — lowering runs BEFORE typechecking, so by the time the
checker sees anything the array pattern is already a boolean condition and
there is no pattern left to inspect. That rules out an AG code, since the
diagnostic registry is the typechecker's.

`LoweringError` carries a `loc` (`lib/lowering/loweringError.ts:8`), and
`assertNoBindersInBoolIs` is the precedent: the same class of check —
"this pattern is structurally invalid" — already lives there and produces a
clean compile error rather than a stack trace. Point the `loc` at the second
rest binder.

Scoped to ARRAY patterns. Object patterns take a rest too (`{ a, ...rest }`)
and whether two are currently possible there is unchecked — worth a look
during implementation, but not assumed and not bundled in here.

## Performance

Measured at 2M iterations against a 5-element array, at the level the
lowered condition runs:

Note the exact-length check is not a native comparison. Every equality
operator in Agency routes through the `__eq` helper so null and undefined
compare equal, and `===` is a documented stylistic alias that compiles
identically (`typescriptBuilder.ts:1379`). So `["a","b"]` emits
`__eq(xs.length, 2)` where the rest path emits a native `xs.length >= 2`.
Measured, that costs about 1 ns:

| check | ns/op |
|---|---|
| native `xs.length === 2` (not what we emit) | 1.5 |
| `__eq(xs.length, 2)` — the exact-length path | 5.8 |
| native `xs.length >= 2` — the rest path | 4.7 |

Bypassing the helper would make one generated check the only equality in the
language that skips it, for ~1 ns. Not worth the exception.

| pattern shape | ns/op |
|---|---|
| `["a","b"]` exact | 2.7 |
| `["a","b",...rest]` prefix (today) | 5.0 |
| `["a",...rest,"c"]` one trailing | 5.2 |
| `["a","b",...rest,"d","e"]` two trailing | 5.7 |
| binding `rest` — tail slice `xs.slice(2)` | 20.3 |
| binding `rest` — middle slice `xs.slice(2,-2)` | 19.0 |

A trailing element costs one extra index-from-the-end, about 0.2 ns. The
middle slice is not more expensive than the tail slice — marginally cheaper
here, since it copies fewer elements. There is no performance argument
against this.

## Tests

**Part 1**

- `["a","b"]` does not match `["a","b","c"]`; does match `["a","b"]`.
- `["a","b",...rest]` still matches both, with `rest = ["c"]` and `[]`.
- A nested array pattern gets the same exact-length rule.
- Fixture check: the generated condition uses `==` without a rest and `>=`
  with one.

**Part 2**

- Each row of the semantics table above, as an execution test.
- Bindings: leading, trailing, and the rest slice, asserted by value — a
  trailing element bound from the wrong end still *matches*, so the
  assertion has to check what landed in each binder, not just that the arm
  ran.
- Length boundary: `["a", ...rest, "c"]` against `["a"]` (too short, no
  match) and `["a","c"]` (exactly two, `rest = []`).
- Nesting: a trailing element that is itself a pattern, e.g.
  `["cmd", ...rest, { path: string }]`.
- Type suffixes on trailing elements: `[...rest, last: string]`. (On the rest
  binder itself is Part 3.)
- Empty head: `[...rest, "c"]`, the case most likely to expose an off-by-one
  in the tail arithmetic. And `[...rest]`, where head and tail are both empty.
- Regression: an existing prefix pattern still emits a one-argument
  `slice(start)`, per the Lowering requirement — a fixture check, since the
  behavior is identical and only the generated text would show the churn.
- Two rest binders → the new diagnostic, not a crash. Belongs in
  `tests/agency/expectedCompileError/`.
- The `patternGuards` tripwire keeps passing: the shape check must still
  come first, and the tail reads must be guarded by it.

## Sequencing

Part 1 first, on its own PR. It is three characters plus tests, it is a
behavior change worth isolating in history, and Part 2 builds on the same
length arithmetic — doing it second means building on a base that is known
correct.

Part 1 changes behavior silently: code that matched before may stop matching,
with no diagnostic, by design. A **changelog entry is a deliverable of that
PR**, not an afterthought — it is the only signal a user gets.

Part 3 last, if at all. It is a parser change plus an unmade semantics
decision, and nothing in it depends on Parts 1 or 2.

## Related

- `lib/lowering/patternLowering.ts` — `collectChecks` (the length check and
  element indexing) and `extractBindings` (the slice).
- `lib/parsers/parsers.ts:5839` — `enforceRestAtEnd`.
- `docs/site/guide/pattern-matching.md` — "The rest binder must be the last
  element. You can't have `[a, ...m, b]` for example." Both halves of that
  sentence change.
- [PEP 634](https://peps.python.org/pep-0634/) — the semantics adopted here.
- [Rust slice patterns](https://dev.to/sgchris/the-power-of-slice-patterns-in-rust-4a8g),
  [Ruby pattern matching](https://docs.ruby-lang.org/en/3.4/syntax/pattern_matching_rdoc.html),
  [MoonBit array patterns](https://tour.moonbitlang.com/pattern-matching/array-pattern/index.html).
- [safeBash command-to-tool matching](../ideas/2026-07-24-safebash-command-to-tool-matching.md)
  — the consumer.
