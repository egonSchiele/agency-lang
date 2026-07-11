# Intersection Types (`&`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (owner preference: inline execution in the main session, NOT subagent-driven). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `&` intersection operator per the approved spec `docs/superpowers/specs/2026-07-10-intersection-types-design.md`. This closes the type-system feature roadmap.

**Architecture:** One new n-ary `intersectionType` variant that exists only between parse and resolution. The parser gains one precedence level between the union parser and its items (`&` binds tighter than `|`, looser than postfix/keyof). `evalIntersection` joins the operators in `lib/typeChecker/typeOperators.ts`, merging object types left to right with recursive shared-key intersection. The fan-out follows `docs/dev/adding-features.md` exactly.

**Verified facts:**
- `unionTypeParser` = `sepBy(pipe, unionItemParser)` with a ≥2-member check; `pipe` = `seqR(optionalSpacesOrNewline, str("|"), optionalSpacesOrNewline)`. The intersection level slots in by making `unionItemParser` an intersection EXPRESSION whose items are the old alternatives.
- `variableTypeParser`'s or-chain: `blockTypeParser, unionTypeParser, keyofTypeParser, arrayTypeParser, ...`. A bare `A & B` (no `|`) fails `unionTypeParser` (one member), so `intersectionTypeParser` must ALSO appear in `variableTypeParser`, right after `unionTypeParser`. Its single-member passthrough then subsumes the later alternatives; they stay in the chain as harmless dead code (zero-risk minimal change; note it in a comment).
- `typeOperators.ts` already consumes `resolveObjectArg` from `builtinGenerics.ts`; `mergeTagSets` (`lib/typeChecker/mergeTags.ts`) imports only types — no cycle. `typeKey` is NOT imported into `typeOperators.ts` (review finding: it transitively pulls in assignability, violating the file's CYCLE RULE comment). Instead, shared-key equality arrives as an INJECTED comparator, exactly like `resolve` — and the caller in assignability.ts builds it on the REAL alias table, which is strictly better than the empty-table workaround the injection replaces.
- Shared-key equality semantics: the comparator compares RESOLVED values by `typeKey(x, typeAliases)`. Top-level aliases are already resolved by the `resolve` callback, so `Age & number` compares structurally; NESTED alias refs compare nominally (same ref = equal), the family's documented stance.
- `ObjectProperty.description` is a separate field from tags: the shared-key survivor keeps the LEFT side's description; `mergeTagSets` handles tag-level description concatenation on its own.
- `schemaExpressionParser` takes the full `variableTypeParser`, so `schema(Named & Aged)` parses once the level exists.
- The compiler-enforced fan-out is `typeKey` + `valueParamSubstitution` (never-defaults). Hand-maintained: `mapTypes`/`visitTypes`, both printers, `hasAnyValidateTag`, `deepResolveNode` (the trap; red-first non-string pin required).

## Global Constraints

- Fresh worktree: `git worktree add .claude/worktrees/intersection -b intersection origin/main`, then `cd .claude/worktrees/intersection && pnpm install && cd packages/agency-lang && make`.
- Never commit to `main`. No apostrophes in commit-message command lines. Save test output to files. Run `make` before CLI steps. Do NOT run the full agency suite locally.
- Zero churn in existing `tests/typescriptGenerator` fixtures is a hard gate.
- Object-only operands in v1; `never` operands ERROR (deliberate TS divergence, documented).
- No user-facing guide edits (owner decision from the keyof PR).
- If `make` regenerates unrelated stdlib docs (`usaspending.md` drift), revert them before committing.

---

### Task 1: Variant + parser level + printers + fan-out

**Files:**
- Modify: `lib/types/typeHints.ts` (variant)
- Modify: `lib/parsers/parsers.ts` (intersection level)
- Modify: `lib/utils/formatType.ts`, `lib/backends/typescriptGenerator/typeToString.ts` (printing + union-member parens)
- Modify: `lib/typeChecker/typeKey.ts`, `lib/typeChecker/valueParamSubstitution.ts`, `lib/typeChecker/typeWalker.ts` (fan-out)
- Test: `lib/parsers/intersectionParsing.test.ts` (new), `lib/backends/agencyGenerator.test.ts` (round-trips)

**Interfaces produced:**

```ts
export type IntersectionType = {
  type: "intersectionType";
  types: VariableType[];
  tags?: Tag[];
};
```

- [ ] **Step 1: Write the failing parse tests**

Create `lib/parsers/intersectionParsing.test.ts` (reuse the `firstParamHint` helper shape from `typeOperatorParsing.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { parseAgency } from "../parser.js";

function firstParamHint(source: string): unknown {
  const parsed = parseAgency(source, {}, false);
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error("unreachable");
  const def = parsed.result.nodes.find((n) => n.type === "function") as {
    parameters: { typeHint?: unknown }[];
  };
  return def.parameters[0].typeHint;
}

describe("intersection parsing", () => {
  it("parses a two-member intersection", () => {
    expect(firstParamHint("def f(x: A & B) { x }")).toMatchObject({
      type: "intersectionType",
      types: [{ aliasName: "A" }, { aliasName: "B" }],
    });
  });

  it("is n-ary: A & B & C is one flat node", () => {
    expect(firstParamHint("def f(x: A & B & C) { x }")).toMatchObject({
      type: "intersectionType",
      types: [{ aliasName: "A" }, { aliasName: "B" }, { aliasName: "C" }],
    });
  });

  it("binds tighter than union: A & B | C is (A & B) | C", () => {
    expect(firstParamHint("def f(x: A & B | C) { x }")).toMatchObject({
      type: "unionType",
      types: [
        { type: "intersectionType" },
        { type: "typeAliasVariable", aliasName: "C" },
      ],
    });
  });

  it("binds tighter than union on the right too: A | B & C", () => {
    expect(firstParamHint("def f(x: A | B & C) { x }")).toMatchObject({
      type: "unionType",
      types: [
        { type: "typeAliasVariable", aliasName: "A" },
        { type: "intersectionType" },
      ],
    });
  });

  it("keyof binds tighter: keyof A & B is (keyof A) & B", () => {
    expect(firstParamHint("def f(x: keyof A & B) { x }")).toMatchObject({
      type: "intersectionType",
      types: [{ type: "keyofType" }, { aliasName: "B" }],
    });
  });

  it("postfix binds tighter: A[] & B intersects the array", () => {
    expect(firstParamHint("def f(x: A[] & B) { x }")).toMatchObject({
      type: "intersectionType",
      types: [{ type: "arrayType" }, { aliasName: "B" }],
    });
  });

  it("parenthesized union as an operand: (A | B) & C", () => {
    expect(firstParamHint("def f(x: (A | B) & C) { x }")).toMatchObject({
      type: "intersectionType",
      types: [{ type: "unionType" }, { aliasName: "C" }],
    });
  });

  it("a single member passes through with no intersection node", () => {
    expect(firstParamHint("def f(x: A) { x }")).toMatchObject({
      type: "typeAliasVariable",
      aliasName: "A",
    });
  });

  it("tolerates newlines around the ampersand, like union pipes", () => {
    expect(
      firstParamHint("def f(x: A &\n  B) { x }"),
    ).toMatchObject({ type: "intersectionType" });
  });
});
```

- [ ] **Step 2: Run to verify red**

```bash
pnpm test:run lib/parsers/intersectionParsing.test.ts > /tmp/ix-task1-red.log 2>&1; tail -5 /tmp/ix-task1-red.log
```

Expected: intersection tests FAIL; the single-member passthrough test PASSES (pins existing behavior).

- [ ] **Step 3: Add the variant**

In `lib/types/typeHints.ts`: add `IntersectionType` (code above, with a doc comment noting parse-to-resolution lifecycle like its neighbors) BELOW `TypeParam` (keeping docstrings attached to their declarations — the keyof review lesson), and add it to the `VariableType` union.

- [ ] **Step 4: The parser level**

In `lib/parsers/parsers.ts`:

1. Rename the current `unionItemParser` or-chain to `intersectionItemParser`, keeping ALL current members verbatim and in order — including `lazy(() => blockTypeParser)` as the FIRST alternative (review catch: an enumerated list that omits it silently drops function types from unions and intersections).
2. Add the level:

```ts
const ampersand = seqR(
  optionalSpacesOrNewline,
  str("&"),
  optionalSpacesOrNewline,
);

/**
 * One precedence level below union items: `&` binds tighter than `|`
 * and looser than postfix and keyof (all TS parity). A single member
 * passes through unchanged — no node — so this parser is safe as a
 * general alternative in variableTypeParser.
 */
export const intersectionTypeParser: Parser<VariableType> = map(
  sepBy1(ampersand, intersectionItemParser),
  (members): VariableType =>
    members.length === 1
      ? members[0]
      : { type: "intersectionType", types: members },
);

// Union items are intersection EXPRESSIONS: this is what makes
// `A & B | C` parse as (A & B) | C.
export const unionItemParser: Parser<VariableType> = memo(
  "unionItemParser",
  intersectionTypeParser,
);
```

3. In `variableTypeParser`, insert `intersectionTypeParser` immediately AFTER `unionTypeParser` (a bare `A & B` has one union member, so the union parser fails and this alternative catches it). Add a comment noting the alternatives after it are now subsumed by the single-member passthrough and kept only to avoid churn.

Adapt to the file's actual shapes (`sepBy1` argument order, `map` availability — both confirmed present). If `unionItemParser`'s `memo` name is referenced elsewhere, keep the exported name stable as shown.

- [ ] **Step 5: Printers + fan-out**

- `formatTypeHint` (`lib/utils/formatType.ts`):

```ts
    case "intersectionType":
      // A union member needs parens (`(A | B) & C`) because & binds
      // tighter; an intersection inside a union needs none for the same
      // reason.
      return vt.types
        .map((m) => (m.type === "unionType" ? `(${recurse(m)})` : recurse(m)))
        .join(" & ");
```

  AND (review blocking finding): extend the three EXISTING paren
  conditions, because `&` binds looser than postfix/keyof, so an
  intersection can only appear under them via explicit parens that the
  printers must restore:
  - `arrayType` case: parenthesize `intersectionType` elements (alongside
    the existing `keyofType`/`unionType` checks) — `(A & B)[]` must not
    print as `A & B[]`.
  - `keyofType` case: parenthesize `intersectionType` operands —
    `keyof (A & B)` must not print as `keyof A & B`.
  - `indexedAccessType` case: parenthesize `intersectionType` objects —
    `(A & B)["id"]` must not print as `A & B["id"]`.

  NOTE: `formatType.ts` ends in a THROWING default, not a never-typed
  one — tsc will not flag these; only the round-trip tests below do.

- `variableTypeToString` (`typeToString.ts`): same rules (the new case
  and all three existing-case extensions), same comments, in its
  else-if style.
- `typeKey` `canonical()`: `` case "intersectionType": return `{"intersect":[${t.types.map(canonical).sort().join(",")}]}`; `` (members sorted — intersection is commutative).
- `valueParamSubstitution` (both switches): recurse/rebuild over `t.types`, mirroring the `unionType` cases.
- `mapTypes` AND `visitTypes` (`typeWalker.ts`): mirror the `unionType` cases; update both, per the pairing rule.

- [ ] **Step 6: Build, then green + round-trips**

```bash
make > /tmp/ix-task1-make.log 2>&1; grep -E "error TS" /tmp/ix-task1-make.log | head -10
```

Fix anything tsc reports beyond the sites above. Then:

```bash
pnpm test:run lib/parsers/intersectionParsing.test.ts > /tmp/ix-task1-green.log 2>&1; tail -3 /tmp/ix-task1-green.log
```

Append round-trip cases to `lib/backends/agencyGenerator.test.ts` (after the keyof cases):

```ts
      {
        description: "intersection round-trips",
        input: "def f(x: A & B) { x }",
        expectedOutput: "def f(x: A & B) {\nx\n}",
      },
      {
        description: "intersection inside a union round-trips without parens",
        input: "def f(x: A & B | C) { x }",
        expectedOutput: "def f(x: A & B | C) {\nx\n}",
      },
      {
        description: "union operand keeps its parens under intersection",
        input: "def f(x: (A | B) & C) { x }",
        expectedOutput: "def f(x: (A | B) & C) {\nx\n}",
      },
      {
        description: "intersection operand keeps parens under keyof",
        input: "def f(x: keyof (A & B)) { x }",
        expectedOutput: "def f(x: keyof (A & B)) {\nx\n}",
      },
      {
        description: "intersection element keeps parens under array suffix",
        input: "def f(x: (A & B)[]) { x }",
        expectedOutput: "def f(x: (A & B)[]) {\nx\n}",
      },
      {
        description: "intersection object keeps parens under indexed access",
        input: 'def f(x: (A & B)["id"]) { x }',
        expectedOutput: 'def f(x: (A & B)["id"]) {\nx\n}',
      },
```

Plus an alias-position round-trip (standalone test in the Type-preservation describe, like keyof's): `type Person = Named & Aged` generates output containing `Named & Aged`.

```bash
pnpm test:run lib/backends/agencyGenerator.test.ts > /tmp/ix-task1-fmt.log 2>&1; tail -3 /tmp/ix-task1-fmt.log
pnpm test:run lib > /tmp/ix-task1-lib.log 2>&1; tail -3 /tmp/ix-task1-lib.log
pnpm run lint:structure > /tmp/ix-task1-lint.log 2>&1; tail -2 /tmp/ix-task1-lint.log
```

The full-lib run guards the union-item restructure (it sits under every union annotation).

- [ ] **Step 6b: Parse-performance gate (owner concern)**

The new level runs on every union item, so measure it. The expected
cost is one failed `&` probe per item (sepBy ends its loop on a failed
separator probe — no backtracking into items), but record numbers, not
expectations:

```bash
for f in stdlib/ui.agency stdlib/policy.agency; do
  for i in 1 2 3; do
    /usr/bin/time -p pnpm run ast $f > /dev/null 2>> /tmp/ix-parse-bench.log
  done
done
grep real /tmp/ix-parse-bench.log
```

Run the same loop on a clean `origin/main` checkout (the main repo
checkout works) and compare medians. Budget: stop and investigate past
a ~5% regression on either file — the likely culprit would be memo
boundary changes, not the sepBy probe. Record both medians in the
Task 1 commit message.

- [ ] **Step 7: Commit**

```bash
git add lib/types/typeHints.ts lib/parsers/parsers.ts lib/parsers/intersectionParsing.test.ts lib/utils/formatType.ts lib/backends/typescriptGenerator/typeToString.ts lib/backends/agencyGenerator.test.ts lib/typeChecker/typeKey.ts lib/typeChecker/valueParamSubstitution.ts lib/typeChecker/typeWalker.ts
git commit -m "Add intersectionType variant with a parser precedence level and printers"
```

---

### Task 2: evalIntersection — a declarative merge pipeline

**Files:**
- Modify: `lib/typeChecker/typeOperators.ts` (add `evalIntersection` + helpers)
- Test: `lib/typeChecker/typeOperators.test.ts` (extend)
- Modify: `lib/typeChecker/assignability.ts` (resolver branch, builds the comparator)

**Interfaces:**
- `evalIntersection(members: VariableType[], resolve: Resolve, typesEqual: TypeEquals): VariableType` — every member must resolve to an object type; throws `TypeError` on non-object operands and shared-key conflicts.
- `type TypeEquals = (a: VariableType, b: VariableType) => boolean` — injected structural-identity comparator, keeping `typeOperators.ts` free of the assignability import per its CYCLE RULE (review finding 3). The resolver branch passes `(a, b) => typeKey(a, typeAliases) === typeKey(b, typeAliases)`.

**The design (owner readability requirement):** the merge reads as four
named steps, each its own small function, with the imperative content
confined to one group-by:

```
RESOLVE  every operand to an object type        (evalIntersection)
GROUP    all properties across operands by key  (groupPropertiesByKey)
COMBINE  each key group into one property       (combineGroup + the
                                                 three-rule ladder in
                                                 intersectPropertyValues)
BUILD    an ordinary object type                (mergeObjects)
```

Group-by makes the shared-key rule local and visible (no index
arithmetic), n-ary merging and associativity hold BY CONSTRUCTION (all
operands group in one pass — there is no pairwise fold at the top), and
the three shared-key rules sit in one ladder, one rule per line.

- [ ] **Step 1: Write the failing unit tests**

At the top of `lib/typeChecker/typeOperators.test.ts`, extend the
EXISTING imports (review note: `typecheckSource` is already imported;
`evalIntersection` joins the existing typeOperators import; only
`typeKey` is a new import line, used to build the test comparator):

```ts
import { evalKeyof, evalIndexedAccess, evalIntersection } from "./typeOperators.js";
import { typeKey } from "./typeKey.js";
```

Test comparator helper, next to `id`:

```ts
const eq = (a: VariableType, b: VariableType) =>
  typeKey(a, {}) === typeKey(b, {});
```

Then append:

```ts
describe("evalIntersection", () => {
  const NAME_TAG = { type: "tag" as const, name: "validate", arguments: [] };

  function named(): VariableType {
    return {
      type: "objectType",
      properties: [
        { key: "id", value: STR },
        { key: "name", value: STR, tags: [NAME_TAG] },
      ],
    };
  }

  function aged(): VariableType {
    return {
      type: "objectType",
      properties: [
        { key: "id", value: STR },
        { key: "age", value: NUM },
      ],
    };
  }

  it("merges disjoint keys in first-seen order", () => {
    const out = evalIntersection([named(), aged()], id, eq);
    expect(out).toMatchObject({
      type: "objectType",
      properties: [{ key: "id" }, { key: "name" }, { key: "age" }],
    });
  });

  it("an identical shared key keeps one copy (non-object types included)", () => {
    const out = evalIntersection([named(), aged()], id, eq) as {
      properties: { key: string }[];
    };
    expect(out.properties.filter((p) => p.key === "id")).toHaveLength(1);
  });

  it("shared object-typed keys merge RECURSIVELY (nested level asserted)", () => {
    const a: VariableType = {
      type: "objectType",
      properties: [
        {
          key: "config",
          value: {
            type: "objectType",
            properties: [{ key: "host", value: STR }],
          },
        },
      ],
    };
    const b: VariableType = {
      type: "objectType",
      properties: [
        {
          key: "config",
          value: {
            type: "objectType",
            properties: [{ key: "port", value: NUM }],
          },
        },
      ],
    };
    expect(evalIntersection([a, b], id, eq)).toEqual({
      type: "objectType",
      properties: [
        {
          key: "config",
          value: {
            type: "objectType",
            properties: [
              { key: "host", value: STR },
              { key: "port", value: NUM },
            ],
          },
        },
      ],
    });
  });

  it("a conflicting shared key errors, naming the key and both types", () => {
    const a: VariableType = {
      type: "objectType",
      properties: [{ key: "id", value: STR }],
    };
    const b: VariableType = {
      type: "objectType",
      properties: [{ key: "id", value: NUM }],
    };
    expect(() => evalIntersection([a, b], id, eq)).toThrow(
      /cannot intersect key 'id'.*string.*number/,
    );
  });

  it("shared-key tags merge: BOTH validate chains survive", () => {
    const a: VariableType = {
      type: "objectType",
      properties: [{ key: "id", value: STR, tags: [NAME_TAG] }],
    };
    const otherTag = { type: "tag" as const, name: "validate", arguments: [] };
    const b: VariableType = {
      type: "objectType",
      properties: [{ key: "id", value: STR, tags: [otherTag] }],
    };
    const out = evalIntersection([a, b], id, eq) as {
      properties: { tags?: { name: string }[] }[];
    };
    // mergeTagSets collapses stacked @validate tags into ONE combined
    // tag; assert a validate tag survives rather than counting tags.
    expect(out.properties[0].tags?.some((t) => t.name === "validate")).toBe(
      true,
    );
  });

  it("three-way merge groups ALL operands at once", () => {
    const c: VariableType = {
      type: "objectType",
      properties: [{ key: "extra", value: STR }],
    };
    const out = evalIntersection([named(), aged(), c], id, eq);
    expect(out).toMatchObject({
      properties: [
        { key: "id" },
        { key: "name" },
        { key: "age" },
        { key: "extra" },
      ],
    });
  });

  it("rejects every non-object operand, including never", () => {
    expect(() => evalIntersection([named(), NUM], id, eq)).toThrow(
      /intersection expects an object type/,
    );
    expect(() =>
      evalIntersection(
        [named(), { type: "primitiveType", value: "never" }],
        id,
        eq,
      ),
    ).toThrow(/intersection expects an object type/);
    const rec: VariableType = {
      type: "genericType",
      name: "Record",
      typeArgs: [STR, NUM],
    };
    expect(() => evalIntersection([named(), rec], id, eq)).toThrow(
      /intersection expects an object type/,
    );
  });

  it("does not mutate its inputs", () => {
    const a = named();
    const snapshot = JSON.parse(JSON.stringify(a));
    evalIntersection([a, aged()], id, eq);
    expect(a).toEqual(snapshot);
  });

  it("is associative on RESOLVED results (compared by typeKey)", () => {
    const extra: VariableType = {
      type: "objectType",
      properties: [{ key: "extra", value: STR }],
    };
    const resolve = (t: VariableType): VariableType =>
      t.type === "intersectionType"
        ? evalIntersection(t.types, resolve, eq)
        : t;
    const leftNested = evalIntersection(
      [{ type: "intersectionType", types: [named(), aged()] }, extra],
      resolve,
      eq,
    );
    const rightNested = evalIntersection(
      [named(), { type: "intersectionType", types: [aged(), extra] }],
      resolve,
      eq,
    );
    expect(typeKey(leftNested, {})).toBe(typeKey(rightNested, {}));
  });
});
```

- [ ] **Step 2: Red, then implement the pipeline**

```bash
pnpm test:run lib/typeChecker/typeOperators.test.ts > /tmp/ix-task2-red.log 2>&1; tail -3 /tmp/ix-task2-red.log
```

Extend `lib/typeChecker/typeOperators.ts`. New imports merged into the
existing lines: `ObjectProperty`, `ObjectType` (types), `mergeTagSets`,
`formatTypeHint`. NO `typeKey` import — the comparator is injected,
which is what keeps the file's CYCLE RULE true.

```ts
/** Injected structural-identity comparator — see the CYCLE RULE above:
 *  typeKey lives behind assignability, so the caller provides equality
 *  the same way it provides `resolve`. */
export type TypeEquals = (a: VariableType, b: VariableType) => boolean;

/**
 * `A & B & ...` — merge object types. Four steps:
 *
 *   RESOLVE  every operand to an object type
 *   GROUP    all properties across all operands by key,
 *            in first-seen key order
 *   COMBINE  each key group into one property (the shared-key
 *            rules live in intersectPropertyValues)
 *   BUILD    an ordinary object type
 *
 * Grouping ALL operands at once (rather than folding pairwise) is what
 * makes the merge n-ary and associative by construction.
 */
export function evalIntersection(
  members: VariableType[],
  resolve: Resolve,
  typesEqual: TypeEquals,
): VariableType {
  const objects = members.map((m) =>
    resolveObjectArg("intersection", m, resolve),
  );
  return mergeObjects(objects, resolve, typesEqual);
}

function mergeObjects(
  objects: ObjectType[],
  resolve: Resolve,
  typesEqual: TypeEquals,
): ObjectType {
  const groups = groupPropertiesByKey(objects);
  const properties = groups.map((group) =>
    combineGroup(group, resolve, typesEqual),
  );
  return { type: "objectType", properties };
}

/**
 * Every declaration of every key, grouped, in first-seen key order.
 * A disjoint key produces a one-element group; a shared key produces
 * one group holding each side's declaration.
 */
function groupPropertiesByKey(objects: ObjectType[]): ObjectProperty[][] {
  const keyOrder: string[] = [];
  // Null-prototype dict: keys are user-controlled property names, so
  // "__proto__"/"toString" must not collide with Object.prototype
  // (the scope.ts discipline).
  const byKey: Record<string, ObjectProperty[]> = Object.create(null);
  for (const obj of objects) {
    for (const prop of obj.properties) {
      if (byKey[prop.key] === undefined) {
        byKey[prop.key] = [];
        keyOrder.push(prop.key);
      }
      byKey[prop.key].push(prop);
    }
  }
  return keyOrder.map((key) => byKey[key]);
}

/**
 * Fold a key group into one property. A one-element group returns its
 * property untouched (reduce with no initial value). A shared key
 * intersects the value types and merges the tags — a value of `A & B`
 * must satisfy BOTH sides, so both validate chains apply. The LEFT
 * declaration keeps its description (the spread).
 */
function combineGroup(
  group: ObjectProperty[],
  resolve: Resolve,
  typesEqual: TypeEquals,
): ObjectProperty {
  return group.reduce((left, right) => ({
    ...left,
    value: intersectPropertyValues(
      left.key,
      left.value,
      right.value,
      resolve,
      typesEqual,
    ),
    tags: mergeTagSets(left.tags, right.tags),
  }));
}

/**
 * The three shared-key rules, in order:
 *
 *   identical types   -> keep one copy
 *   two object types  -> merge recursively (same pipeline)
 *   anything else     -> no overlap; error naming the key
 */
function intersectPropertyValues(
  key: string,
  leftValue: VariableType,
  rightValue: VariableType,
  resolve: Resolve,
  typesEqual: TypeEquals,
): VariableType {
  const left = resolve(leftValue);
  const right = resolve(rightValue);
  if (typesEqual(left, right)) return left;
  if (left.type === "objectType" && right.type === "objectType") {
    return mergeObjects([left, right], resolve, typesEqual);
  }
  throw new TypeError(
    `cannot intersect key '${key}': '${formatTypeHint(left)}' and '${formatTypeHint(right)}' have no overlap`,
  );
}
```

- [ ] **Step 3: Wire the resolver (comparator built on the real alias table)**

In `resolveTypeWithGuard` (`assignability.ts`), beside the keyof/indexed
branches — assignability already imports `typeKey`, so the comparator
costs one lambda:

```ts
  if (vt.type === "intersectionType") {
    return withUseSiteTags(
      evalIntersection(
        vt.types,
        (t) => resolveTypeWithGuard(t, typeAliases, inProgress),
        (a, b) => typeKey(a, typeAliases) === typeKey(b, typeAliases),
      ),
      vt.tags,
    );
  }
```

- [ ] **Step 4: Pipeline tests**

Append to the pipeline describe in `typeOperators.test.ts`:

```ts
  it("accepts a complete value against a merged type, rejects a partial one", () => {
    const ok = typecheckSource(`
type Named = { id: string, name: string }
type Aged = { id: string, age: number }
node main() {
  const p: Named & Aged = { id: "1", name: "a", age: 3 }
  return p
}
`);
    expect(ok).toEqual([]);
    const bad = typecheckSource(`
type Named = { id: string, name: string }
type Aged = { id: string, age: number }
node main() {
  const p: Named & Aged = { id: "1", name: "a" }
  return p
}
`);
    expect(bad.map((e) => e.message).join("\n")).toMatch(/not assignable/);
  });

  it("composes: Partial of a merge, keyof of a merge, index into a merge", () => {
    const errors = typecheckSource(`
type Named = { id: string, name: string }
type Aged = { id: string, age: number }
node main() {
  const a: Partial<Named & Aged> = { id: null, name: null, age: null }
  const k: keyof (Named & Aged) = "age"
  const n: (Named & Aged)["age"] = 3
  return k
}
`);
    expect(errors).toEqual([]);
  });

  it("a generic alias can delegate: type Mix<T> = T & Stamp", () => {
    const errors = typecheckSource(`
type Stamp = { createdAt: string }
type Named = { name: string }
type Mix<T> = T & Stamp
node main() {
  const m: Mix<Named> = { name: "a", createdAt: "now" }
  return m
}
`);
    expect(errors).toEqual([]);
  });

  it("a recursive alias can be an operand (nominal self-refs survive)", () => {
    const errors = typecheckSource(`
type Tree = { value: number, children: Tree[] }
node main() {
  const t: Tree & { label: string } = {
    value: 1,
    children: [],
    label: "root",
  }
  return t
}
`);
    expect(errors).toEqual([]);
  });

  it("an unknown alias inside an intersection is reported (visitTypes wiring)", () => {
    // Review finding: validateTypeReferences walks via visitTypes, whose
    // intersection case Task 1 added — prove the wiring instead of
    // assuming it.
    const errors = typecheckSource(`
type A = { x: number }
type X = A & Undefined
node main() {
  return 1
}
`);
    expect(errors.map((e) => e.message).join("\n")).toMatch(
      /Type alias 'Undefined' is not defined/,
    );
  });

  it("semantic errors stay swallowed at typecheck time: string & number member", () => {
    const errors = typecheckSource(`
node main() {
  const x: { id: string } & { id: number } = { id: "1" }
  return x
}
`);
    expect(errors).toEqual([]);
  });
```

- [ ] **Step 5: Verify, sweep, commit**

```bash
pnpm test:run lib/typeChecker/typeOperators.test.ts > /tmp/ix-task2-green.log 2>&1; tail -3 /tmp/ix-task2-green.log
pnpm test:run lib/typeChecker > /tmp/ix-task2-suite.log 2>&1; tail -3 /tmp/ix-task2-suite.log
git add lib/typeChecker/typeOperators.ts lib/typeChecker/typeOperators.test.ts lib/typeChecker/assignability.ts
git commit -m "Evaluate intersections with a declarative group-combine-build merge pipeline"
```

---

### Task 3: deepResolveNode + hasAnyValidateTag + codegen/execution pins

**Files:**
- Modify: `lib/typeChecker/assignability.ts` (`deepResolveNode`)
- Modify: `lib/backends/typescriptGenerator/validationDescriptor.ts` (`hasAnyValidateTag`)
- Test: `lib/backends/typeOperators.codegen.test.ts` (extend)
- Create: `tests/typescriptGenerator/intersectionTypes.agency` (+ `.mjs`)
- Create: `tests/agency/intersection-type.agency` + `.test.json`

- [ ] **Step 1: Failing codegen pins (fallback-proof, per the playbook)**

Append to `lib/backends/typeOperators.codegen.test.ts`:

```ts
describe("intersections in alias bodies (deepResolveNode routing)", () => {
  it("a merged alias emits the full z.object with a non-string property", () => {
    const out = generate(`
type Named = {
  name: string,
}
type Aged = {
  age: number,
}
type Person = Named & Aged
node main() {
  return 1
}
`);
    // The red-first run prints the real emission — match the OBSERVED
    // string if zod spacing differs from this regex (review note).
    expect(out).toMatch(
      /const Person = z\.object\(\{ "name": z\.string\(\), "age": z\.number\(\) \}\)/,
    );
  });

  it("a validate tag on a shared key reaches the descriptor", () => {
    const out = generate(`
def positive(n: number): Result<number, string> {
  if (n > 0) {
    return success(n)
  }
  return failure("must be positive")
}
type A = {
  @validate(positive)
  id: number,
}
type B = {
  id: number,
}
type Merged = A & B
node main() {
  return 1
}
`);
    expect(out).toContain("(Merged as any).__agency_descriptor");
    expect(out).toContain("const Merged = z.object");
  });
});
```

- [ ] **Step 2: Red, then route + gate**

```bash
pnpm test:run lib/backends/typeOperators.codegen.test.ts > /tmp/ix-task3-red.log 2>&1; tail -5 /tmp/ix-task3-red.log
```

Expected red: `const Person = z.string()` — the fallback, observed. Fixes:

- `deepResolveNode`: add `"intersectionType"` to the routed condition alongside `keyofType`/`indexedAccessType` (same comment applies).
- `hasAnyValidateTag`: `case "intersectionType": return t.types.some((m) => hasAnyValidateTag(m, aliasesFull, seen));`

Re-run: green.

- [ ] **Step 3: Fixture + execution test**

`tests/typescriptGenerator/intersectionTypes.agency`:

```
type Named = {
  name: string,
}

type Aged = {
  age: number,
}

type Person = Named & Aged

node main() {
  const p: Person = { name: "a", age: 3 }
  return p
}
```

```bash
make > /tmp/ix-task3-make.log 2>&1; make fixtures > /tmp/ix-task3-fixtures.log 2>&1
grep -n "const Person" tests/typescriptGenerator/intersectionTypes.mjs
git status --short tests/
```

Zero churn outside the new files. `tests/agency/intersection-type.agency`:

```
// A merged type's schema requires keys from BOTH sides. (Schema bound
// to a variable first — #480.)
type Named = {
  name: string,
}

type Aged = {
  age: number,
}

node accepts() {
  const s = schema(Named & Aged)
  const r = s.parseJSON("{\"name\": \"a\", \"age\": 3}")
  if (isSuccess(r)) {
    return r.value
  }
  return "parse failed"
}

node rejects() {
  const s = schema(Named & Aged)
  const r = s.parseJSON("{\"name\": \"a\"}")
  if (isFailure(r)) {
    return "rejected"
  }
  return "accepted"
}
```

`tests/agency/intersection-type.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "accepts",
      "input": "",
      "expectedOutput": "{\"name\":\"a\",\"age\":3}",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "complete merged object parses"
    },
    {
      "nodeName": "rejects",
      "input": "",
      "expectedOutput": "\"rejected\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "description": "missing right-side key rejected"
    }
  ]
}
```

```bash
pnpm run agency test tests/agency/intersection-type.agency > /tmp/ix-task3-exec.log 2>&1; echo "exit=$?"
```

- [ ] **Step 4: Commit**

```bash
git add lib/typeChecker/assignability.ts lib/backends/typescriptGenerator/validationDescriptor.ts lib/backends/typeOperators.codegen.test.ts tests/typescriptGenerator/intersectionTypes.agency tests/typescriptGenerator/intersectionTypes.mjs tests/agency/intersection-type.agency tests/agency/intersection-type.test.json
git commit -m "Route intersections through deepResolveNode; pin codegen and runtime behavior"
```

---

### Task 4: Dev docs

**Files:**
- Modify: `docs/dev/typechecker/README.md`

- [ ] **Step 1:** Extend the type-operators paragraph (added by the keyof PR): `&` joins the operator family; eager left-to-right merge with recursive shared-key intersection in `evalIntersection` (`typeOperators.ts`); object-only operands; NOTE the deliberate TS divergence — `A & never` errors here rather than absorbing to `never`, because a silently-`never` schema is a debugging trap in a schema-producing language. No user-facing guide edits (owner decision).

- [ ] **Step 2: Commit**

```bash
git add docs/dev/typechecker/README.md
git commit -m "Document intersection types in the typechecker dev notes"
```

---

### Task 5: Full verification, push, PR

- [ ] **Step 1: Sweep**

```bash
pnpm test:run lib > /tmp/ix-task5-lib.log 2>&1; tail -3 /tmp/ix-task5-lib.log
pnpm run lint:structure > /tmp/ix-task5-lint.log 2>&1; echo "lint=$?"
make > /tmp/ix-task5-make.log 2>&1; echo "make=$?"
for t in intersection-type keyof-type utility-partial recursive-type; do pnpm run agency test tests/agency/$t.agency > /tmp/ix-task5-$t.log 2>&1; echo "$t: $?"; done
```

The re-runs guard the union-item restructure (it sits under every union annotation, which every merged feature uses).

- [ ] **Step 2: PR** (body file; no apostrophes on the command line). Cover: the mixin example; this closes the type-system feature roadmap (list what shipped and what was deliberately killed, with one line each); the precedence level design; the recursive shared-key merge with the tag-merge rationale; the `never` divergence; the red-first `deepResolveNode` observation; scope-outs (non-object operands, located diagnostics, user guide docs pending an owner call).

```bash
git push -u origin intersection
gh pr create --title "Add intersection types: the last type-system roadmap feature" --body-file /tmp/ix-pr-body.md
```
