# Failure propagation at call boundaries

**Date:** 2026-07-08
**Status:** Approved design, not yet planned or implemented

## The problem

A function can return a failure that the caller forgets to check. The caller then feeds that failure into another function. That function expects a normal value, so it breaks in a confusing way:

```agency
def getReport(id: string): Result {
  return failure("HTTP 404: report not found")
}

def wordCount(text: string): number {
  return text.split(" ").length
}

node main() {
  const report = getReport("abc")   // user forgot to check this
  const count = wordCount(report)   // report is a failure, not a string
}
```

`wordCount` calls `.split()` on a failure object. The user sees "split is not a function". Nothing tells them the real problem is a 404 from `getReport`.

## The fix

Failures become self-propagating values. When a failure flows into a function that does not handle Results, the function body is skipped. The call returns the original failure instead. The pipe operator already short-circuits on failures this way. We are applying its rule to every call.

One asymmetry with pipes is worth stating. Pipes also unwrap successes before calling the next function. This feature adopts only the failure half. A success flowing into a rejecting param still enters the body as a raw Result object. If the body then calls a method on it, the method-call rule below catches the mistake and suggests `.value`.

In the example above, `wordCount` never runs. The call returns the 404 failure. That failure keeps flowing through the program until the user checks it. When they do, they see the original error message and where it came from.

Two related cases get a different treatment. Passing a failure to a plain TypeScript function throws an error. Calling a method on a failure also throws an error. Both errors carry a rich message. Later sections cover both cases.

## Which parameters accept failures

A parameter accepts failures only if the user typed it to say so:

```agency
def a(r: Result) { ... }   // accepts. This function handles Results.
def b(x: any) { ... }      // accepts. Explicit any means "truly anything".
def c(x) { ... }           // REJECTS. Untyped params do not accept failures.
def d(s: string) { ... }   // REJECTS.
```

Unions count. A param typed `string | Result` accepts failures. So does `Result<number, string>`.

Untyped params reject failures on purpose. Most Agency code is untyped. The strict rule catches the failure at the first function it touches. The escape hatch is one annotation: type the param as `Result` or `any`. The error message tells the user exactly that.

## What happens when a failure is rejected

The check runs inside `AgencyFunction.invoke()`, after arguments are resolved. Suppose an argument is a failure and its parameter rejects failures. Then the function body is skipped, and the call returns that failure.

The rules in detail:

- If several arguments are failures, the leftmost one wins.
- Empty default-value slots are skipped. These hold the `UNSET` sentinel.
- Arguments bound earlier via `.partial()` are checked too. The check runs on the merged argument list, so bound values and call-site values are treated the same.
- Each element of a variadic parameter is checked against that parameter's type.
- The check is shallow. A failure inside an array or object passes through. Collecting Results into an array is a legitimate pattern, and deep checks would be slow.

The returned failure is a shallow clone of the original. The clone gains one new entry in its `skippedFunctions` list, described below. Every other field is untouched, so the origin survives.

Each skip also writes a statelog warning event. Statelog has an `error` event today but no warning event, so building one is part of this feature. The event records the skipped function, the parameter, and the original error:

```
warn: call to 'wordCount' skipped: parameter 'text' received a failure
      produced by 'getReport' ("HTTP 404: report not found")
```

So even if the caller drops the return value entirely, the trace still shows what happened.

### How this composes with existing features

- `try foo(f)` returns the failure unchanged. The `try` machinery passes Results through without double-wrapping.
- `foo(f) catch fallback` evaluates the fallback, because `catch` unwraps failures.
- Pipe chains short-circuit before `invoke()` runs, exactly as today.
- The LLM tool loop already reports failure tool-results to the model.

### Handlers

Handlers are safety infrastructure and must never be silently skipped. This feature skips a whole function body, and that body may register handlers. This is safe for the same reason pipe short-circuiting is safe. The function never begins execution. There is no partial run that could raise an effect past an unregistered handler. Semantically, the call never happened.

## The `skippedFunctions` field

We add one field to the failure object in `lib/runtime/result.ts`:

```ts
skippedFunctions: { name: string; param: string }[]
```

`name` is the function that was skipped. `param` is the parameter that rejected the failure. The `failure()` constructor defaults the field to an empty list.

A propagated failure tells the whole story when the user finally inspects it:

```
error: "HTTP 404: report not found"
functionName: "getReport"
skippedFunctions: [ { name: "wordCount", param: "text" } ]
```

The field is plain data, so checkpoints serialize it without special handling.

We chose a typed list of objects over two alternatives. A plain list of strings could not grow extra detail per entry. A generic `metadata` object invites unstructured growth, and every consumer would have to guess what keys it holds. The failure's existing fields are all concrete. Adding another typed field later is cheap, so we lose nothing by staying concrete now.

## Failures into plain TypeScript functions

