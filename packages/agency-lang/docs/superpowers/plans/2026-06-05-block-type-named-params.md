# Block-type named params + `->` arrow

## What we're doing

Two related changes to Agency's type-grammar for function-typed values:

1. **Allow param names in block-type params.** Today
   `(any) => any` parses but `(userMsg: string) => string` doesn't — the
   names cause a parse error. After this change, both work; names are
   optional and per-param.
2. **Accept `->` as the arrow for block types.** Today only `=>` is
   recognized. Inline-block lambdas already use `->` (`\x -> x + 1` —
   `lib/parsers/parsers.ts:2660`), so block-type syntax becomes
   `(name: T) -> ret`, matching the lambda. `=>` keeps working as a
   legacy alias for at least one release; the formatter rewrites it to
   `->` on next save (silent migration via `pnpm run fmt`).

## Why this is small

Confirmed by reading `lib/types/typeHints.ts:120-125`:

```ts
export type BlockType = {
  type: "blockType";
  params: { name: string; typeAnnotation: VariableType }[];
  returnType: VariableType;
  tags?: Tag[];
};
```

The AST **already has `name: string`** on each param. The parser just
hard-codes `name: ""` and discards whatever it parsed. Adding name
support is purely additive in the AST — no migration of node shape,
no breaking change to typechecker/codegen consumers.

Confirmed downstream consumers ignore the name field today:
- `lib/preprocessors/typescriptPreprocessor.ts:282` — only reads
  `blockType.params[i].typeAnnotation`
- `lib/backends/typescriptBuilder.ts:1310` — same

So the only places that need to change are:
- The parser (accept names, accept `->`)
- The two formatters that round-trip block types
- The fmt-fixtures that exercise the new arrow

## Out of scope

- Function-type tags `@validate(...)` on individual block params. Not a
  thing today; not adding.
- Replacing `=>` with `->` everywhere in `.agency` files in a single
  commit. Migration happens incrementally via `fmt`.
- Default-valued params in block-types (`(x: number = 0) -> ret`). The
  AST doesn't have a slot for it, and no current Agency stdlib site
  needs it. Defer until someone asks.
- Param destructuring in block-types (`({ a, b }: Foo) -> ret`). Same
  reason.
- Adding a separate `functionType` AST node. `blockType` already
  represents the concept; renaming it for "purity" is busywork and
  would force every consumer to update its discriminator. Keep the
  name `blockType` — it's accurate (inline blocks have this type) and
  the surface syntax `(...) -> ...` doesn't expose the AST tag name
  anyway.

## Question for the user before starting

> Confirm the migration policy: silent `fmt` rewrites `=>` → `->` (no
> deprecation warning), and we update all stdlib + test files in this
> same PR using the formatter. If you want a one-release deprecation
> warning first, say so before I start — that's a different shape of
> change (need to thread a warning channel through the parser).

Working assumption for this plan: silent migration.

## Scope of the surface change

Today, `lib/parsers/parsers.ts:1248-1283` (`blockTypeParser`):

```
( <type>, <type>, ... ) => <returnType>
```

After:

```
( <param>, <param>, ... ) ( -> | => ) <returnType>

<param> ::= <type>                        // legacy, still accepted
         | <name> : <type>                // new
```

So every existing call site (50+ files, confirmed via
`grep -rE '\([^)]*\)\s*=>\s*[A-Za-z\[]' --include="*.agency" -l`)
keeps parsing. The new shapes that start working:

- `(userMsg: string) -> string`
- `(userMsg: string) => string`
- `(string) -> string`

## TDD: tests first

The whole change is parser-shape-and-formatting; nothing about
execution semantics changes. So execution-test coverage is irrelevant —
**all assertions go in `lib/parsers/typeHints.test.ts`**, plus the
formatter snapshot suite.

### `lib/parsers/typeHints.test.ts` additions

Add a `describe("blockTypeParser")` block (or extend the existing
section if present) with every assertion using deep-equal on the AST
shape, not string matching:

| Input | Expected AST shape |
|-------|---------------------|
| `(string) => string` | params: `[{ name: "", typeAnnotation: primitiveType "string" }]`, returnType: primitiveType "string" |
| `(string) -> string` | same, plus optional `arrow: "->"` discriminator (see below) |
| `(userMsg: string) -> string` | params: `[{ name: "userMsg", typeAnnotation: primitiveType "string" }]` |
| `(userMsg: string) => string` | same; the name doesn't depend on arrow choice |
| `(a: string, b: number) -> boolean` | two named params with their types |
| `(string, number) -> boolean` | two unnamed params (`name: ""`) |
| `(a: string, number, c: boolean) -> any` | **mixed named/unnamed** params — must parse |
| `() -> void` | zero params — must parse (regression check; verify current behavior covers this) |
| `(userMsg: string` (no closing paren) | parse error — block-type doesn't swallow trailing input |

**Disambiguation tests** (important — the parser must not greedy-match
`parenthesizedType` and then fail to consume the arrow):

