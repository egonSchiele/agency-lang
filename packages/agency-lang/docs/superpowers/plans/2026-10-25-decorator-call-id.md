# Plan: function identity and tool context in decorator call records

## Goal and scope

Add two required fields to the existing `Call` record:

- `id: string`: the decorated function's existing runtime identity, formed from the compiler's module ID and the function's original definition name.
- `inToolCall: boolean`: whether this invocation began inside a model tool call. This includes functions called by the selected tool and calls made in its branches.

Treat `id` as opaque. Its uniqueness follows the function registry's existing module identity rules. It is not an absolute source path or an identifier promised to remain stable across builds. Partial, renamed, and preapproved copies of a function produce the same ID inside the decorated definition.

The boolean supports counting a function's invocations during tool execution. It does not distinguish functions selected directly by the model from functions called by their bodies. Direct-only counting is outside this change.

Keep the implementation confined to constructing decorator records. Generated code gains two properties on an object it already creates. Ordinary function definitions and calls gain no instrumentation. The runtime change is limited to recognizing the new record shape in an existing error message.

## Example

```agency
decorator def recorded(call, block) {
  print("${call.id} ${call.inToolCall}")
  return block(call.args)
}

@recorded
def add(a: number, b: number): number {
  return a + b
}

def outer(): number {
  return add(1, 2)
}

node main() {
  add(1, 2)
  // inToolCall is false.
  llm("Use the tools.", tools: [add, outer])
  // When the model calls add, its decorator sees true.
  // When the model calls outer, add's decorator also sees true.
}
```

A direct call to a decorator supplies both fields along with its other arguments:

```agency
recorded(call: {
  name: "manual",
  args: {},
  id: "manual-example",
  inToolCall: false
}) {
  return "body"
}
```

The caller chooses the metadata for a direct decorator call. Automatically lowered tags receive compiler-provided values.

## Existing machinery to reuse

1. `decoratorDesugar.ts` already creates a separate `const __call_N` statement before each decorator call. Preserve that statement and its existing checkpoint behavior.
2. `TypeScriptBuilder` already has the module ID used to define and register functions. `processRebindParameters` uses the key `${this.moduleId}:${node.functionName}` to find the decorated function. Use that same identity.
3. `runAsToolInvocation` already sets `Run.toolInvocationStack`. The runtime propagates it into child execution contexts. Its presence supplies the boolean without examining frames or adding state.
4. The compiler already supports synthetic nodes, including `rebindParameters`, with explicit handling in its type and traversal machinery. Use that pattern for the new metadata expressions.

Compute the ID during TypeScript generation. The lowering does not yet have the final runtime module ID. In particular, `compileSource` can use a generated ID or `fingerprintModuleId`, which differs from the source file path.

## Compiler design

### Declare the requested metadata as data

Add one compiler-only leaf expression kind, `DecoratorCallField`, in `lib/types/decoratorCallField.ts`. Its two discriminated variants are:

```ts
type DecoratorCallField = BaseNode &
  (
    | {
        type: "decoratorCallField";
        field: "id";
        functionName: string;
      }
    | {
        type: "decoratorCallField";
        field: "inToolCall";
      }
  );
```

These nodes describe what the record needs. They contain no module paths, runtime variable names, stack offsets, or executable source text. The `functionName` is the original definition name, used as identity data, as in `RebindParameters`.

Keep the existing object-literal construction in `callRecord`. Add ordinary `id` and `inToolCall` entries whose values use these typed leaves. Keep their construction in the existing record-building helper, so other lowering code does not need to know the leaf shapes.

Use the existing typed AST construction style. Parsing an Agency template would require inventing source syntax for values that exist only in the compiler. This change does not need a parser feature or a generic metadata framework.

### Interpret the metadata in one place

Add one small `TypeScriptBuilder` method for `DecoratorCallField`. It returns TypeScript IR through the existing `ts` builders:

- For `id`, emit a string literal containing the existing module-and-definition key.
- For `inToolCall`, emit a comparison of the current run's `toolInvocationStack` against `undefined`.

Keep the identity spelling consistent with `processRebindParameters`. If a small compiler-local key helper is needed to share that construction, use it in those two places. This does not require refactoring runtime registration.

