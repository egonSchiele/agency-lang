# Spec: every failure carries a message

Written 2026-09-06. Status: draft for the owner. No code yet.

Agency has no exceptions. A function that can fail returns a `Result`,
which is either a success carrying a value or a failure carrying an
error. The failure's error can be any type at all. This spec changes it
so that a failure always carries a string message, and optionally
carries an object of extra data alongside it.

Agency has no users yet, so nothing here worries about keeping old code
working.

## Background: what the error field holds today

Here is a failure being produced and read:

```
def divide(a: number, b: number): Result {
  if (b == 0) {
    return failure("Can't divide by zero!")
  }
  return success(a / b)
}

const result = divide(10, 0)
if (result is failure(err)) {
  print("Error: ${err}")
}
```

`err` is whatever the producer passed to `failure()`. The runtime types
it as `any` (`lib/runtime/result.ts:88`), and the type checker types it
as the second `Result` type parameter, which defaults to `any`
(`lib/typeChecker/resultUnion.ts:33`).

In practice almost every producer passes a string. I counted 290
`failure(...)` calls in `.agency` files and 71 in the runtime and
stdlib TypeScript. Twenty-two of those call sites pass an object
literal, and two more pass a helper's returned object. They group into
the ten producer functions below.

### The ten producers that pass an object

| Producer                                                       | Object shape                                                  | Has a message? |
| -------------------------------------------------------------- | ------------------------------------------------------------- | -------------- |
| `guardFailureData`, `lib/runtime/result.ts:15`                 | `{ type, label, maxCost, actualCost, maxTime, actualTime }`   | no             |
| `parsePolicyFile`, `stdlib/policy.agency:464`                  | `{ status, error? }`                                          | no             |
| `outcomeToResult`, `stdlib/agents/agency/coding.agency:253`    | `{ source, problems }`                                        | no             |
| `draftProblem`, `stdlib/toolbox.agency:524`                    | `{ problem }`                                                 | no             |
| `httpStatusFailure`, `lib/stdlib/http.ts:143`                  | `{ status, statusText, url, body, message }`                  | yes            |
| `s3ErrorToFailure`, `lib/stdlib/aws/errors.ts:30`              | `{ status, statusText, url, code, s3Message, body, message }` | yes            |
| `objectSizeFailure`, `lib/stdlib/objectBytes.ts:7`             | `{ message }`                                                 | yes            |
| the three AWS guards in `s3.ts`, `client.ts`, `credentials.ts` | `{ message }`                                                 | yes            |
| `makeLimitFailure`, `lib/runtime/ipc.ts:132`                   | `{ reason, limit, threshold, value, message }`                | yes            |
| `walk`, `lib/runtime/validateChain.ts:204`                     | `{ reason, limit, kind, valuePreview }`                       | no             |

Five of the ten already put a `message` field in the object by hand.
They are doing what this spec makes mandatory, one producer at a time,
with no help from the language.

The other five have no message anywhere. Three of those five have a
caller that builds a sentence out of the object by hand: `problemText`
(`stdlib/toolbox.agency:1035`), the status-to-sentence code in
`stdlib/policy.agency:545`, and `writeFailure.problems.join("\n")` at
`stdlib/toolbox.agency:538`. The remaining two, the guard trip and the
validation walk, have no caller-side sentence at all. Their objects go
straight to whoever is reading.

### Two more ways a non-string error appears

A rejected interrupt becomes a failure whose error is the value the
handler rejected with. The codegen writes this:

```
failure(__response.value ?? "interrupt rejected", { rejected: true })
```

That is `lib/templates/backends/typescriptGenerator/interruptReturn.ts:14`
and the matching lines in `interruptAssignment.ts`. `reject(value)`
takes `any` (`lib/runtime/interruptResponse.ts:18`), so a handler that
rejects with an object produces a failure with an object error.

The `try` keyword is already safe. `__tryCall` converts a thrown
JavaScript error with `error instanceof Error ? error.message :
String(error)` (`lib/runtime/result.ts:281`).

### What the missing guarantee costs

Every place that has to show a failure to a person or to a model has to
guess how to turn it into text. Here is the one in the tool loop:

```ts
function toolErrorMessage(error: any): string {
  return typeof error === "string" ? error : stringifyToolResult(error);
}
```