| Input in record-field context | Expected shape |
|-------------------------------|----------------|
| `agent: (string)` | resolves to `parenthesizedType` wrapping `primitiveType "string"`, NOT a block-type missing an arrow |
| `agent: (string) -> string` | resolves to `blockType` with one unnamed param |
| `agent: (userMsg: string)` | parse error — `name: type` outside a block-type / function param is not a valid `parenthesizedType` |

The third case is the subtle one. `parenthesizedType` today parses
`(<type>)`. After adding `name: type` to block-type params, we must
ensure the disambiguation hasn't accidentally made `(name: type)` a
valid parenthesized expression. The cleanest fix: try `blockType`
first (already the case at `parsers.ts:1399`), and only commit to
block-type once we've consumed the arrow.

### Formatter tests

`agencyGenerator` round-trip tests (look under
`tests/integration/cli-main/fixtures/` and the unit tests on the
generator). Add a fixture pair:

```agency
// input
type AgentSpec = {
  agent: (userMsg: string) => string;
  handoff: (string) => void
}

// expected fmt output
type AgentSpec = {
  agent: (userMsg: string) -> string;
  handoff: (string) -> void
}
```

This locks in:
- Names round-trip
- `=>` → `->` migration on fmt
- Single unnamed `(string)` is preserved (not parenthesized away)

## Implementation steps

### Step 1 — Parser: accept names

In `lib/parsers/parsers.ts:1248-1283` (`blockTypeParser`), replace the
unnamed-only param list with a `namedOrUnnamedParam` parser:

```ts
const namedOrUnnamedBlockParam = or(
  // Try named first: ident `:` type
  seqC(
    capture(many1WithJoin(varNameChar), "name"),
    optionalSpaces,
    char(":"),
    optionalSpaces,
    capture(lazy(() => variableTypeParser), "typeAnnotation"),
  ),
  // Fall back to bare type
  map(
    lazy(() => variableTypeParser),
    (t) => ({ name: "", typeAnnotation: t }),
  ),
);
```

Then swap `sepBy(..., variableTypeParser)` for
`sepBy(..., namedOrUnnamedBlockParam)`. The `result.result.paramTypes`
mapping at line 1274 becomes a direct passthrough — no more synthetic
`name: ""`.

Edge case to verify: the lookahead for `name :` must not falsely match
a `typeAliasVariable` followed by `:` in another grammar context. The
named alt is only reached *inside* a `blockType`'s param list, so the
`:` always belongs to the param. No collision.

### Step 2 — Parser: accept `->`

Replace `str("=>")` at line 1265 with `or(str("->"), str("=>"))`. If we
want to remember which arrow was used (for round-tripping legacy `=>`
unchanged instead of auto-migrating), capture it:

```ts
capture(or(str("->"), str("=>")), "arrow"),
```

…and add `arrow?: "->" | "=>"` to `BlockType` in
`lib/types/typeHints.ts:120-125`. **Decision pending user response on
migration policy.** If silent migration is OK, skip the discriminator
and the formatter always emits `->`.

### Step 3 — Formatters

Two files emit block types as strings:

**`lib/utils/formatType.ts:37-40`** (diagnostics / LSP hover / CLI
prompts — already source-level):

```ts
case "blockType": {
  const params = vt.params.map((p) =>
    p.name ? `${p.name}: ${recurse(p.typeAnnotation)}` : recurse(p.typeAnnotation)
  ).join(", ");
  return `(${params}) -> ${recurse(vt.returnType)}`;
}
```

**`lib/backends/typescriptGenerator/typeToString.ts:146-151`** —
double-duty function (`forFormatting` boolean already exists). Branch
on it:

```ts
} else if (variableType.type === "blockType") {
  const arrow = forFormatting ? "->" : "=>";
  const params = variableType.params
    .map((p) => {
      const t = variableTypeToString(p.typeAnnotation, typeAliases, forFormatting);
      return forFormatting && p.name ? `${p.name}: ${t}` : t;
    })
    .join(", ");
  const ret = variableTypeToString(variableType.returnType, typeAliases, forFormatting);
  return `(${params}) ${arrow} ${ret}`;
}
```

The `forFormatting: false` (TS codegen) path stays at `=>` and drops
names — that's what TypeScript's syntax wants for function types.

Wait — TS *does* accept names: `(userMsg: string) => string` is valid
TS. So we *can* keep names on the codegen path too, and it might even
improve generated-code readability. **Decision:** drop names on TS
codegen for now (least-change), since downstream `typescriptBuilder.ts`
already strips them and adding them here would require checking those
sites don't double up. If LSP authors want named TS output later, flip
that flag — but it's not necessary for the user's request.

### Step 4 — Migration

