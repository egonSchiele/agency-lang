# ADI-249: Keep `.withParamSchema` schemas across a checkpoint — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The owner prefers one agent working inline, so do not use subagent-driven development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A function value whose parameter schema was set with `.withParamSchema(name, jsonSchema)` keeps that schema after it goes through a checkpoint and back.

**Architecture:** `AgencyFunction` remembers the JSON Schema each `.withParamSchema` call gave it, in a new `paramSchemas` record keyed by parameter name. The function reviver writes that record into the checkpoint beside the tool description and calls `.withParamSchema` again for each entry when it revives the function. Nothing else changes: the zod schema the model sees is still built by `.withParamSchema`, from the same JSON Schema, in the same place.

**Tech Stack:** TypeScript in `lib/runtime/`, vitest.

**Spec:** `docs/superpowers/specs/2026-10-26-workflows-design.md`, section "Offering a workflow as a tool", and Linear ticket ADI-249. This fix is its own PR and lands before `workflowTool` (ADI-254).

## Background for someone new to this codebase

- **What a function value is.** Every Agency `def` compiles to an `AgencyFunction` (`lib/runtime/agencyFunction.ts`). It carries the function's name, module, parameters, and a `toolDefinition` with the description and the zod schema a model sees when the function is offered as a tool. A function value is immutable: `.partial()`, `.rename()`, `.describe()`, `.preapprove()`, and `.withParamSchema()` each return a copy. Every copy is made by `derive()`, which spreads `options()` under the change, so a field added to `options()` is carried by every derivation for free (`lib/runtime/agencyFunction.ts:210-231`).
- **What `.withParamSchema` does.** `withParamSchema(name, jsonSchema)` (`lib/runtime/agencyFunction.ts:458-468`) replaces one unbound parameter's entry in the tool definition's zod object with `z.fromJSONSchema(jsonSchema)`. It is how a saved toolbox tool shows the model its `request` type (`lib/agents/agency-agent/lib/learned.agency:78`) and how `workflowTool` will show a workflow's typed inputs instead of `inputs: any JSON value`.
- **How a function value is checkpointed.** A checkpoint is the program's serialized state (`docs/dev/runtime/checkpointing.md`). A function value in that state is written by `FunctionRefReviver.serialize` (`lib/runtime/revivers/functionRefReviver.ts:23-49`) as a small record: name, module, the registered name if renamed, the parameters if any are bound, the tool description, and the preapproved flag. `revive` looks the function up in the registry by its registered name and re-applies each of those: `rename`, then `partial`, then `describe`, then `preapprove` (`functionRefReviver.ts:55-115`). The schema set by `.withParamSchema` is not in the record, so a revived function has the schema its declaration gave it.
- **The miss stub.** When the registry does not have the function, because the process holding the checkpoint never loaded its module, `revive` builds a stub that throws when invoked but re-serializes to the same record (`makeUnresolvedFunctionStub`, `functionRefReviver.ts:240-270`). Its comment says: every field `serialize` writes must be rebuilt here and covered by the round-trip tests. This plan adds one.
- **`.partial()` and the schema.** `partial` builds a reduced zod schema that keeps the shape entries of the unbound parameters (`buildReducedSchema`, `agencyFunction.ts:711-722`), so a schema set with `.withParamSchema` survives a later `.partial()` of a different parameter. The new record must match: a bound parameter's entry is dropped, so that `revive`, which applies `partial` before `withParamSchema`, never calls `withParamSchema` on a bound parameter, which throws.
- **Running the tests.** `pnpm test:run lib/runtime/agencyFunction.test.ts lib/runtime/revivers/functionRefReviver.test.ts > /tmp/adi249.log 2>&1`. Save the output to a file and read it, as CLAUDE.md asks. Then `pnpm run typecheck` and `pnpm run fmt:ts`.

## Global Constraints

- `paramSchemas` holds the JSON Schema values exactly as `.withParamSchema` received them. It never holds zod values: zod does not serialize.
- A function with no `.withParamSchema` call serializes exactly as it does today. `serialize` writes `paramSchemas` only when the record has at least one entry, so no existing checkpoint fixture changes.
- `serialize(revive(x))` equals `x` for every record, including a registry miss.
- No change to what the model sees for a function that is never checkpointed: `.withParamSchema` builds the zod object the same way it does now.

## Review Focus

Inputs the spec implies and no test in the ticket exercises. Each gets a test in the task named.