That is `lib/runtime/prompt.ts:192`. When a tool fails with a guard
trip, the model receives the JSON `{"type":"guardFailure","label":null,
"maxCost":0.3,"actualCost":0.42,...}` instead of a sentence.

Four more places do the same guessing: `lib/stdlib/threads.ts:243`,
`lib/runtime/failurePropagation.ts:236`, `lib/runtime/llmRetry.ts:336`,
and `lib/stdlib/mcp.ts:92`.

## Goal

A failure always has a string message. It may also carry an object of
structured data. Any code that needs to show a failure to a person or a
model reads `.error` and is done.

## Non-goals

- Changing `success`. Its value stays any type.
- Backward compatibility. Old checkpoints and old serialized failures
  do not need to load.
- Making the data field typed by anything stronger than an object type.

## Design

### The new failure shape

```
failure(message: string, data?: object)
```

`ResultFailure` in `lib/runtime/result.ts` gains a `data` field:

```ts
export type ResultFailure = {
  __type: "resultType";
  success: false;
  error: string;
  data: Record<string, any>;
  checkpoint: any;
  neverStarted: boolean;
  destructiveRan: boolean;
  rejected: boolean;
  functionName: string | null;
  args: Record<string, any> | null;
  skippedFunctions: SkippedFunction[];
};
```

`data` is `{}` when the producer passed no second argument. It is never
null, so a reader can write `err.data.status` without checking first.
Agency reads a missing field as null, so that expression is null when
the producer supplied no data.

### Reading a failure

```
const result = parsePolicyFile("policy.json")
if (result is failure(msg)) {
  print("Could not load the policy: ${msg}")
}
```

`msg` is a string. To reach the data, bind a second name:

```
if (result is failure(msg, info)) {
  print("${msg} (status was ${info.status})")
}
```

Both forms work in a `match` arm as well:

```
match (result) {
  success(policy) => install(policy)
  failure(msg, info) => warn(msg, info.status)
}
```

The one-name form stays legal everywhere it is legal today. Field
access also still works, so `result.error` is the message and
`result.data` is the object.

### The `Result` type parameters

`Result<T, D>` now means "succeeds with a `T`, or fails with a message
and a `D` of data". The failure type slot becomes the data type slot.

There are fourteen two-parameter annotations in the codebase. Seven
name an object type and keep their source text unchanged. Here is
`stdlib/policy.agency:453` before and after:

```
// before: fails with a ParsePolicyFailure
export def parsePolicyFile(path: string): Result<Policy, ParsePolicyFailure>

// after: fails with a message, plus ParsePolicyFailure data
export def parsePolicyFile(path: string): Result<Policy, ParsePolicyFailure>
```

The source text does not change. What changes is that the failure now
also has a sentence in `.error`. The other seven name `string` or an
object whose only field is the message, and they all shrink. They are
listed under "Annotations whose data slot is not an object" below.

The sugar forms change meaning to match:

| Spelling     | Desugars to        |
| ------------ | ------------------ |
| `Result`     | `Result<any, any>` |
| `Result<T>`  | `Result<T, any>`   |
| `Success<T>` | `Result<T, any>`   |
| `Failure<D>` | `Result<any, D>`   |

`Result<T>` used to desugar to `Result<T, string>`
(`lib/parsers/parsers.ts:2345`), naming a string failure. That reading
is gone, so the single-parameter form says nothing about the data.

`Failure<D>` stays. It is the way to say that a function always fails,
and `D` names its data type.

### Declaring a data type makes it required

Here is a function that names a data type and then forgets to supply it:

```
export def parsePolicyFile(path: string): Result<Policy, ParsePolicyFailure> {
  if (!exists(name, dir)) {
    return failure("Policy file not found: ${path}")
  }
  ...
}
```

That is a compile error. If a function declares a data type, every
`failure` in it has to supply data. Otherwise the declared type says
the data is there when it is not, and a caller reading
`result.data.status` gets null with nothing to explain why.

To allow both forms in one function, add `null` to the data type:

```
def loadConfig(path: string): Result<Config, ParseFailure | null> {
  if (!exists(path)) {
    return failure("No config at ${path}")
  }
  return failure("Bad syntax in ${path}", { line: 4 })
}
```

`Result<T>` and bare `Result` both have `any` as their data type, so a
bare `failure(msg)` is fine in either.