Plain TypeScript functions have no parameter metadata, so the propagation rule cannot apply to them. Instead, passing a failure to one is always an error. The check lives in `__call` only, so it covers named calls like `formatDate(f)`. Method arguments are never scanned: native prototype methods are plain untagged functions, and `arr.push(someFailure)` must keep working, because collecting Results into an array is the pattern the shallow check exists to protect. When the check fires, the dispatcher throws:

```
Error: 'formatDate' received a failure produced by 'getReport'
       ("HTTP 404: report not found").
       TypeScript functions cannot receive failures. Check the Result
       before passing it, or tag the function with acceptsFailures().
```

The check only sees calls that go through the dispatcher, and one group of functions never does. The compiler keeps a `DIRECT_CALL_FUNCTIONS` list in `nameClassifier.ts`. Calls to those names compile to plain direct calls. The list includes `isSuccess`, `isFailure`, `success`, and `failure`. This is convenient: `isFailure(result)` works untouched, and so does wrapping one failure in another with `failure(f)`. No tagging is needed for any of them on the normal path.

The classifier is name-based, though. Alias one of these functions and the alias routes through the dispatcher:

```agency
const check = isFailure
check(result)   // goes through __call, would throw without a tag
```

Some TypeScript functions must therefore be tagged as failure-tolerant. The runtime exports a tagging helper:

```ts
import { acceptsFailures } from "agency/runtime"

export const myLogger = acceptsFailures((value: unknown) => {
  console.log(value)
})
```

The tag sets a hidden property on the function. The dispatcher checks that one property before throwing. The runtime tags its own failure-tolerant helpers: `isSuccess` and `isFailure` for the alias case above, `_print` and `_printJSON` because `print(someFailure)` must keep working, and whatever else the corpus run surfaces. Users have the same two escape hatches for their own TypeScript code. Tag the function, or wrap it in an Agency function whose param is typed `Result`.

One note on what "throw" means here. Agency wraps every function body in an automatic try. The thrown error is caught there and becomes a failure of the enclosing Agency function. The agent does not crash, and the user can still catch the failure. Its `skippedFunctions` list starts fresh, but its message embeds the original error and origin.

This gives an implementation constraint: the new errors must be plain `Error`, never `AgencyAbort`. The auto-try re-throws `AgencyAbort` untouched, so an abort here would kill the run instead of becoming a catchable failure.

## Method calls on Result objects

Calling a method on a Result throws. Failure objects have no methods a user should call, and neither do successes.

```agency
const report = getReport("abc")     // a failure
report.split(" ")
// Error: called '.split()' on a failure produced by 'getReport'
//        ("HTTP 404: report not found"). Check the Result before using it.
```

The success case gets a hint, because the user probably meant to unwrap:

```agency
const r = divide(10, 2)             // success(5)
r.toFixed(1)
// Error: called '.toFixed()' on a success Result.
//        Did you mean r.value.toFixed(...)?
```

There is one exemption. A success can wrap a function, and `r.value()` must keep working:

```agency
const r = success(myTool)
r.value(arg)      // fine: 'value' is an own field holding a callable
```

So the precise rule is: a method call on a Result throws, unless the property is an own field of the Result and holds a callable. Prototype methods like `.toString()` throw. Native coercion paths such as string interpolation do not go through the dispatcher, so `"${report}"` still works for debugging.

This check lives in `__callMethod`. The sibling check in `__call` covers the case where the call target itself is a failure. The auto-try note from the previous section applies here too. The throw becomes a catchable failure of the enclosing function.

## How it works under the hood

**Codegen.** The compiler knows each parameter's declared type. It stamps a new boolean, `acceptsResult`, onto each param's runtime metadata in `FuncParam`. The existing `isFunctionTyped` flag works exactly this way and is the template. Params built by older or handwritten code lack the flag and default to accepting, so the check fails open. That matches the `isFunctionTyped` precedent.

**Runtime.** Every Agency call goes through one chokepoint: `AgencyFunction.invoke()` in `lib/runtime/agencyFunction.ts`. The constructor precomputes one boolean, `_checksFailures`. It is true when at least one param rejects failures. Functions whose params all accept skip the argument scan entirely. For the rest, `invoke()` scans the resolved arguments with `isFailure()`.

**Dispatcher.** `__call` and `__callMethod` in `lib/runtime/call.ts` gain the TypeScript-function check and the method-call check.

**Stdlib.** An annotation pass. For example, `print(...messages)` in `stdlib/index.agency` has an untyped variadic. Under the new rule, `print(someFailure)` would skip printing. The param gets an `any` annotation. The corpus run will find every stdlib function that needs the same treatment.

## Performance

The happy path pays almost nothing.

Functions whose params all accept failures skip the check entirely, via one precomputed boolean. Most functions do check, since unannotated params reject. For those, checking one argument costs a null check, a `typeof`, and two property reads. That is nanoseconds. For comparison, `invoke()` already does an AsyncLocalStorage read, argument resolution, and promise setup on every call. The new check adds well under 1% on top.

