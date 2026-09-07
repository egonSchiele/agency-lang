# The `Result` failure

Every failure in Agency carries a string message, and optionally an object
of extra data.

## The shape

`lib/runtime/result.ts`:

```ts
{
  __type: "resultType",
  success: false,
  error: "Guard 'research' exceeded its cost budget: spent 0.42 of 0.3.",
  data: { type: "guardFailure", maxCost: 0.3, actualCost: 0.42 },
  checkpoint, neverStarted, destructiveRan, rejected, functionName, args,
  skippedFunctions,
}
```

`data` sits beside `error`, not inside it. So a reader writes
`result.data.maxCost`, never `result.error.data.maxCost`.

`data` is `{}` when the producer passed none, never null. That is so a
reader can write `err.data.status` without checking first: a missing field
reads as null the way any missing field does. The cost is that
`result.data == null` is never true, which matters for the `| null` data
type below.

## The two coercions

`failure()` coerces its message with `coerceMessage` and its data with
`coerceData`. Anything that is not a string becomes one; anything that is
not a plain object becomes `{}`. Dropping data that was passed is worth
knowing about, so `coerceData` warns (a `failureData` statelog event and a
payload-free console line) when it drops an array or a primitive. Absent
data is the normal one-argument call and is silent.

These are a backstop, not the boundary. A person who writes `failure(42)`
in Agency sees diagnostic AG2013 and never reaches this code. The coercion
exists because two callers are outside the type checker's view: imported
TypeScript, and a rejected interrupt's value.

There is a third way in that does not go through `failure()` at all.
Imported TypeScript can hand back a Result-shaped object it built by hand,
with an object error and no `data` field. `normalizeForeignResult` restores
both fields at every place such a value crosses into Agency: `__tryCall`,
the plain-callable branch of `__call`, and `AgencyFunction.invoke`, whose
`_fn` may be a TypeScript function. A well-formed failure is returned
unchanged, by identity. Without the last two, a tool written in TypeScript
would reach the tool loop with an object error and the model would read
`Error: [object Object]`.

## `runtimeFailure`, and the arity that codegen depends on

Codegen calls `failure()` from three mustache templates and two raw strings
inside the TypeScript builder. None of those are typechecked: they are text
that becomes source later. The twelve of those calls that carry no user data
go through `runtimeFailure(error, opts)` instead, which keeps the
three-argument positional shape in one place a compiler can see.

The builder at `lib/backends/typescriptBuilder.ts:2614` injects an options
object carrying the checkpoint, the function name, and the call's
arguments, and it injects it by position. A user-written
`failure(msg)` must therefore be padded with a `null` data argument so the
options always land in the third slot. Without the pad, a two-argument
`failure(msg, data)` puts the user's data where the options belong, the
failure loses its checkpoint, and the program cannot resume from that line.
`tests/agency/result/failure-with-data-args.agency` is the test for this.

A splat has the same problem and cannot be padded around, because its width
is unknown at compile time: `failure(...args)` would emit
`failure(...args, null, opts)`, and with two elements in `args` the padding
lands in the options slot. A splatted `failure` is refused (AG2017), and the
builder throws rather than emitting one.

## Why the second type parameter is the data type

`Result<T, D>` reads as: succeeds with a `T`, or fails with a message plus
`D` of data. The message is always a string and is never named in the type.

`D` must be an object. `Result<T, string>` is refused (AG2016), because no
`failure()` call can produce string data. `Result<T>` and bare `Result`
leave `D` as `any`, and so does the wrapper around a validated return
(`resultTypeForValidation`) — a validation failure carries a message and no
structured data.

## Why a declared data type is required

A function that declares `Result<Policy, ParsePolicyFailure>` and then
returns a bare `failure(msg)` is a compile error. Otherwise the type says
the data is there when it is not.

A one-argument `failure` synthesizes as `Result<any, null>`
(`synthFailureCall` in `synthesizer.ts`), and the Result branch of
`isAssignable` is covariant in both parameters, so `null` is assignable to
`any` and to `D | null` and not to a real object type. That is the whole
mechanism.

The generic message for it reads "Result<any, null> is not assignable to
Result<Policy, ParsePolicyFailure>", which does not tell anyone what to do,
so `emitAssignabilityError` in `lib/typeChecker/utils.ts` intercepts that
case and reports AG2015 instead, naming the second argument and the
`| null` alternative. It resolves the target type first, so an alias for
the Result reaches the check. It fires only when the expression being
checked is a `failure(...)` call. A call to a function declared
`Result<T, null>`, or a variable holding one, has no second argument to
add, so it keeps the generic message.

AG2016, for a declared data type that is not an object, is reported where
the type is written: alias bodies and `let`/`const` hints through
`validateTypeReferences`, and function parameters and return types in
`buildDefScope` (`validateResultDataTypes` in `validate.ts`). When a
failure then fails to match such an annotation, `emitAssignabilityError`
says nothing more, since the annotation is the problem and it has already
been named once.

## `| null` is a permission, not a value

`Result<T, D | null>` means the producer may omit the data. It does not
mean `.data` can come back null: at runtime it is always `{}`. So the
reader-facing type of `.data` is `D` alone (`readerDataType` in
`resultUnion.ts` strips the null), and `result.data.line` typechecks
without a null check. Code that wants to tell the omitted case from the
supplied one tests a field of the data, not the data itself. A data type
that is only `null` reads as an empty object.

This is also why the generated Zod schema checks only that `data` is an
object, never its shape. A `Result<T, D | null>` that is itself validated (a
`!` return, or structured output) can hold `{}`, which no schema for a real
`D` matches. Checking the shape there would reject the bare `failure(msg)`
that `| null` exists to permit. What the data holds is settled statically by
AG2014 through AG2016 instead.

## Files

- `lib/runtime/result.ts` — the shape, both coercions, `runtimeFailure`,
  `guardFailureMessage`.
- `lib/typeChecker/resultUnion.ts` — the discriminated-union view, which is
  the single source of truth for what fields a Result has.
- `lib/typeChecker/synthesizer.ts` — `synthFailureCall`, AG2013, AG2014.
- `lib/typeChecker/utils.ts` — AG2015.
- `lib/typeChecker/validate.ts` — AG2016 (`validateResultDataTypes`).
- `lib/typeChecker/dataShape.ts` — `isDataShaped`, shared by the two above.
- `lib/backends/typescriptBuilder.ts:2614` — the arity padding and the splat
  guard.
- `lib/typeChecker/builtins.ts` — `reject`'s signature. Generated modules
  define their own `reject` from `imports.mustache`, so that constructor has
  to agree with this signature and with `lib/runtime/interruptResponse.ts`.