The check needs no new machinery. A one-argument `failure` synthesizes
its type as `Result<any, null>`. The Result branch of the assignability
check at `lib/typeChecker/assignability.ts:669` is covariant in both
parameters, so it does the rest: `null` is assignable to `any` and to
`D | null`, and it is not assignable to `ParsePolicyFailure`.

The static data type can say `null`, but the runtime value is always
`{}`, so `result.data == null` is never true. The `null` in `D | null`
means the producer may omit the data. It is not a value that comes back.
Test a field of the data instead:

```
if (result.data.line != null) { ... }
```

### Reject takes a string

```ts
export function reject(reason?: string): InterruptResponse;
```

A rejection message is only ever shown to a person or to a model, so it
has no use for structured data. Every `reject` call in the repository
already passes a string or nothing. I counted 96 bare `reject()` calls
and 61 with an argument. Fifty-seven of the 61 pass a string literal or
an interpolation. The other four pass a variable, and all four of those
variables are declared `string`: `decision.message`, `answer.reason`
(`stdlib/policy.agency:630`), `scripted.mismatch`, and the return of
`input()` at `stdlib/policy.agency:954`.

The interrupt codegen then produces a failure whose message is that
string and whose data is null.

## What changes, file by file

### Runtime

`lib/runtime/result.ts`. The `failure()` signature becomes
`failure(error: string, data?: object | null, opts?: FailureOpts)`.
`ResultFailure` gains `data`. `propagateFailure` copies it through the
spread it already does.

`guardFailureData` at line 15 stops returning the whole object as the
error, and returns a message plus data instead:

```
"Cost guard 'research' exceeded: spent $0.42 of a $0.30 budget"
```

with `{ type, label, maxCost, actualCost, maxTime, actualTime }` as the
data. The time variant reads:

```
"Time guard 'research' exceeded: ran 71s of a 60s budget"
```

`lib/runtime/prompt.ts`. Delete `toolErrorMessage` at line 192 and use
`toolResult.error` at lines 1244 and 1248. Line 1289 passes
`toolResult.value`, not an error, so it keeps `stringifyToolResult`.

`lib/runtime/ipc.ts:132`. `makeLimitFailure` moves its `message` out of
the object and into the first argument.

`lib/runtime/validateChain.ts:204,218`. Both get a message built from
the `reason` and `limit` they already have.

`lib/runtime/interruptResponse.ts:18`. `reject` takes `string | undefined`.

`lib/stdlib/threads.ts:243`, `lib/runtime/failurePropagation.ts:236`,
`lib/runtime/llmRetry.ts:336`, `lib/stdlib/mcp.ts:92`. Drop the
`String(...)` coercion around `.error`.

### Stdlib TypeScript

`lib/stdlib/http.ts:143`, `lib/stdlib/aws/errors.ts:30`,
`lib/stdlib/aws/s3.ts:99,105,117,221`, `lib/stdlib/aws/client.ts:83`,
`lib/stdlib/aws/credentials.ts:19`, `lib/stdlib/objectBytes.ts:7`. Each
of these already builds a `message` field. Move it to the first
argument and leave the rest as data. Where the object is only
`{ message }`, drop the object and pass the message alone.

### Stdlib Agency

`stdlib/toolbox.agency`. `draftProblem` at line 524 becomes
`failure(message)`. `problemText` at line 1035 and the `DraftProblem`
type both delete. Line 538 becomes `return failure(writeFailure.error)`,
and line 1050 becomes `return failure(assembleErr)`.

`stdlib/policy.agency:464-486`. Each of the four failures gains a
message:

```
return failure("Policy file not found: ${path}", { status: "doesnt-exist" })
```

The message assembly at lines 545 to 551 collapses to printing
`loaded.error`.

`stdlib/agents/agency/coding.agency:253`. `outcomeToResult` becomes:

```
return failure(outcome.problems.join("\n"), {
  source: outcome.source,
  problems: outcome.problems
})
```

`WriteFailure` keeps both fields, so the three `Result<string,
WriteFailure>` annotations at lines 249, 375, and 469 stay as written.
The initializer at line 469 gains a message:

```
let written: Result<string, WriteFailure> = failure("no attempt made yet", {
  source: "",
  problems: []
})
```