The following is illustrative generated code inside the existing record step. Actual parameter and local references continue through the builder's normal scope handling.

```ts
const __call_0 = {
  name: "research",
  args: { task },
  id: "tools/research.agency:research",
  inToolCall: __run.toolInvocationStack !== undefined,
};
```

The ID is a literal in the compiled output. Bundling and output relocation do not recompute it from the output file's directory.

Only this builder method knows how to produce the metadata. Lowering and the type checker do not read runtime fields. The builder emits the final expression directly, without patching placeholder values in a later pass.

### Stacked decorators

Keep the existing order: construct the outer record, call the outer decorator, rebind the arguments, then construct the inner record. Inner records use the arguments after the preceding rebind.

Emit the same ID literal at each depth. For the boolean, inner records copy `__call_0.inToolCall` using the existing scoped property-access machinery. This captures the context of the decorated invocation once, even when a decorator calls its block in a branch.

```ts
const __call_1 = {
  name: "research",
  args: { task },
  id: "tools/research.agency:research",
  inToolCall: __call_0.inToolCall,
};
```

The property access must resolve to the enclosing function's saved local through normal scope annotation. Preserve the existing record step so checkpoint restoration keeps the original boolean.

### Compiler integration

Register `DecoratorCallField` separately in both `Expression` and `AgencyNode`, and add it to `EXPRESSION_NODE_TYPES`. Register it as a leaf in the existing expression, body, identifier, and top-level classification tables. It has no child expressions or identifiers to resolve, and it is not a source-level top-level statement.

Add a type-synthesis case that returns the existing string or boolean primitive type. Ordinary object inference then gives the record its full shape. The leaf performs no call and raises no effect, so it adds no function signature, effect propagation rule, or hoisted call.

It has no Agency source syntax. Ordinary formatting continues to use the original tags. If an internal formatter is given this lowered expression, report that it has no source form. The `agency preprocess` command prints JSON and should display the leaf as ordinary AST data.

Keep lowering idempotent. The type checker and TypeScript preprocessor can both lower the same program. The existing decorator bookkeeping must prevent a second rewrite.

## Record type and runtime footprint

Update `Call` in `stdlib/index.agency`:

```agency
export type Call = {
  name: string,
  args: object,
  id: string,
  inToolCall: boolean
}
```

Update its doc comment and the printed shape in `lib/types/function.ts`, which validates decorator record slots.

Update `isCallRecord` in `lib/runtime/agencyFunction.ts` to recognize `args,id,inToolCall,name`. This preserves the existing hint when someone writes `block(call)` instead of `block(call.args)`. Keep the detector's current purpose and validation behavior.

There is no new prelude function or runtime metadata helper. Function dispatch, frame setup, re-export forwarding, and checkpoint formats keep their existing behavior. Re-exported decorated tools naturally see `inToolCall: true` because they execute within the tool invocation.

Per decorated invocation, the outer record adds a literal property and one presence check. Inner records add the literal and a read of the saved boolean. There is no additional object allocation beyond the records already created, and no additional function call, await, runner step, or frame.

## Implementation sequence

1. Add the typed metadata leaf and its compiler registrations. Add type synthesis and TypeScript emission together.
2. Update `callRecord` to construct the two fields. Preserve its existing argument collection, source locations, statement placement, and idempotency.
3. Update `Call`, the decorator shape check, the runtime diagnostic, and direct-call examples.
4. Replace the current prototype's helper-based implementation with this design. Remove the `_callRecord` prelude export, its import and prelude-list entry, `lib/stdlib/callRecord.ts`, and its capability-test exemption. Adapt the prototype tests to the new contract.
5. Run the focused checks below, regenerate fixtures and stdlib documentation, and update the decorator guide and dev documentation.

The current worktree contains an uncommitted prototype for absolute paths and a three-way `toolCall` flag. Its passing tests do not validate this revised design. Remove only the superseded prototype work, preserving unrelated changes.

## Tests

### Compiler and type checks