Run `pnpm run fmt` on every `.agency` file that currently uses `(...)
=> ...` for a block type. Confirmed scope: 50 files, mostly in
`stdlib/` and `tests/agency/blocks/`. The formatter rewrites `=>` to
`->`. Commit the migration in a **separate commit** so the diff is
reviewable. (Same PR, two commits: "Parser: accept named block-type
params + `->` arrow", then "fmt: migrate block-type arrows to `->`".)

Two files explicitly to NOT touch:
- `tests/integration/cli-main/fixtures/expected/fmt.expected.agency` —
  this fixture asserts current fmt output. Update it as part of the
  same PR with the matching `fmt-input.agency` showing legacy `=>`
  rewritten to `->`. (Locks in the migration behavior.)
- `stdlib/agent.agency:139` — the `AgentSpec` definition the user
  flagged. Fix it the same way (`(userMsg: string) -> string`) and
  rebuild `stdlib/agent.js`.

### Step 5 — Rebuild stdlib

`make` rebuilds every `.agency` under `stdlib/` to `.js`. The current
`stdlib/agent.js` has a stale `AgentSpec` that's a copy of `PromptSpec`
(no `agent` field). After the parser fix, rebuild and inspect
`stdlib/agent.js`'s `AgentSpec` definition manually to confirm the new
shape lands.

### Step 6 — Re-verify end-to-end

Drop a probe file:

```agency
type Spec = {
  agent: (userMsg: string) -> string
}

def greet(name: string): string {
  return "hello ${name}"
}

node main(): string {
  const s: Spec = { agent: greet }
  return s.agent("world")
}
```

Run via `pnpm run agency probe.agency`. Confirm: compiles, runs,
prints `"hello world"`. Then delete the probe.

Also re-verify the original slash-commands work end-to-end:
`pnpm run agency test tests/agency/commands-dir.agency`. Should still
be 25/25.

## What NOT to do

- Don't introduce a new `functionType` AST node. `blockType` is the
  existing one and it already supports everything we need after this
  change.
- Don't try to support `(name: type = default) -> ret`. AST doesn't
  have a slot; not asked for.
- Don't add a deprecation warning for `=>` unless the user explicitly
  asks. (See "Question for the user" above.)
- Don't break the parsing of `(any) => any` or `(string) => string` —
  legacy must keep working until the migration commit lands, and after
  too. The arrow change is additive.
- Don't change `parenthesizedTypeParser`. The disambiguation works by
  trying `blockType` first; we just need to be sure the new "named
  param" alt doesn't bleed into `parenthesizedType`.
- Don't update PRs that touch unrelated `.agency` files purely to
  migrate `=>` to `->`. That makes review impossible. The migration
  commit is its own thing.

## Risk register

- **Parse ambiguity with `parenthesizedType`.** `(string)` is a
  parenthesized type today. After the change, `(name: string)` is
  almost certainly going to look like a named block-type param without
  the arrow following — which means a parse error on `(name: string)`
  outside a block-type. That's the correct outcome (it was always
  invalid syntax), but worth a test (`disambiguation test #3` above).
- **`arrow` AST discriminator regret.** If we add `arrow?: "->" | "=>"`
  and later want to drop legacy `=>` entirely, removing the
  discriminator is a breaking AST change. Mitigation: don't add it at
  all unless the user says they want to preserve user-typed arrows in
  fmt output. Default to silent migration.
- **Stdlib build skew.** `stdlib/agent.js` is currently out of sync
  with its `.agency` source. After this change, `make` must rebuild it
  cleanly. Verify with `git status` showing `stdlib/agent.js` modified
  after `make`.
- **Codegen accidentally emits `->` in TypeScript.** TS doesn't accept
  it. The `forFormatting` branch in `typeToString.ts` is the only
  guard. Add a TS codegen test (one already exists for `blockType` —
  extend it with `forFormatting: false` and assert the output contains
  `=>`).

## Expected line counts

| File | Lines changed |
|------|---------------|
| `lib/parsers/parsers.ts` | ~25 (new param parser, swap sepBy arg, accept `->`) |
| `lib/utils/formatType.ts` | ~5 |
| `lib/backends/typescriptGenerator/typeToString.ts` | ~10 |
| `lib/parsers/typeHints.test.ts` | ~80 (10 new assertions) |
| Formatter fixture pair | ~15 |
| `stdlib/agent.agency` | 1-line fix |
| stdlib + tests migration (separate commit) | mechanical, ~50 files, 1 line each |

Total hand-written code: under 150 lines. Migration commit: large
diff but mechanical.

## Checklist

- [ ] User confirms migration policy (silent vs deprecation warning)
- [ ] Add typeHints parser tests for: named params, `->` arrow,
      mixed named/unnamed, disambiguation against `parenthesizedType`
- [ ] Add formatter fixture pair locking in `=>` → `->` migration
- [ ] Extend the `blockType` codegen test to assert `=>` stays in
      TypeScript output
- [ ] Confirm all new tests are red
- [ ] Implement parser change (Step 1 + Step 2)
- [ ] Implement formatter change (Step 3)
- [ ] All new tests green; existing `typeHints.test.ts` still green
- [ ] Fix `stdlib/agent.agency:139` by hand
- [ ] Run `pnpm run fmt` on every `.agency` file with `(...) => ...`
      (50 files; commit separately)
- [ ] `make` clean; confirm `stdlib/agent.js`'s `AgentSpec` shape is
      no longer a copy of `PromptSpec`
- [ ] Smoke-test via probe (Step 6); delete probe
- [ ] Confirm `commands-dir` tests still 25/25
- [ ] `pnpm run lint:structure` clean
- [ ] Open PR with two commits: parser change, then fmt migration