`stdlib/thread.agency:270`. `GuardFailureData` keeps its fields and its
name. It now describes the data, not the error.

### Annotations whose data slot is not an object

Six annotations name `string` in the second slot. Under the old reading
that meant "fails with a string". Under the new one it means "fails with
string data", and the type checker rejects it because a data type has to
be an object. Each drops the second parameter:

| File                                                 | Line | Was                      | Becomes          |
| ---------------------------------------------------- | ---- | ------------------------ | ---------------- |
| `stdlib/llm.agency`                                  | 99   | `Result<string, string>` | `Result<string>` |
| `stdlib/llm.agency`                                  | 212  | `Result<number, string>` | `Result<number>` |
| `tests/agency/if-expression.agency`                  | 35   | `Result<number, string>` | `Result<number>` |
| `tests/agency/recursive-type-validated.agency`       | 7    | `Result<number, string>` | `Result<number>` |
| `tests/agency/result/result-generic.agency`          | 1    | `Result<number, string>` | `Result<number>` |
| `tests/agency-js/llm-provider-defaults/agent.agency` | 5    | `Result<string, string>` | `Result<string>` |

One more names an object whose only field is the message.
`lib/agents/agency-agent/lib/repl.agency:307` takes
`Result<string | null, { error: string }>` and reads `f.error` off the
binding at line 316. Both collapse:

```
export def renderAgentResponse(response: Result<string | null>): void {
  if (response is success(reply)) {
    ...
  } else if (response is failure(f)) {
    pushMessage(color.red(formatTurnFailure(f)))
  }
}
```

The two guard annotations stay as written:
`Result<string, GuardFailureData>` at
`tests/agency/guards/guard-in-def.agency:9`, and the one named in a
comment in `guard-generic-return.agency`. A guard trip supplies data, so
both declarations stay accurate.

The docstring at `stdlib/agents/planner.agency:45` describes
`agencyCodingAgent` as returning `Result<string, WriteFailure>`. That
stays accurate.

### Parser

`lib/parsers/parsers.ts:2306`. `resultTypeParser` renames its
`failureType` capture to `dataType`, and the `Result<T>` branch at line
2345 sets `any` instead of `string`.

`lib/parsers/parsers.ts:7481`. `resultPatternParser` accepts an optional
second identifier inside the parens. The committed-form error message
at line 7509 grows a mention of the two-name form. The two-name form is
only legal for `failure`; `success(a, b)` is a parse error naming the
one-name form.

### Types and lowering

`lib/types/pattern.ts:60`. `ResultPattern` gains `dataBinding: string | null`.

`lib/lowering/patternLowering.ts:1176`. The `resultPattern` case emits a
second assignment from the `data` field when `dataBinding` is set.

`lib/backends/agencyGenerator.ts:1015`. The formatter prints the second
binding when present, so `agency fmt` round-trips it.

`lib/types/typeHints.ts:171`. `ResultType.failureType` renames to
`dataType`. That rename touches 20 non-test sites, listed by
`grep -rn failureType lib --include=*.ts`.

### Type checker

`lib/typeChecker/resultUnion.ts:33`. The `error` property becomes
`STRING_T`, and a new `data` property carries `rt.dataType`.

`lib/typeChecker/synthesizer.ts:108`. `RESULT_FIELDS` gains `"data"`.
Line 795 synthesizes a `failure` call as
`{ type: "resultType", successType: ANY_T, dataType: D }`, where `D` is
the type of the second argument, or `NULL_T` when there is no second
argument. That `NULL_T` is what makes a declared data type required;
see "Declaring a data type makes it required" above.

A `failure` whose first argument is not a string and not `any` is a
diagnostic. A `failure` whose second argument is not an object type and
not `any` is a diagnostic. Both are new diagnostics in the registry.

The required-data case reaches the user through the existing
return-type assignability error, which would read `Result<any, null> is
not assignable to Result<Policy, ParsePolicyFailure>`. That does not
tell a person what to do, so it needs its own diagnostic: detect a
`dataType` of `null` on the source side against a non-nullable
`dataType` on the target side, and say that the function declares
`ParsePolicyFailure` data, so this `failure` needs a second argument,
or the return type needs `| null`.

`lib/typeChecker/matchExhaustiveness.ts:170` needs no change. A result
pattern's exhaustiveness depends on its `kind`, not its bindings.