1. `.withParamSchema("b", s).partial({ a: 1 })`: after a round trip, `b` still has schema `s` and `a` is bound. (Task 2)
2. `.partial({ a: 1 }).withParamSchema("b", s).describe("d")`: all three survive a round trip in the order `revive` applies them. (Task 2)
3. A schema set twice on the same parameter: the last one wins, and the record has one entry. (Task 1)
4. A registry miss: the stub re-serializes the `paramSchemas` field unchanged. (Task 2)
5. A function with no `.withParamSchema` call: `serialize` has no `paramSchemas` key. (Task 2)

---

### Task 1: `AgencyFunction` remembers its parameter schemas

**Files:**
- Modify: `lib/runtime/agencyFunction.ts` (`AgencyFunctionOpts`, the class fields, the constructor, `options()`, `partial`, `withParamSchema`)
- Test: `lib/runtime/agencyFunction.test.ts`, the existing `describe("withParamSchema()")` block at line 715

**Interfaces:**
- Produces: `AgencyFunctionOpts.paramSchemas?: Record<string, unknown>` and `readonly paramSchemas: Record<string, unknown>` on `AgencyFunction`, keyed by parameter name, empty by default. `withParamSchema(name, jsonSchema)` adds or replaces the entry for `name`. `partial(bindings)` drops the entries of the parameters it binds.

- [ ] **Step 1: Write the failing tests**

Add to the `withParamSchema()` describe block, which already has `requestSchema`, `twoParams()`, and `jsonSchemaOf`:

```ts
it("records the JSON Schema it was given, by parameter name", () => {
  const shaped = twoParams().withParamSchema("b", requestSchema);
  expect(shaped.paramSchemas).toEqual({ b: requestSchema });
  expect(twoParams().paramSchemas).toEqual({});
});

it("a second schema for the same parameter replaces the first", () => {
  const other = { type: "string" };
  const shaped = twoParams().withParamSchema("b", requestSchema).withParamSchema("b", other);
  expect(shaped.paramSchemas).toEqual({ b: other });
  expect(jsonSchemaOf(shaped).properties.b).toEqual({ type: "string" });
});

it("partial() drops the record entry of a parameter it binds and keeps the rest", () => {
  const aSchema = { type: "integer" };
  const shaped = twoParams().withParamSchema("a", aSchema).withParamSchema("b", requestSchema);
  const bound = shaped.partial({ a: 1 });
  expect(bound.paramSchemas).toEqual({ b: requestSchema });
  expect(jsonSchemaOf(bound).properties.b.properties.n).toEqual({ type: "number" });
});

it("rename(), describe(), and preapprove() carry the record", () => {
  const shaped = twoParams().withParamSchema("b", requestSchema);
  expect(shaped.rename("other").paramSchemas).toEqual({ b: requestSchema });
  expect(shaped.describe("d").paramSchemas).toEqual({ b: requestSchema });
  expect(shaped.preapprove().paramSchemas).toEqual({ b: requestSchema });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:run lib/runtime/agencyFunction.test.ts > /tmp/adi249-t1.log 2>&1; grep -n "✓\|✗\|×\|FAIL" /tmp/adi249-t1.log | head -40`
Expected: the four new tests fail; `paramSchemas` is undefined.

- [ ] **Step 3: Add the field**

In `lib/runtime/agencyFunction.ts`:

- `AgencyFunctionOpts`: add `paramSchemas?: Record<string, unknown>;` with a doc comment: the JSON Schema each `.withParamSchema` call gave a parameter, by name, kept so a checkpoint can restore it.
- The class: add `readonly paramSchemas: Record<string, unknown>;`, set in the constructor from `opts.paramSchemas ?? {}`.
- `options()`: add `paramSchemas: this.paramSchemas`. This is the one place `derive` reads, so every derivation carries it.
- `withParamSchema`: pass `paramSchemas: { ...this.paramSchemas, [name]: jsonSchema }` through the derivation. It currently returns `this.withToolDefinition(...)`; change it to `this.derive({ toolDefinition: {...}, paramSchemas: {...} })`.
- `partial`: in the final `derive` call, add `paramSchemas` with the bound names removed. Write the filtering as one expression over `Object.entries(this.paramSchemas)` and `boundNames`, which is already in scope.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test:run lib/runtime/agencyFunction.test.ts > /tmp/adi249-t1.log 2>&1; tail -20 /tmp/adi249-t1.log`
Expected: all pass.

- [ ] **Step 5: Typecheck, format, commit**

```bash
pnpm run typecheck
pnpm run fmt:ts
git add lib/runtime/agencyFunction.ts lib/runtime/agencyFunction.test.ts
git commit -F /tmp/adi249-c1.txt
```

Commit message in the file: `AgencyFunction: remember the JSON Schema each withParamSchema call gave a parameter`.

---

### Task 2: The reviver writes and restores the record

**Files:**
- Modify: `lib/runtime/revivers/functionRefReviver.ts` (`serialize`, `revive`, `makeUnresolvedFunctionStub` and its comment)
- Test: `lib/runtime/revivers/functionRefReviver.test.ts`

**Interfaces:**
- Consumes: `AgencyFunction.paramSchemas` and `withParamSchema` from Task 1.
- Produces: a `paramSchemas` field on the serialized `FunctionRef` record, present only when non-empty.

- [ ] **Step 1: Write the failing tests**

Add a new describe block at the end of `functionRefReviver.test.ts`. The file already imports `AgencyFunction`, `FunctionRefReviver`, `functionRefReviver`, `nativeTypeReplacer`, `nativeTypeReviver`, `testRun`, and `z`.

```ts
describe("withParamSchema schemas round-trip (ADI-249)", () => {
  const requestSchema = {
    type: "object",
    properties: { n: { type: "number" } },
    required: ["n"],
    additionalProperties: false,
  };
  function makeRegistered(registry: Record<string, AgencyFunction>): AgencyFunction {
    return AgencyFunction.create(
      {
        name: "runTool",
        module: "stdlib/toolbox.agency",
        fn: (_run: unknown, a: number, b: unknown) => [a, b],
        params: [
          { name: "a", hasDefault: false, defaultValue: undefined, variadic: false },
          { name: "b", hasDefault: false, defaultValue: undefined, variadic: false },
        ],
        toolDefinition: {
          name: "runTool",
          description: "Run.",
          schema: z.object({ a: z.number(), b: z.any() }),
        },
      },
      registry,
    );
  }
  const jsonSchemaOf = (fn: AgencyFunction): any =>
    (fn.toolDefinition!.schema as z.ZodType).toJSONSchema();

  it("serialize writes paramSchemas only when a schema was set", () => {
    const reviver = new FunctionRefReviver();
    const registry: Record<string, AgencyFunction> = {};
    const plain = makeRegistered(registry);
    expect(reviver.serialize(plain)).not.toHaveProperty("paramSchemas");
    expect(reviver.serialize(plain.withParamSchema("b", requestSchema))).toMatchObject({
      paramSchemas: { b: requestSchema },
    });
  });

  it("partial, describe, and withParamSchema all survive a round trip", async () => {
    const registry: Record<string, AgencyFunction> = {};
    const tool = makeRegistered(registry)
      .partial({ a: 1 })
      .withParamSchema("b", requestSchema)
      .describe("Run with n.");
    functionRefReviver.registry = registry;

    const json = JSON.stringify({ tool }, nativeTypeReplacer);
    const restored = JSON.parse(json, nativeTypeReviver);

    expect(restored.tool.paramSchemas).toEqual({ b: requestSchema });
    expect(restored.tool.toolDefinition.description).toBe("Run with n.");
    const schema = jsonSchemaOf(restored.tool);
    expect(Object.keys(schema.properties)).toEqual(["b"]);
    expect(schema.properties.b.properties.n).toEqual({ type: "number" });
    expect(schema.properties.b.required).toEqual(["n"]);
    const result = await restored.tool.invoke(testRun(), { type: "positional", args: [{ n: 2 }] });
    expect(result).toEqual([1, { n: 2 }]);

    functionRefReviver.registry = null;
  });

  it("a schema set before partial() is kept for the unbound parameter", () => {
    const registry: Record<string, AgencyFunction> = {};
    const tool = makeRegistered(registry).withParamSchema("b", requestSchema).partial({ a: 1 });
    functionRefReviver.registry = registry;

    const json = JSON.stringify({ tool }, nativeTypeReplacer);
    const restored = JSON.parse(json, nativeTypeReviver);

    expect(restored.tool.getUnboundParams().map((p: any) => p.name)).toEqual(["b"]);
    expect(jsonSchemaOf(restored.tool).properties.b.required).toEqual(["n"]);

    functionRefReviver.registry = null;
  });

  it("the miss stub re-serializes paramSchemas unchanged", () => {
    const reviver = new FunctionRefReviver();
    reviver.registry = {};
    const serialized = {
      __nativeType: "FunctionRef",
      name: "runTool",
      module: "stdlib/toolbox.agency",
      toolDescription: "Run.",
      paramSchemas: { b: requestSchema },
    };
    const stub = reviver.revive(serialized) as AgencyFunction;
    expect(reviver.serialize(stub)).toEqual(serialized);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:run lib/runtime/revivers/functionRefReviver.test.ts > /tmp/adi249-t2.log 2>&1; grep -n "×\|FAIL\|✓" /tmp/adi249-t2.log | tail -20`
Expected: the four new tests fail; the rest still pass.

- [ ] **Step 3: Write and restore the field**

In `lib/runtime/revivers/functionRefReviver.ts`:

- `serialize`: after the `toolDescription` block, `if (Object.keys(value.paramSchemas).length > 0) result.paramSchemas = value.paramSchemas;`.
- `revive`: after the partial/describe `if` chain and before `preapprove`, when `value.paramSchemas` is a non-null object, apply `result = result.withParamSchema(name, schema)` for each entry. Write it as a small helper, `applyParamSchemas(fn, record)`, beside `lookupInRegistry`, with a comment saying why it runs after `partial`: `withParamSchema` refuses a bound parameter, and `partial` has already dropped the bound names from the record.
- `makeUnresolvedFunctionStub`: pass `paramSchemas` through the constructor options when the record has it. The stub's zod schema stays null; it only needs to re-serialize, never to be shown to a model. Say so in one line beside the field.
- Update the comment on `makeUnresolvedFunctionStub` that lists the rebuilt fields, so `paramSchemas` is named with the others.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test:run lib/runtime/agencyFunction.test.ts lib/runtime/revivers/functionRefReviver.test.ts > /tmp/adi249-t2.log 2>&1; tail -20 /tmp/adi249-t2.log`
Expected: all pass.

- [ ] **Step 5: Typecheck, format, lint, commit**

```bash
pnpm run typecheck
pnpm run fmt:ts
pnpm run lint:structure
git add lib/runtime/revivers/functionRefReviver.ts lib/runtime/revivers/functionRefReviver.test.ts
git commit -F /tmp/adi249-c2.txt
```

Commit message: `FunctionRefReviver: keep withParamSchema schemas across a checkpoint`.

---

### Task 3: Docs

**Files:**
- Modify: `docs/dev/runtime/checkpointing.md`, the part that describes how a function value is serialized (search for "FunctionRef" or "function value"; if there is no such part, add a short section "Function values in a checkpoint" listing the fields `serialize` writes and the order `revive` re-applies them, ending with `paramSchemas`)
- Modify: `docs/superpowers/specs/2026-10-26-workflows-design.md`, section "Offering a workflow as a tool": the sentence "The reviver is fixed to save and re-apply the schema before `workflowTool` is built" becomes a statement that it does so, naming `paramSchemas`.

- [ ] **Step 1: Write the dev doc paragraph**

Mechanism and rule only, no history: what the record holds, why it is JSON Schema and not zod, why `partial` drops bound names, and why the miss stub carries the record without building a schema.

- [ ] **Step 2: Commit**

```bash
git add docs/dev/runtime/checkpointing.md docs/superpowers/specs/2026-10-26-workflows-design.md
git commit -F /tmp/adi249-c3.txt
```

Commit message: `docs: function values keep their parameter schemas across a checkpoint`.

---

### Task 4: PR

- [ ] **Step 1: Check the diff against `docs/dev/contributing/anti-patterns.md`**, in particular the rule about one data source: the record and the zod shape are both written by `withParamSchema` and both reduced by `partial`, and nothing else touches either.
- [ ] **Step 2: Push and open the PR** with the description in a file. Title: `Keep withParamSchema schemas when a function value is checkpointed (ADI-249)`. The description says what the gap was (a saved tool's typed parameter became `any JSON value` after a pause), what changed in each of the two files, and that the generated checkpoint of a function with no `.withParamSchema` call is byte-for-byte the same.
- [ ] **Step 3: Link the PR on ADI-249** and move the ticket to In Review. The owner merges.

## Self-review notes

- The ticket asks for one test taking a function with a param schema, a bound argument, and a description through a checkpoint. That is the second test of Task 2.
- `created` tools (`restoreCreatedTool`) take the same post-lookup path in `revive`, so they get the schema back as well. No separate code path.
- The `learned.agency` toolbox tool and the future `workflowTool` need no change: both already call `.withParamSchema`.