- Update decorator lowering tests to expect object records with typed metadata leaves. Check that inner records copy the outer boolean and still collect arguments after rebind.
- Keep the lowering idempotency test.
- Check that the metadata leaves infer string and boolean types. A direct decorator call missing either required field should fail type checking.
- Add the leaf to the existing traversal coverage tests.
- Check that `agency preprocess` can print the lowered tree as JSON and that ordinary `agency fmt` still prints decorator tags.
- Regenerate the decorator TypeScript fixture. Verify the two emitted properties and the existing number of record steps. Undecorated fixtures should remain unchanged.
- Compile a decorated function with a local or imported binding named `_callRecord`. That binding must not affect the metadata because no generated call refers to it.
- Exercise `compileSource` with its generated module identity and with `fingerprintModuleId`, so code generation cannot accidentally use `fromFile`.

### Execution without a model

Adapt `tests/agency/decorators/call-id.agency` and its helper module to check equality and inequality of opaque IDs. Cover an imported decorator, two different decorated definitions, partial application, and stacked decorators. Plain calls must see `false`. Avoid assertions about absolute paths or parsing the ID.

Add a focused packed-program case with two decorated functions of the same name in `a/tools.agency` and `b/tools.agency`. Their IDs must differ. Compile the same sources with a fixed module identity into a separate output directory and verify that output placement does not change their IDs.

Run the existing decorator interrupt, handler, and argument-rebinding tests. Extend the resume coverage to check that both metadata fields remain unchanged after a pause. Exercise a stacked decorator whose block runs in a branch.

### Scripted model

Adapt `tests/agency-js/decorator-tool-call/` to use a scripted client with one tool call per round. Record the boolean and compare IDs without depending on their spelling.

| Invocation | Expected inToolCall |
|---|---|
| Ordinary call from the node | false |
| Function selected by the model | true |
| Decorated function called by that tool's body | true |
| Partial, renamed, or preapproved copy selected by the model | true |
| Decorated function reached through a re-exported tool | true |
| Both records of a stacked decorator on a selected tool | true |
| Decorated function called in a branch inside a tool | true |
| Ordinary call after the model call has finished | false |

Keep the existing handler behavior checks. The metadata must not introduce a new execution scope that changes which handlers run.

### Commands

Run from the package directory and save each command's output to a log file. Do not run the full Agency suite locally.

1. `make`, because the stdlib type changes.
2. Regenerate the TypeScript fixtures with `node dist/scripts/regenerate-fixtures.js`.
3. Run the affected Vitest files: decorator lowering and checking, type checker, prelude, runtime `AgencyFunction`, TypeScript integration, formatter round trips, and the relevant traversal coverage tests.
4. `pnpm run agency test tests/agency/decorators`.
5. `pnpm run agency test js tests/agency-js/decorator-tool-call`, plus the focused packaging/output-directory case.
6. `pnpm run fmt:ts`, `pnpm run lint:structure`, and `pnpm run typecheck`.

## Documentation

Update `docs/site/guide/decorators.md` to describe the opaque ID and the boolean's transitive meaning. Include both fields in the direct-call example.

Update `docs/dev/language/decorators.md` to describe the metadata leaf, its emission in the existing record step, and the inner record's saved boolean. Update the printed `Call` shape.

Generate `docs/site/stdlib/index.md` from the Agency source using the existing build/doc commands.

## Design boundaries from the anti-pattern catalog

The interface between lowering and code generation is declarative: a leaf requests either function identity or tool context. One builder method implements those requests.

- **Imperative code everywhere:** keep runtime field access and identity emission in that method. Record construction remains a pure description of entries.
- **Leaky abstractions:** lowering must not inspect stack depth, frame ownership, output paths, or `__run`. The type checker only assigns the requested field's type.
- **Order-dependent mutable state:** emit final values directly. Add no placeholder-patching pass, new runtime flag, or counter.
- **Duplicating existing code:** reuse the existing module identity, tool-invocation state, scoped property access, and AST traversal machinery.
- **Inconsistent patterns:** use typed synthetic nodes and the existing TypeScript IR builders. Keep the current object-record and checkpoint-step structure.
- **Useless special cases:** the boolean requires no handling for renamed functions, re-export wrappers, host paths, or bundle layouts.

These boundaries keep the feature small. They do not require a general metadata registry or changes to the calling convention.