### Codegen

`lib/backends/typescriptBuilder.ts:2614`. This is the one spot that
needs care. Inside a function body, the builder appends a third options
object to every `failure` call, carrying the checkpoint, the function
name, and the arguments. It appends it positionally after whatever the
user wrote. Once a user can write two arguments, the emitter has to pad
to a fixed arity:

```ts
const [msg, data] = node.arguments.map((arg) => this.processCallArg(arg));
return ts.call(ts.id("failure"), [msg, data ?? ts.raw("null"), optsNode]);
```

The `null` in the second slot is what a one-argument `failure` emits.
`failure()` turns it into `{}`, so the padding never reaches a reader.

Getting this wrong means a two-argument `failure` silently loses its
checkpoint, which would break resume from inside that function. The
verification section below has a test for it.

`lib/backends/typescriptGenerator/typeToZodSchema.ts:298`. The failure
branch of the generated schema changes `error: z.any()` to
`error: z.string()` and gains `data`.

`lib/backends/typescriptGenerator/typeToString.ts:228` and
`lib/utils/formatType.ts:81`. Both print a `Result` type.
`typeToString.ts:232` shortens `Result<T, string>` to `Result<T>` when
the second parameter is `string`. It now shortens when the second
parameter is `any`.

## Runtime coercion

The type checker cannot see every value. TypeScript code imported into
an Agency program can call `failure` with anything, and a rejected
interrupt's value arrives from a policy file or an HTTP request body.

`failure()` coerces defensively, so a non-string message can never
reach a checkpoint:

```ts
function coerceMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return truncate(error);
}
```

`truncate` already exists at `lib/runtime/truncate.ts` and JSON-encodes
with a length cap. The same applies to `data`: anything that is not a
plain object becomes `{}`.

The coercion is a backstop. A person who writes `failure(42)` in
Agency sees the compiler diagnostic, and never reaches this code.

## Migration

Two PRs.

**PR 1: the shape.** Runtime, parser, type checker, codegen, the ten
producers, and the seven annotations that shrink. Fixtures rebuilt with
`make fixtures`. This PR leaves the two-name pattern out, so
`failure(msg)` is the only pattern form.

**PR 2: the two-name pattern.** Parser, AST, lowering, formatter, and
narrowing for the second binding. Small and separable, because nothing
in PR 1 depends on it.

The test fixtures are the bulk of the work. Forty-five files under
`tests/agency/guards/` and `tests/agency/subprocess/` read fields off
`.error` that move to `.data`. `data` is a sibling of `error` on the
failure, not a field inside it, so that is a mechanical rewrite of
`result.error.maxCost` to `result.data.maxCost` and the same for
`.label`, `.actualCost`, `.maxTime`, `.threshold`, `.reason`, and
`.value`. The type checker catches any that get missed, because
`.error` is now a string and a string has no `maxCost`.

Two agency-js fixtures also read `.error.status`:
`tests/agency-js/policy-parse-file/agent.agency` and its `.js` sibling.

The rule that a declared data type is required may turn up producers I
have not found, in a function whose return type is inferred rather than
declared. Inference merges the data types across return paths
(`lib/typeChecker/inference.ts:135`), so a function with one bare
`failure` and one with data infers `D | null` and stays legal. Only a
declared type can be violated, and there are fourteen of those.

## Docs

`docs/site/guide/error-handling.md` gains a section on the message and
the data argument. Its closing section on the type parameters is
rewritten: the second parameter is the data type, `Result<T>` no longer
means a string failure, and a declared data type has to be supplied.

`docs/site/guide/guards.md:47` currently says the label shows up on
`error.label`. That becomes `error.data.label`, and the example at line
54 changes with it.

Generated stdlib pages come from `make doc`, so the docstrings in
`policy.agency`, `toolbox.agency`, and `thread.agency` are the source
to edit.

A new dev doc at `docs/dev/language/result-failures.md` records the
shape, the coercion rule, the arity padding in the builder, and why the
second type parameter means data. Add its line to the index in
`packages/agency-lang/CLAUDE.md` and to the `agency-language-docs` skill.

## Verification

1. An Agency test that a `failure("msg", { a: 1 })` inside a function
   body still carries a checkpoint, and that resuming from it lands on
   the line after the failure. This is the guard against the arity bug
   in the builder.