The dispatcher checks add one `isFailure` test each, on an object that is already in hand.

The expensive work happens only when a failure actually propagates. That path clones the failure and writes a statelog event. Failures are rare, so this cost does not matter.

## What this does not catch

1. **Node transitions.** Passing a failure to a graph node, as in `nextNode(report)`, is not checked in v1. Node calls compile through a separate path, `generateNodeCallExpression`, and never touch `AgencyFunction.invoke()`. The fix would live in the graph runner, not in the call machinery this feature touches. Scoped out of v1 deliberately; a follow-up can extend the check to node entry.
2. **Direct-call functions.** Names on the compiler's `DIRECT_CALL_FUNCTIONS` list compile to plain calls that bypass the dispatcher. This is mostly a feature, since the list is exactly the Result-handling builtins, but it is a standing coverage boundary worth knowing about.
3. **Block params.** Trailing blocks and block expressions always accept failures in v1. Blocks iterate arrays that legitimately contain Results, and their params carry no acceptance metadata. Misuse inside a block body is still caught by the method-call rule. This is a deliberate carve-out, not an accident.
4. **Method arguments.** Arguments of method calls are never scanned, only the receiver is checked. Scanning them would break `arr.push(someFailure)` and every other native-prototype call that receives failures.
5. A failure nested inside an array or object passes through. This is deliberate. The check is shallow.
6. A tagged TypeScript function receives failures unchecked. This is deliberate. That is what the tag means.
7. Reading a property on a failure, like `f.someField`, still yields `undefined` silently. The static checker's `strictMemberAccess` covers the typed cases. Runtime property-read checks are out of scope for this feature.

## Rollout

We follow the same playbook as the `matchExhaustiveness` flip, as two PRs.

1. Add a config knob, `failurePropagation`, with values `"off"`, `"warn"`, and `"on"`. In warn mode, every would-be skip or throw logs a statelog warning and echoes to stderr, but the program behaves as it does today. The stderr echo matters: without observability config the statelog event goes nowhere, and warn mode exists to be seen.
2. PR #1 ships the whole mechanism with the default at `"warn"`. Existing programs see zero behavior change. The strict behavior is still tested: unit tests hit it directly, and one agency-js test opts a compiled program into `"on"`.
3. PR #2 flips the default to `"on"`. Its CI run across the corpus, the 121 fixtures and the 841 execution-test programs, is the measurement. Legitimate sites it finds get annotated; if they are widespread, we simply hold PR #2, since main already works in warn mode.
4. Reverting the flip alone turns the strictness off without removing the machinery.

## Testing

Agency execution tests cover the runtime behavior. No LLM calls are needed.

- A failure into a typed param, an untyped param, an explicit `any` param, and a `Result` param.
- A failure bound via `.partial()`.
- A failure as a variadic element.
- Leftmost-wins when two arguments are failures.
- The contents of `skippedFunctions` after two hops.
- `catch` on a propagated failure.
- `try` around a call that propagates.
- A failure into an untagged TypeScript function throws. A tagged one does not.
- A method call on a failure throws, and the message names the producer.
- A method call on a success throws with the `.value` hint. `r.value()` still works when the success wraps a function.
- A statelog assertion for the skip event.

Unit tests in `lib/runtime` cover the `invoke()` scan, the clone-and-append behavior, and `acceptsFailures` tagging.

## Decisions log

- **Strict rule.** Unannotated params reject failures. Explicit `any` opts in. We chose strict over lenient because most Agency code is untyped. Under a lenient rule, failures would slide through every untyped hop and get caught late or never.
- **Propagate the original failure.** The skipped function does not return a new failure of its own. A new failure would hide the origin. Propagation matches pipe semantics. Suggested by the owner.
- **`skippedFunctions` as a typed list of objects.** Chosen over a plain string list, which could not grow per-entry detail. Also chosen over a generic `metadata` field, which invites unstructured growth. The earlier working name `errorStack` was dropped because the list records skipped functions, not a call stack.
- **Failures into plain TypeScript functions always throw.** The exemption is the `acceptsFailures` tag. Suggested by the owner.
- **Method calls on Results always throw.** The exemption is an own field holding a callable, so `r.value()` keeps working.
- **Node transitions are out of scope for v1.** Node calls bypass `invoke()` via a separate emission path, and the fix belongs in the graph runner. Owner decision after spec review, 2026-07-08.
- **No backward-compatibility handling for old checkpoints.** Pre-feature serialized failures lack `skippedFunctions`, and we do not add defaulting logic for them. Owner decision after spec review, 2026-07-08.
- **The TS-function argument scan lives in `__call` only.** Method arguments are never scanned, so `arr.push(someFailure)` keeps working. Plan review finding, 2026-07-09.
- **Block params always fail open in v1.** Their emission sites carry no acceptance metadata, and blocks legitimately iterate Result-bearing arrays. Plan review finding, 2026-07-09.