2. An Agency test that `result is failure(msg)` binds a string when the
   producer passed data, and that `result is failure(msg, d)` binds
   both.
3. An Agency test that a guard trip's `.error` reads as a sentence
   naming the label and both numbers, and that `.data.maxCost` still
   holds the limit.
4. A type checker test that `failure(42)` is a diagnostic, and that
   `failure("x", [1, 2])` is a diagnostic.
5. A type checker test that a bare `failure(msg)` is a diagnostic in a
   function declared `Result<Policy, ParsePolicyFailure>`, and is
   accepted in one declared `Result<Policy, ParsePolicyFailure | null>`,
   `Result<Policy>`, or `Result`. The diagnostic's text names the second
   argument and the `| null` alternative.
6. An Agency test that `failure("msg").data` is an empty object, and
   that reading a field off it gives null.
7. A parser test that `failure(a, b)` parses with both bindings, that
   `success(a, b)` is a parse error, and that `agency fmt` round-trips
   the two-name form.
8. A runtime test that `failure(new Error("boom"))` from imported
   TypeScript coerces to the message string.
9. An agent test that a rejected tool call reaches the model as a
   sentence. Today the guard-trip case reaches it as JSON.

## Decisions, 2026-09-06

The owner answered the three open questions in this file. Recorded here
and folded into the design above.

1. **A declared data type is required.** A bare `failure(msg)` is a
   compile error in a function declared `Result<T, D>` with a real `D`.
   Write `Result<T, D | null>` to allow both forms. `Result<T>` and bare
   `Result` have `any` data, so a bare `failure(msg)` is fine in either.
   See "Declaring a data type makes it required".

2. **`.data` is `{}` when no data was passed**, never null. A reader can
   write `err.data.status` without checking first.

   These two answers meet in one place. A bare `failure(msg)` is typed
   as `Result<any, null>` so that the assignability check can reject it
   against a declared `D`. Its runtime `.data` is still `{}`. So
   `result.data == null` is never true, and the `null` in `D | null` is
   a permission to omit data rather than a value that comes back. The
   spec picks this and says so where a reader will hit it. If that trap
   bites in practice, the fix is to strip `null` from the data type when
   the checker exposes the `.data` field for reading, so producers see
   `D | null` and readers see `D`.

3. **`Failure<D>` stays.** It is the way to say a function always fails,
   and `D` names its data type.

## What changed during execution, 2026-09-07

Five things the spec and the plan did not anticipate.

1. **`DraftProblem` in `std::toolbox` is a marker, not message-wrapping.**
   The spec said `draftProblem` deletes outright. It does not: the type
   distinguishes a failure the next draft can fix from one it cannot, and
   `oneRound` branches on it. The marker moved into the data as
   `{ retryable: true }`, and `oneRound` now reads it through an `is`
   guard, because a `match` arm does not narrow the scrutinee.

2. **Two more hand-rolled producers.** `stdlib/agency.agency` builds the
   `limit_exceeded` shape by hand in `run()` and in `test()`, mirroring
   `makeLimitFailure`. Both moved their message to the first argument.
   `lib/stdlib/aws/endpoints.ts` has three more `{ message }` failures.

3. **`failure(_)` and `success(_)` in the same `match` now conflict.**
   Both arms bound the name `_`, which used to be `any` on the failure
   side and is now `string`. `stdlib/agents/planner.agency` used that
   pattern; the bare `failure` / `success` forms replace it.

4. **The annotation check has no whole-program walker to hang on.**
   `validateTypeReferences` covers alias bodies and variable declarations
   only, not function signatures. AG2016 is reported from
   `emitAssignabilityError` instead, ahead of AG2015, which is where the
   confusing message would otherwise appear. A `Result<T, string>`
   annotation on a function with no failures is still legal and still
   unusable, which costs nothing.

5. **A plain failure has no checkpoint.** `getResultCheckpoint()` returns
   null unless a checkpoint has been created, so the arity-padding test
   asserts on `functionName` and `args` instead. Those prove the same
   thing: the injected options object reached the third slot.

`make` prints Agency diagnostics without failing, and its incremental
cache skips files it has already compiled. Two diagnostics in
`lib/agents/` (an AG6019 in `policy/agent.agency` and two AG3013s in
`review.agency`) predate this work and are still there.
