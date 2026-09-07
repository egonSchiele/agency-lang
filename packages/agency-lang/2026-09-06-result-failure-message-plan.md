# Result failure messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A failure in Agency always carries a string message, and optionally an object of extra data, so that anything showing a failure to a person or a model can print `.error` and be done.

**Architecture:** `failure()` becomes `failure(message: string, data?: object)`. `ResultFailure` gains a `data: Record<string, any>` field that is `{}` when no data was passed, and its `error` field narrows from `any` to `string`. The second `Result` type parameter stops meaning "the failure type" and starts meaning "the data type", so `Result<Policy, ParsePolicyFailure>` reads as "succeeds with a Policy, or fails with a message plus ParsePolicyFailure data". A function that declares a data type has to supply it on every `failure`, which falls out of the existing covariant Result assignability check once a one-argument `failure` synthesizes as `Result<any, null>`. Ten producers that put an object in `error` move their message to the first argument. Five consumers that guessed how to stringify an error delete that guessing.

**Tech Stack:** TypeScript, vitest, the tarsec parser combinators in `lib/parsers/`, typestache templates in `lib/templates/`, the Agency execution test runner (`agency test`).

**Spec:** `/Users/adityabhargava/agency-lang/packages/agency-lang/2026-09-06-result-failure-message-spec.md` (read the "Decisions, 2026-09-06" section at the end first).

## Global Constraints

- Work in a worktree under `/Users/adityabhargava/agency-lang/`, on branch `adit/failure-messages`. Never commit to main. Never force push or amend. Re-check the branch before every commit.
- Repo rules: no dynamic imports, objects not Maps, arrays not Sets, `type` not `interface`, functions under 150 lines, files under 1250 lines, nesting under 5.
- Templates: only edit `.mustache` files, never the generated `.ts` beside them. Run `pnpm run templates` after editing one.
- `make` after any change to `stdlib/*.agency` or `lib/stdlib/*.ts`. `pnpm run build` is not enough; it skips the stdlib and the agents.
- Save every test run's output to a file under `test-output/` and read it once. Do not rerun a suite to see what failed.
- Run only the tests covering changed files. Do not run the whole agency suite until Task 13. CI runs it on the PR.
- Before pushing: `pnpm run typecheck`, `pnpm run fmt:ts`, `pnpm run lint:structure`, all green.
- Commit messages go in a file, passed with `git commit -F <file>`. Apostrophes on the command line break the command. End every commit message with the two attribution lines from the session instructions.
- Never touch `CHANGELOG.md`. Never hand-edit `docs/site/stdlib/`; `make doc` regenerates those from docstrings.
- Prose (docs, comments, docstrings): plain words, an example where one helps, no comments that narrate the next line. Read `docs/dev/contributing/verbal-tics.md` after drafting anything.
- This is a breaking change to a language with no users. Do not write any backward-compatibility path, migration shim, or `?? []` style fallback for old serialized shapes.

## Background for someone new to this code

**What a Result is.** Agency has no exceptions. A function that can fail returns a `Result`, which at runtime is one of two objects:

```ts
{ __type: "resultType", success: true,  value: any }
{ __type: "resultType", success: false, error: any, checkpoint, neverStarted, destructiveRan, rejected, functionName, args, skippedFunctions }
```

Both live in `lib/runtime/result.ts`. Agency code builds them with `success(v)` and `failure(e)`, reads them with `isSuccess` / `isFailure`, pattern-matches them with `success(v)` / `failure(e)` arms, and unwraps them with `catch` and the pipe operator `|>`.

**Why `error` is typed `any` today.** Nothing ever forced it to be a string. Almost every producer passes one anyway: 290 `failure(...)` calls in `.agency` files and 71 in TypeScript, of which 22 pass an object literal and 2 pass a helper's returned object. The ones that pass an object make the readers guess. `lib/runtime/prompt.ts:192` has a `toolErrorMessage` that JSON-encodes an object error before handing it to the model, so a tool that fails on a guard trip sends the model `{"type":"guardFailure","maxCost":0.3,...}` instead of a sentence.

**Three places `failure()` is called from that are not Agency source.**

1. The **function-body auto-wrap**. Codegen puts a try/catch around every Agency `def`. Its catch calls `failure(...)`. The template is `lib/templates/backends/typescriptGenerator/functionCatchFailure.mustache`.
2. The **interrupt codegen**. A rejected interrupt becomes a failure. Those templates are `interruptReturn.mustache` and `interruptAssignment.mustache`.
3. The **builder's argument injection**, `lib/backends/typescriptBuilder.ts:2614`. Inside a function body, the builder appends an options object to every `failure` call the user wrote, carrying the checkpoint, the function name, and the arguments. It appends it **positionally**. Once a user can write two arguments, this must pad to a fixed arity, or a two-argument `failure` puts the user's data where the options belong and loses its checkpoint. Losing a checkpoint means the program cannot resume from that line.

**How a Result type flows through the compiler.** `lib/types/typeHints.ts:168` declares `ResultType` with `successType` and `failureType`. `lib/parsers/parsers.ts:2306` builds it from source text and handles the sugar (`Result`, `Result<T>`, `Success<T>`, `Failure<E>`). `lib/typeChecker/resultUnion.ts` turns a `ResultType` into a discriminated union of two object types, keyed on `success`, and that union is the single source of truth for what fields a Result has — narrowing and field access both go through it. `lib/typeChecker/assignability.ts:669` compares two Result types covariantly in both parameters.

**How a `failure(e)` pattern binds.** `lib/lowering/patternLowering.ts:1178` turns the binding into a field read: `success(v)` reads `.value`, `failure(e)` reads `.error`. One line. So once `.error` is a string, `failure(e)` binds a string with no further work.

**Where the type checker's diagnostics live.** `lib/typeChecker/diagnostics.ts` is an append-only registry keyed by name, each entry carrying an `AG####` code, a severity, and a message template with `{param}` placeholders. `lib/typeChecker/diagnosticExplanations.ts` carries the longer prose for `agency explain`. Codes are grouped by first digit; `AG2` is "Assignability and checking" and its highest used code is `AG2012`.

**The two test suites that matter here.** Unit tests are `lib/**/*.test.ts`, run with `pnpm test:run`. Agency execution tests are directories of `.agency` files with a sibling `.test.json` naming the node to run and the expected output, run with `pnpm run agency test tests/agency/<dir>`. They need no LLM. Forty-five of them, under `tests/agency/guards/` and `tests/agency/subprocess/`, read fields off `.error` that this change moves to `.data`.

**The order this plan runs in, and why.** Three tasks are pure TypeScript and touch nothing an Agency program can see, so they go first. Then the parser rename, which is invisible because no check depends on it yet. Then one large task that has to be atomic, explained below. Then the diagnostics, which only refuse things the large task already fixed.

**Why one task is large.** Making `.error` a string and adding `.data` breaks three things at once, and no two of them can be separated:

1. Every fixture that reads `result.error.maxCost` stops compiling, because a string has no `maxCost`. Strict member access defaults to `error` (`synthesizer.ts:167`), so this is a hard failure, not a warning.
2. Those fixtures can only be rewritten to `result.data.maxCost` once the checker knows a `data` field exists, which is the same change.
3. The producers have to move at the same moment, because a fixture reading `.data.maxCost` gets null until the producer puts something there.

So the checker change, the Agency-side producers, the annotation shrinks, and every fixture rewrite are one commit. It is large in file count and small in idea: one field moved.

**Where `data` lives.** On the failure object, beside `error`, not inside it:

```ts
{ __type: "resultType", success: false, error: "Guard 'research' exceeded…", data: { maxCost: 0.3 } }
```

So `result.error.maxCost` becomes `result.data.maxCost`. Never `result.error.data.maxCost`.

## File structure

**Runtime, changed:**

- `lib/runtime/result.ts` — the `failure()` signature, the `data` field, the two coercions, and the guard trip's message.
- `lib/runtime/ipc.ts`, `lib/runtime/validateChain.ts` — two producers.
- `lib/runtime/prompt.ts` — deletes `toolErrorMessage`.
- `lib/runtime/interruptResponse.ts` — `reject` takes a string.
- `lib/runtime/llmRetry.ts`, `lib/runtime/failurePropagation.ts` — drop a coercion each.

**Stdlib, changed:**

- `lib/stdlib/http.ts`, `lib/stdlib/aws/{errors,s3,client,credentials}.ts`, `lib/stdlib/objectBytes.ts` — six producers.
- `lib/stdlib/threads.ts`, `lib/stdlib/mcp.ts` — drop a coercion each.
- `stdlib/toolbox.agency`, `stdlib/policy.agency`, `stdlib/agents/agency/coding.agency` — four producers.
- `stdlib/llm.agency` — two annotations.

**Compiler, changed:**

- `lib/types/typeHints.ts`, `lib/parsers/parsers.ts` — the `dataType` rename and the sugar.
- `lib/typeChecker/{resultUnion,synthesizer,assignability,inference,typeWalker,typeKey,valueParamSubstitution,validation,diagnostics,diagnosticExplanations}.ts` — the type side.
- `lib/typeChecker/utils.ts` — the tailored required-data diagnostic.
- `lib/backends/typescriptBuilder.ts`, `lib/backends/typescriptGenerator/{typeToString,typeToZodSchema}.ts`, `lib/utils/formatType.ts` — codegen and printing.
- `lib/templates/backends/typescriptGenerator/{functionCatchFailure,interruptReturn,interruptAssignment}.mustache` — three templates.

**PR 2 only:**

- `lib/types/pattern.ts`, `lib/lowering/patternLowering.ts`, `lib/backends/agencyGenerator.ts`, and `resultPatternParser` in `lib/parsers/parsers.ts`.

**Created:**

- `docs/dev/language/result-failures.md`
- `tests/agency/result/failure-data-default.agency` and its `.test.json`
- `tests/agency/result/failure-with-data-checkpoint.agency` and its `.test.json` (PR 1)
- `tests/agency/result/failure-two-name-pattern.agency` and its `.test.json` (PR 2)

---

# PR 1: the shape

### Task 1: `failure()` takes a message, then data, then options

The signature gains a middle parameter. Fourteen call sites pass options in the second position. Twelve of those carry no user data and move to a two-argument entry point instead, so the positional shape stops being spelled out in mustache templates the compiler cannot check.

**Files:**

- Modify: `lib/runtime/result.ts` (types, `failure`, `runtimeFailure`, the three `__tryCall` calls), `lib/runtime/index.ts:152`
- Modify: `lib/runtime/prompt.ts:1179`, `lib/backends/typescriptBuilder.ts:2614-2626` and `:3132`
- Modify: `lib/templates/backends/typescriptGenerator/{functionCatchFailure,interruptReturn,interruptAssignment,imports}.mustache`
- Test: `lib/runtime/result.test.ts`

**Interfaces:**

- Produces: `failure(error: unknown, data?: Record<string, any> | null, opts?: FailureOpts): ResultFailure` and `runtimeFailure(error: unknown, opts: FailureOpts): ResultFailure`. `ResultFailure` gains `data: Record<string, any>` and narrows `error` to `string`.

- [ ] **Step 1: Write the failing tests**

Add to `lib/runtime/result.test.ts`:

```ts
describe("failure message and data", () => {
  it("keeps a string message and defaults data to an empty object", () => {
    const failed = failure("boom");
    expect(failed.error).toBe("boom");
    expect(failed.data).toEqual({});
  });

  it("keeps the data object it was given", () => {
    expect(failure("boom", { status: 404 }).data).toEqual({ status: 404 });
  });

  it("coerces an Error to its message", () => {
    expect(failure(new Error("thrown")).error).toBe("thrown");
  });

  it("coerces a non-string, non-Error message", () => {
    expect(failure({ a: 1 }).error).toBe('{"a":1}');
  });

  it("coerces data that is not a plain object to an empty object", () => {
    expect(failure("boom", [1, 2] as any).data).toEqual({});
    expect(failure("boom", null).data).toEqual({});
  });

  it("takes options in the third position", () => {
    const failed = failure("boom", null, { functionName: "readFile", rejected: true });
    expect(failed.functionName).toBe("readFile");
    expect(failed.rejected).toBe(true);
    expect(failed.data).toEqual({});
  });

  it("runtimeFailure coerces and leaves data empty", () => {
    const failed = runtimeFailure(new Error("thrown"), { functionName: "readFile" });
    expect(failed.error).toBe("thrown");
    expect(failed.data).toEqual({});
    expect(failed.functionName).toBe("readFile");
  });

  it("carries data through propagateFailure", () => {
    const propagated = propagateFailure(failure("boom", { status: 404 }), {
      name: "wordCount",
      param: "text",
    });
    expect(propagated.data).toEqual({ status: 404 });
    expect(propagated.skippedFunctions).toEqual([{ name: "wordCount", param: "text" }]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:run lib/runtime/result.test.ts > test-output/task1-red.txt 2>&1`
Expected: FAIL.

- [ ] **Step 3: Change the type and the constructor**

In `lib/runtime/result.ts`, add the import and two coercions above `failure`:

```ts
import { truncate } from "./truncate.js";

/** A failure's message is always a string, so anything that shows a failure
 *  can print it. A non-string only reaches here from imported TypeScript or
 *  from a rejected interrupt's value. Agency code that writes `failure(42)`
 *  is refused by the type checker. */
function coerceMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return truncate(error);
}

/** Data is always an object, so a reader can write `err.data.status` without
 *  checking first. */
function coerceData(data: unknown): Record<string, any> {
  const isPlainObject = data != null && typeof data === "object" && !Array.isArray(data);
  if (!isPlainObject) {
    return {};
  }
  return data as Record<string, any>;
}
```

In `ResultFailure`, change `error: any` to `error: string` and add below it:

```ts
/** Extra structured detail, named by the second `Result` type parameter.
 *  `{}` when the producer passed none. Never null: a reader may write
 *  `err.data.status` without checking first. */
data: Record<string, any>;
```

Replace `failure`'s signature and its first two fields:

```ts
export function failure(
  error: unknown,
  data?: Record<string, any> | null,
  opts?: FailureOpts,
): ResultFailure {
  return {
    __type: "resultType",
    success: false,
    error: coerceMessage(error),
    data: coerceData(data),
    checkpoint: opts?.checkpoint ?? null,
```

The rest of the object literal is unchanged. `propagateFailure` needs no change: it spreads the original, so `data` rides along.

`resultValueSchema` at line 46 keeps `error: z.any()`. It is a shape sniff that `__tryCall` and `__catchResult` use to tell a Result from a plain value, and `z.object` is non-strict, so a failure with the new fields still parses. Leave it.

Then add the entry point generated code uses:

```ts
/** The failure a generated program or the runtime itself produces: a thrown
 *  exception converted at a function boundary, a rejected interrupt, a tool
 *  that crashed. None of these carry user data, and most of them are written
 *  from templates the compiler does not check, so they get an entry point with
 *  no positional slot to get wrong. It coerces too, so a caller hands it the
 *  raw error rather than converting one by hand. */
export function runtimeFailure(error: unknown, opts: FailureOpts): ResultFailure {
  return failure(error, null, opts);
}
```

Export it from `lib/runtime/index.ts` beside `failure`, and add it to the generated import list in `lib/templates/backends/typescriptGenerator/imports.mustache:32`.

- [ ] **Step 4: Move the three `__tryCall` sites to the third position**

The two guard-trip conversions pass `null` in the data slot for now; Task 5 replaces their first argument:

```ts
return failure(
  guardFailureData(cause.dimension, cause.limit, cause.spent, cause.label),
  null,
  opts,
);
```

and the same shape around line 261, reading from `guardCause`. The generic catch drops its hand-coercion, because `failure()` does that now:

```ts
return failure(error, null, opts);
```

- [ ] **Step 5: Move the remaining eleven sites onto `runtimeFailure`**

None carry data, and three were converting an `Error` by hand.

`lib/runtime/prompt.ts:1179`:

```ts
toolResult = runtimeFailure(errorMessage, { neverStarted: preExecution });
```

`lib/backends/typescriptBuilder.ts:3132`:

```ts
                `runtimeFailure(__error, { functionName: ${JSON.stringify(nodeName)} })`,
```

`functionCatchFailure.mustache`, the closing `return`:

```
return runtimeFailure(__error, {
  checkpoint: getRuntimeContext().ctx.getResultCheckpoint(),
  destructiveRan: __self.__destructiveRan,
  functionName: {{{functionName}}},
  args: __stack.args,
});
```

The `__errMsg` local above it still feeds the logger and the statelog call, so it stays.

In `interruptReturn.mustache` and `interruptAssignment.mustache`, all eight `failure(...)` calls become `runtimeFailure`:

```
    runner.halt({ messages: __threads(), data: runtimeFailure(__response.value ?? "interrupt rejected", { rejected: true }) });
```

```
    runner.halt(runtimeFailure(__response.value ?? "interrupt rejected", { rejected: true, checkpoint: getRuntimeContext().ctx.getResultCheckpoint() }));
```

Then regenerate: `pnpm run templates`.

- [ ] **Step 6: Pad the builder's argument injection to a fixed arity**

`lib/backends/typescriptBuilder.ts:2614`:

```ts
if (node.functionName === "failure" && this.scopes.current().type === "function") {
  // The options object is injected POSITIONALLY, so the call must always
  // reach it at the same arity. A user-written `failure(msg)` pads the
  // data slot with null, which failure() turns into {}. Without the pad,
  // a two-argument failure would put the user's data where the options
  // belong and lose its checkpoint, which breaks resume from that line.
  const scope = this.scopes.current() as FunctionScope;
  const argNodes: TsNode[] = node.arguments.map((arg) => this.processCallArg(arg));
  const message = argNodes[0] ?? ts.raw("null");
  const data = argNodes[1] ?? ts.raw("null");
  return ts.call(ts.id("failure"), [
    message,
    data,
    ts.raw(
      `{ checkpoint: getRuntimeContext().ctx.getResultCheckpoint(), functionName: ${JSON.stringify(scope.functionName)}, args: __stack.args }`,
    ),
  ]);
}
```

- [ ] **Step 7: Run the unit tests, rebuild, typecheck**

```bash
pnpm test:run lib/runtime/result.test.ts lib/runtime/failurePropagation.test.ts > test-output/task1-green.txt 2>&1
make > test-output/task1-make.txt 2>&1
pnpm run typecheck > test-output/task1-tc.txt 2>&1
```

- [ ] **Step 8: Prove the checkpoint survives a two-argument failure**

Create `tests/agency/result/failure-with-data-checkpoint.agency`:

```
// A two-argument failure inside a def must still carry its checkpoint and
// its functionName. Those ride in the third argument the builder injects,
// so this is the test that the arity padding is right.
def lookup(id: string): Result {
  return failure("no record for ${id}", { id: id })
}

node main() {
  const looked = lookup("abc")
  if (isFailure(looked)) {
    return "${looked.error}|${looked.data.id}|${looked.functionName}|${looked.checkpoint != null}"
  }
  return "unexpected success"
}
```

The return type is bare `Result`, not `Result<string>`, because `.data.id` is only readable once Task 5 lands and this file has to run now. Task 5 tightens it.

Create `tests/agency/result/failure-with-data-checkpoint.test.json`:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "\"no record for abc|abc|lookup|true\"",
      "evaluationCriteria": [{ "type": "exact" }]
    }
  ]
}
```

Run: `pnpm run agency test tests/agency/result/failure-with-data-checkpoint.agency > test-output/task1-agency.txt 2>&1`

- [ ] **Step 9: Commit**

```bash
git add -A
cat > /tmp/msg1.txt <<'MSG'
result: failure(message, data, opts)

A failure now carries a string message and an object of extra data.
The message is coerced, so a non-string arriving from imported
TypeScript becomes a sentence instead of travelling as an object. Data
defaults to an empty object, so a reader can write err.data.x without
checking first.

The options object codegen injects moves to the third position, and
the builder pads the data slot so the call always reaches it at a
fixed arity. Without the pad a two-argument failure would lose its
checkpoint and could not resume.

That positional shape would otherwise be spelled out in three mustache
templates and two raw codegen strings, none of which the compiler
checks. runtimeFailure(error, opts) is what those twelve sites use
instead. It coerces too, which retires three hand-written
Error-to-message conversions.
MSG
git commit -F /tmp/msg1.txt
```

---

### Task 2: Delete the five stringification guesses, and narrow `reject`

**Files:**

- Modify: `lib/runtime/prompt.ts:162-194,1244,1248,1283-1290`, `lib/stdlib/threads.ts:243`, `lib/runtime/failurePropagation.ts:236`, `lib/runtime/llmRetry.ts:336`, `lib/stdlib/mcp.ts:92`, `lib/runtime/interruptResponse.ts:11,18`
- Test: `lib/runtime/prompt.test.ts`

**Interfaces:**

- Produces: `reject(reason?: string): InterruptResponse`. `toolErrorMessage` no longer exists.

- [ ] **Step 1: Delete the test whose subject is going away**

`lib/runtime/prompt.test.ts:123-131` is `describe("toolErrorMessage")`. Delete the block and drop `toolErrorMessage` from the import list at line 15. There is nothing to put in its place here: the behaviour that replaces it is a producer change, covered by Task 5's guard sentence test, and by the deletion itself, which the compiler enforces. Do not write a test whose only job is to pass.

Spec verification item 9 asked for an agent test that a rejected tool call reaches the model as a sentence. That item is covered by Task 5's sentence test plus this deletion, and is not re-tested here.

- [ ] **Step 2: Run the suite to see it fail**

Run: `pnpm test:run lib/runtime/prompt.test.ts > test-output/task2-red.txt 2>&1`
Expected: FAIL — the import names a function that still exists but the deleted block leaves `_internal.toolErrorMessage` unused, and step 3 has not run yet. If it passes, that is fine; the real gate is the typecheck in step 5.

- [ ] **Step 3: Delete `toolErrorMessage`**

`lib/runtime/prompt.ts`. Delete the function and its doc comment at lines 188-194, and its entry in the `_internal` export block. At line 1244: `return recordRejection(toolResult.error);`. At line 1248: `const errorMessage = toolResult.error;`.

At line 1283, the comment says the branch handles a "structured reject value". After this task `reject` takes a string, so rewrite the comment to say the value is the reject reason, and leave `stringifyToolResult` in place for the success branch at 1289, which passes `toolResult.value` and is unrelated.

- [ ] **Step 4: Drop the four remaining coercions**

`lib/stdlib/threads.ts:243` → `error: (result as any).error,`
`lib/runtime/llmRetry.ts:336` → `const error = extracted.error;`
`lib/stdlib/mcp.ts:92` → ``console.warn(`[mcp] server "${server}" unavailable: ${res.error}`);``
`lib/runtime/failurePropagation.ts:236` drops the `truncate(...)` around `.error`.

- [ ] **Step 5: Narrow `reject`**

`lib/runtime/interruptResponse.ts`:

```ts
export type InterruptReject = { type: "reject"; value?: string };

export function reject(reason?: string): InterruptResponse {
  return { type: "reject", value: reason };
}
```

`InterruptApprove` keeps `value?: any`; an approval can carry data the program reads back.

- [ ] **Step 6: Run, typecheck, commit**

```bash
pnpm test:run lib/runtime/prompt.test.ts lib/runtime/toolLoopGuards.test.ts lib/runtime/failurePropagation.test.ts lib/runtime/interruptResolution.test.ts > test-output/task2-green.txt 2>&1
pnpm run typecheck > test-output/task2-tc.txt 2>&1
git add -A
cat > /tmp/msg2.txt <<'MSG'
delete the five places that guessed how to print an error

Each coerced a failure error that might not have been a string. The
tool loop is the one that mattered: a tool that tripped a guard sent
the model JSON instead of a sentence.

reject() now takes a string. Every call site already passed one.
MSG
git commit -F /tmp/msg2.txt
```

---

### Task 3: The six stdlib TypeScript producers

Each already builds a `message` field. It moves to the first argument. Where the object held nothing else, it goes away.

**Files:**

- Modify: `lib/stdlib/http.ts:143`, `lib/stdlib/aws/errors.ts:30`, `lib/stdlib/aws/s3.ts:99,105,117,221`, `lib/stdlib/aws/client.ts:83`, `lib/stdlib/aws/credentials.ts:19`, `lib/stdlib/objectBytes.ts:7`
- Test: `lib/stdlib/aws/errors.test.ts`, `lib/stdlib/aws/s3.test.ts`, `lib/stdlib/http.test.ts`

- [ ] **Step 1: Write the failing tests**

`lib/stdlib/aws/errors.test.ts`:

```ts
it("puts the sentence in error and the wire fields in data", () => {
  const body = "<Error><Code>NoSuchKey</Code><Message>The key does not exist</Message></Error>";
  const failed = s3ErrorToFailure(404, "Not Found", "https://b.s3.amazonaws.com/k", body);
  expect(failed.error).toBe("S3 404 for https://b.s3.amazonaws.com/k: NoSuchKey");
  expect(failed.data.code).toBe("NoSuchKey");
  expect(failed.data.s3Message).toBe("The key does not exist");
  expect(failed.data.status).toBe(404);
});
```

`lib/stdlib/http.test.ts` gets the matching case against `httpStatusFailure`, asserting `failed.error` is `"HTTP 503 Unavailable from https://x/y: nope"` and `failed.data.status` is 503. Match the file's existing helper style for building a `Response`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm test:run lib/stdlib/aws lib/stdlib/http.test.ts > test-output/task3-red.txt 2>&1`

- [ ] **Step 3: Move the message out of the object**

`lib/stdlib/http.ts:143`:

```ts
return failure(message, {
  status: result.status,
  statusText: result.statusText,
  url,
  body: snippet,
});
```

`lib/stdlib/aws/errors.ts:30`:

```ts
return failure(`S3 ${status} for ${url}: ${label}`, {
  status,
  statusText,
  url,
  code,
  s3Message: message,
  body: normalizeSnippet(body),
});
```

The five `{ message }`-only objects lose the object: `s3.ts:99`, `s3.ts:105`, `s3.ts:117`, `s3.ts:221`, `client.ts:83`, `credentials.ts:19`, and `objectBytes.ts:7` each become `failure(<the string they already built>)`.

- [ ] **Step 4: Fix the existing assertions**

`grep -rn "error\.\(message\|code\|status\|s3Message\)" lib/stdlib/aws lib/stdlib/http.test.ts` — each becomes `.error` or `.data.<field>`.

- [ ] **Step 5: Run and commit**

```bash
pnpm test:run lib/stdlib > test-output/task3-green.txt 2>&1
git add -A
cat > /tmp/msg3.txt <<'MSG'
http, aws: the message field becomes the message

These producers already built a message and put it inside the object
they used as the error. It is now the failure message. The wire
details stay in data. Where the object held nothing but the message,
it is gone.
MSG
git commit -F /tmp/msg3.txt
```

---

### Task 4: Rename `failureType` to `dataType`, change the `Result<T>` sugar, and stop naming `string` for validated returns

Nothing checks the data type yet, so this task is invisible at every call site and the build stays green throughout.

**Files:**

- Modify: `lib/types/typeHints.ts:168-173`, `lib/parsers/parsers.ts:2306-2410`
- Modify: `lib/typeChecker/{resultUnion,assignability,valueParamSubstitution,typeWalker,inference,synthesizer,typeKey,validation}.ts`
- Modify: `lib/backends/typescriptGenerator/typeToString.ts:228-234`, `lib/utils/formatType.ts:81-86`
- Test: `lib/parsers/typeHints.test.ts`, `lib/typeChecker/validation.test.ts` (create if absent)

**Interfaces:**

- Produces: `ResultType = { type: "resultType"; successType: VariableType; dataType: VariableType; tags?: Tag[] }`.

- [ ] **Step 1: Write the failing tests**

`lib/parsers/typeHints.test.ts`:

```ts
it("Result<T> leaves the data type open", () => {
  const parsed = resultTypeParser("Result<number>");
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  expect(parsed.result).toMatchObject({
    type: "resultType",
    successType: { type: "primitiveType", value: "number" },
    dataType: { type: "primitiveType", value: "any" },
  });
});

it("Result<T, D> names the data type", () => {
  const parsed = resultTypeParser("Result<number, MyData>");
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  expect(parsed.result).toMatchObject({
    type: "resultType",
    dataType: { type: "typeAliasVariable", aliasName: "MyData" },
  });
});
```

A named type parses to `{ type: "typeAliasVariable", aliasName }`, confirmed with `pnpm run ast`.

For `resultTypeForValidation`, add:

```ts
it("a validated return leaves the data type open", () => {
  const wrapped = resultTypeForValidation({ type: "primitiveType", value: "number" }, true);
  expect(wrapped).toEqual({
    type: "resultType",
    successType: { type: "primitiveType", value: "number" },
    dataType: { type: "primitiveType", value: "any" },
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm test:run lib/parsers lib/typeChecker > test-output/task4-red.txt 2>&1`

- [ ] **Step 3: Rename the field**

`lib/types/typeHints.ts:168`:

```ts
export type ResultType = {
  type: "resultType";
  successType: VariableType;
  /** The failure's structured data, named by the second type parameter. The
   *  failure's MESSAGE is always a string and is not named here. */
  dataType: VariableType;
  tags?: Tag[];
};
```

Then rename every use. `grep -rn "failureType" lib --include=*.ts` lists them. Do not run a blanket `sed`: `WriteFailure`, `ResultFailure`, and `guardFailureData` are unrelated names a loose pattern would hit.

- [ ] **Step 4: Change the sugar**

In `resultTypeParser`, rename the seven `failureType` captures and sets to `dataType`, and change the single-parameter branch at line 2345 from `string` to `any`. The `Failure<D>` branches keep their shape; `Failure<D>` now means "always fails, with `D` data".

- [ ] **Step 5: Stop naming `string` for a validated return**

`lib/typeChecker/validation.ts:19`. A validated return (`def f(): number!`) is wrapped as a Result. That wrapper named `string` as the failure type, which under the new reading claims the failure carries string data — the very annotation Task 6 refuses. Change the constant and the doc comment above it:

```ts
/**
 * Wrap `t` in Result<T, any> when `validated` is true, mirroring the runtime's
 * __validateType wrapping. The data type is left open: a validation failure
 * carries a message and no structured data. An already-Result type passes
 * through without re-wrapping.
 */
```

```ts
    dataType: ANY_T,
```

Import `ANY_T` from `./primitives.js` and drop the now-unused `STRING_T` import if nothing else in the file uses it.

- [ ] **Step 6: Change the two Result printers**

`lib/backends/typescriptGenerator/typeToString.ts:228`:

```ts
  } else if (variableType.type === "resultType") {
    const successText = variableTypeToString(
      variableType.successType,
      typeAliases,
      forFormatting,
      hooks,
    );
    const dataText = variableTypeToString(
      variableType.dataType,
      typeAliases,
      forFormatting,
      hooks,
    );
    if (successText === "any" && dataText === "any") {
      return "Result";
    }
    if (dataText === "any") {
      return `Result<${successText}>`;
    }
    return `Result<${successText}, ${dataText}>`;
  }
```

`lib/utils/formatType.ts:81` gets the same shape with `recurse`.

- [ ] **Step 7: Run everything and commit**

```bash
pnpm test:run > test-output/task4-green.txt 2>&1
make > test-output/task4-make.txt 2>&1
pnpm run typecheck > test-output/task4-tc.txt 2>&1
git add -A
cat > /tmp/msg4.txt <<'MSG'
the second Result type parameter is the data type

Result<T, D> now reads as: succeeds with a T, or fails with a message
plus D of data. The field is renamed to match. Result<T> used to mean a
string failure; it now leaves the data type open, and so does the
wrapper around a validated return.
MSG
git commit -F /tmp/msg4.txt
```

---

### Task 5: `.error` is a string, `.data` is beside it

This is the atomic task. The checker change, the four Agency-visible producers, the annotation shrinks, and every fixture rewrite land together, for the reason given under "Why one task is large".

**Files:**

- Modify: `lib/typeChecker/resultUnion.ts:15-70`, `lib/typeChecker/synthesizer.ts:107-125,793-803`
- Modify: `lib/runtime/result.ts` (`guardFailureMessage`, the two conversion sites), `lib/runtime/ipc.ts:120-141`, `lib/runtime/validateChain.ts:203-222`
- Modify: `stdlib/toolbox.agency`, `stdlib/policy.agency`, `stdlib/agents/agency/coding.agency`, `stdlib/llm.agency:99,212`
- Modify: `lib/agents/agency-agent/lib/repl.agency:306-318`
- Modify: every `.agency` and `.js` fixture under `tests/agency/guards/` and `tests/agency/subprocess/` that reads a field off `.error`, plus `tests/agency-js/policy-parse-file/`, and the four `Result<X, string>` test annotations
- Test: `lib/typeChecker/resultFailureShape.test.ts` (new), `lib/runtime/result.test.ts`, `lib/runtime/ipc.test.ts`

**Interfaces:**

- Produces: on a Result's failure branch, `.error` is `string` and `.data` is the Result's `dataType`. `failure(msg)` synthesizes `Result<any, null>`; `failure(msg, d)` synthesizes `Result<any, typeof d>`. `guardFailureMessage(dimension, limit, spent, label?)` is exported from `lib/runtime/result.ts`.

- [ ] **Step 1: Write the failing tests**

Create `lib/typeChecker/resultFailureShape.test.ts`, reusing the `run`/`check` helpers from `strictMemberAccess.test.ts`:

```ts
describe("the failure branch's shape", () => {
  it("types .error as a string", () => {
    const { errors } = check(`
def f(): Result { return failure("boom") }
def g(): number {
  const outcome = f()
  if (isFailure(outcome)) { return outcome.error }
  return 0
}`);
    expect(errors.join("\n")).toContain("not assignable");
  });

  it("types .data from the second type parameter", () => {
    const { errors } = check(`
type D = { status: string }
def f(): Result<number, D> { return failure("boom", { status: "gone" }) }
def g(): string {
  const outcome = f()
  if (isFailure(outcome)) { return outcome.data.status }
  return ""
}`);
    expect(errors).toEqual([]);
  });
});
```

Add to `lib/runtime/result.test.ts`:

```ts
describe("guard trip messages", () => {
  it("names the label and both numbers for a cost trip", () => {
    expect(guardFailureMessage("cost", 0.3, 0.42, "research")).toBe(
      "Guard 'research' exceeded its cost budget: spent 0.42 of 0.3.",
    );
  });

  it("says which budget without a label", () => {
    expect(guardFailureMessage("time", 60000, 71200)).toBe(
      "Guard exceeded its time budget: ran 71200ms of 60000ms.",
    );
  });
});
```

The spec wrote these as `Cost guard 'research' exceeded: spent $0.42 of a $0.30 budget` and used seconds. The plan drops the dollar sign and keeps milliseconds because formatting the numbers means deciding on precision and unit conversion, and the fields in `data` are already raw. The wording here is the current one.

Add to `lib/runtime/ipc.test.ts`:

```ts
describe("makeLimitFailure", () => {
  it("puts the sentence in error and the numbers in data", () => {
    const failed = makeLimitFailure("stdout", 100, 250);
    expect(failed.error).toBe("Subprocess exceeded stdout limit of 100 (used 250)");
    expect(failed.data).toEqual({
      reason: "limit_exceeded",
      limit: "stdout",
      threshold: 100,
      value: 250,
    });
  });

  it("keeps extras in data", () => {
    expect(makeLimitFailure("memory", 10, 20, { pid: 7 }).data.pid).toBe(7);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm test:run lib/typeChecker/resultFailureShape.test.ts lib/runtime/result.test.ts lib/runtime/ipc.test.ts > test-output/task5-red.txt 2>&1`

- [ ] **Step 3: Change the discriminated-union view**

`lib/typeChecker/resultUnion.ts`, in the failure member:

```ts
          { key: "success", value: bool("false") },
          // The message. Always a string: `failure()` coerces anything else
          // (lib/runtime/result.ts).
          { key: "error", value: STRING_T },
          // Extra structured detail, named by the second type parameter. `{}`
          // at runtime when the producer passed none, so it is never null.
          { key: "data", value: rt.dataType },
          { key: "checkpoint", value: ANY_T },
```

- [ ] **Step 4: Add `data` to the known Result fields and synthesize a `failure` call**

`lib/typeChecker/synthesizer.ts:108`: add `"data"` to `RESULT_FIELDS`. It is failure-only, so `RESULT_BRANCH_FIELDS` picks it up from the existing filter and the comment at line 286 stays true.

Give `failure` its own function above the switch, because the two constructors no longer share a shape and Task 6 adds two diagnostics to it:

```ts
/** The type of a `failure(...)` call. A one-argument failure has NULL data.
 *  That is what makes a declared data type required: null is assignable to
 *  `any` and to `D | null`, and not to a real object type, so the return-type
 *  check rejects a bare failure(msg) in a function that promised D. */
function synthFailureCall(expr: FunctionCall, scope: Scope, ctx: TypeCheckerContext): ResultType {
  const dataArg = expr.arguments[1] === undefined ? undefined : asPositionalArg(expr.arguments[1]);
  return {
    type: "resultType",
    successType: ANY_T,
    dataType: dataArg === undefined ? NULL_T : synthType(dataArg, scope, ctx),
  };
}
```

Then the branch in `synthType` says only which constructor it is:

```ts
if (RESULT_CONSTRUCTORS.has(expr.functionName) && expr.arguments.length >= 1) {
  const inner = asPositionalArg(expr.arguments[0]);
  if (inner) {
    return expr.functionName === "success"
      ? { type: "resultType", successType: synthType(inner, scope, ctx), dataType: ANY_T }
      : synthFailureCall(expr, scope, ctx);
  }
}
```

- [ ] **Step 5: Give the guard trip a sentence**

In `lib/runtime/result.ts`, beside `guardFailureData`:

```ts
/** The sentence a tripped guard reports. The numbers are in the guard's own
 *  unit: dollars for cost, milliseconds for time, matching the fields in
 *  GuardFailureData. */
export function guardFailureMessage(
  dimension: "cost" | "time",
  limit: number,
  spent: number,
  label?: string,
): string {
  const who = label ? `Guard '${label}'` : "Guard";
  if (dimension === "time") {
    return `${who} exceeded its time budget: ran ${spent}ms of ${limit}ms.`;
  }
  return `${who} exceeded its cost budget: spent ${spent} of ${limit}.`;
}
```

Both conversion sites in `__tryCall` become:

```ts
return failure(
  guardFailureMessage(cause.dimension, cause.limit, cause.spent, cause.label),
  guardFailureData(cause.dimension, cause.limit, cause.spent, cause.label),
  opts,
);
```

reading from `guardCause` at the second site.

- [ ] **Step 6: Give the subprocess limit and the validation walk sentences**

`lib/runtime/ipc.ts:132` keeps its `message` local and the stderr line, and returns:

```ts
return failure(message, {
  reason: "limit_exceeded",
  limit,
  threshold,
  value,
  ...extras,
});
```

`lib/runtime/validateChain.ts:204` and `:218` each gain a sentence built from the `reason` and `limit` they already have, keeping those fields in data.

- [ ] **Step 7: The four Agency producers**

`stdlib/toolbox.agency`: delete `draftProblem` and the `DraftProblem` type, and `problemText`. Line 538 becomes `return failure(writeFailure.error)`, line 555 returns `failure(map(errors, \finding -> finding.feedback).join("\n"))`, line 1050 becomes `return failure(assembleErr)`.

`stdlib/policy.agency:462-487`, each of the four gains a message:

```
  if (!exists(name, dir)) {
    return failure("No policy file at ${path}.", { status: "doesnt-exist" })
  }
```

and the read, JSON, and schema cases likewise, interpolating `readResult.error` and `valid.error` into their sentences. `ParsePolicyFailure` at line 438 drops its `error?: string` field; the only reader of that field is the block rewritten below, so nothing else breaks.

`stdlib/policy.agency:545-552` collapses to:

```
      if (loaded.data.status != "doesnt-exist") {
        print(
          "Warning: could not load the policy file: ${loaded.error} Starting from an empty policy."
        )
      }
```

`stdlib/agents/agency/coding.agency:249`:

```
  return failure(outcome.problems.join("\n"), {
    source: outcome.source,
    problems: outcome.problems
  })
```

and line 469's initializer gains `"no attempt made yet"` as its message with the same data shape.

- [ ] **Step 8: The seven annotations**

| File                                                   | Was                      | Becomes          |
| ------------------------------------------------------ | ------------------------ | ---------------- |
| `stdlib/llm.agency:99`                                 | `Result<string, string>` | `Result<string>` |
| `stdlib/llm.agency:212`                                | `Result<number, string>` | `Result<number>` |
| `tests/agency/if-expression.agency:35`                 | `Result<number, string>` | `Result<number>` |
| `tests/agency/recursive-type-validated.agency:7`       | `Result<number, string>` | `Result<number>` |
| `tests/agency/result/result-generic.agency:1`          | `Result<number, string>` | `Result<number>` |
| `tests/agency-js/llm-provider-defaults/agent.agency:5` | `Result<string, string>` | `Result<string>` |

`lib/agents/agency-agent/lib/repl.agency:306` takes `Result<string | null, { error: string }>` and reads `f.error` off the binding. Both collapse: the parameter becomes `Result<string | null>` and line 316 becomes `pushMessage(color.red(formatTurnFailure(f)))`.

- [ ] **Step 9: Rewrite every fixture onto `.data`**

`data` is a sibling of `error`, so `result.error.maxCost` becomes `result.data.maxCost`.

```bash
grep -rln "error\.\(type\|label\|maxCost\|actualCost\|maxTime\|actualTime\)" tests/agency/guards/
grep -rln "error\.\(reason\|limit\|threshold\|value\)" tests/agency/subprocess/
grep -rn "error\.status" tests/agency-js/policy-parse-file/
```

Every hit drops the `.error` segment. The `.test.json` expectations do not change, because the field values are the same. Recompile the `.js` siblings with `make fixtures` rather than hand-editing them.

Also tighten `tests/agency/result/failure-with-data-checkpoint.agency` from bare `Result` to `Result<string>`, now that `.data.id` is readable.

- [ ] **Step 10: Add the guard sentence test**

Create `tests/agency/guards/guard-trip-message.agency`:

```
import { GuardFailureData } from "std::thread"

// The fixtures above prove the data survived. This one proves the message is
// a sentence, which is what a person and a model actually see. The spent
// amount is a synthetic cost from the deterministic provider, so the test
// asserts the part before the colon.
def spend(): Result<string, GuardFailureData> {
  return guard(cost: 0.000001, label: "research") {
    const reply = llm("Reply with: pong")
    return reply
  }
}

node main() {
  const tripped = spend()
  if (isFailure(tripped)) {
    return "${tripped.error.split(":")[0]}|${tripped.data.label}"
  }
  return "did not trip"
}
```

Create `tests/agency/guards/guard-trip-message.test.json`, copying the deterministic block from `guard-in-def.test.json` — without `useTestLLMProvider`, `llmMocks`, and `interruptHandlers`, the fixture calls a real model:

```json
{
  "tests": [
    {
      "nodeName": "main",
      "input": "",
      "expectedOutput": "\"Guard 'research' exceeded its cost budget|research\"",
      "evaluationCriteria": [{ "type": "exact" }],
      "useTestLLMProvider": true,
      "llmMocks": [{ "return": "pong" }],
      "description": "A tripped guard reports a sentence naming the guard and its budget, with the numbers in data.",
      "interruptHandlers": [{ "action": "reject" }]
    }
  ]
}
```

`exact` is the only criterion any `.test.json` in the repo uses, which is why the fixture does the trimming rather than the criterion.

- [ ] **Step 11: Rebuild and run every affected suite**

```bash
make > test-output/task5-make.txt 2>&1
pnpm run typecheck > test-output/task5-tc.txt 2>&1
pnpm test:run > test-output/task5-unit.txt 2>&1
pnpm run agency test tests/agency/guards > test-output/task5-guards.txt 2>&1
pnpm run agency test tests/agency/subprocess > test-output/task5-sub.txt 2>&1
pnpm run agency test tests/agency/result > test-output/task5-result.txt 2>&1
pnpm run agency test js tests/agency-js/policy-parse-file > test-output/task5-js.txt 2>&1
```

Read each output file once.

- [ ] **Step 12: Commit**

```bash
git add -A
cat > /tmp/msg5.txt <<'MSG'
a failure has a string error and a data field beside it

The discriminated-union view of a Result is the single source of truth
for what fields a Result has, so both changes go there. A one-argument
failure synthesizes null data, which is what makes a declared data type
required.

The producers move in the same commit because neither half works
alone. A fixture cannot read .data until the checker knows the field,
and it cannot keep reading .error.maxCost once error is a string.

parsePolicyFile reported a status code and nothing a person could
read, so its caller built a sentence out of the status by hand. It now
returns the sentence and keeps the status in data. draftProblem
wrapped a string in an object and problemText unwrapped it again; both
are gone. A tripped guard reports which guard, which budget, and what
it spent.
MSG
git commit -F /tmp/msg5.txt
```

---

### Task 6: Four diagnostics

Three refuse a bad `failure(...)` call. The fourth refuses an annotation whose data slot is not an object, which is what makes `Result<T, string>` illegal rather than merely unsatisfiable.

**Files:**

- Create: `lib/typeChecker/dataShape.ts`
- Modify: `lib/typeChecker/diagnostics.ts`, `lib/typeChecker/diagnosticExplanations.ts`, `lib/typeChecker/synthesizer.ts`, `lib/typeChecker/utils.ts:183-203`, `lib/typeChecker/validate.ts:85-120`, `lib/typeChecker/builtinGenerics.ts:49`
- Test: `lib/typeChecker/resultFailureShape.test.ts`

**Interfaces:**

- Produces: `isDataShaped(t, aliases)` from `lib/typeChecker/dataShape.ts`; diagnostics `failureMessageNotString` (AG2013), `failureDataNotObject` (AG2014), `failureNeedsData` (AG2015), `resultDataNotObject` (AG2016).

- [ ] **Step 1: Write the failing tests**

Add to `lib/typeChecker/resultFailureShape.test.ts`:

```ts
describe("failure argument diagnostics", () => {
  it("refuses a non-string message", () => {
    const { errors } = check(`def f(): Result { return failure(42) }`);
    expect(errors.join("\n")).toContain("first argument to failure()");
  });

  it("refuses data that is not an object", () => {
    const { errors } = check(`def f(): Result { return failure("boom", [1, 2]) }`);
    expect(errors.join("\n")).toContain("second argument to failure()");
  });

  it("refuses a bare failure in a function that declared a data type", () => {
    const { errors } = check(`
type D = { status: string }
def f(): Result<number, D> { return failure("boom") }`);
    expect(errors.join("\n")).toContain("needs a second argument");
  });

  it("refuses a bare failure through a type alias for the Result", () => {
    const { errors } = check(`
type D = { status: string }
type Outcome = Result<number, D>
def f(): Outcome { return failure("boom") }`);
    expect(errors.join("\n")).toContain("needs a second argument");
  });

  it("accepts a bare failure when the data type includes null", () => {
    const { errors } = check(`
type D = { status: string }
def f(): Result<number, D | null> { return failure("boom") }`);
    expect(errors).toEqual([]);
  });

  it("accepts a bare failure when no data type is declared", () => {
    const { errors } = check(`def f(): Result<number> { return failure("boom") }`);
    expect(errors).toEqual([]);
  });

  it("refuses an annotation whose data slot is not an object", () => {
    const { errors } = check(`def f(): Result<number, string> { return failure("boom") }`);
    expect(errors.join("\n")).toContain("failure data must be an object");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm test:run lib/typeChecker/resultFailureShape.test.ts > test-output/task6-red.txt 2>&1`

- [ ] **Step 3: Extract the shared predicate**

Create `lib/typeChecker/dataShape.ts`:

```ts
import { resolveType } from "./assignability.js";
import { isNullType } from "./builtinGenerics.js";
import { isAnyType } from "./utils.js";
import type { TypeAliasEntry, VariableType } from "../types/typeHints.js";

/** A failure's data has to be an object. `any` passes, a union passes when
 *  every arm does, and `null` passes so `failure("x", null)` and a `D | null`
 *  data type are both writable. */
export function isDataShaped(t: VariableType, aliases: Record<string, TypeAliasEntry>): boolean {
  const resolved = resolveType(t, aliases);
  if (isAnyType(resolved) || isNullType(resolved)) {
    return true;
  }
  if (resolved.type === "unionType") {
    return resolved.types.every((member) => isDataShaped(member, aliases));
  }
  return resolved.type === "objectType";
}
```

Export `isNullType` from `lib/typeChecker/builtinGenerics.ts:49` rather than writing a second copy. `builtinGenerics.ts` imports nothing from `utils.ts` today, so `utils.ts` importing `isNullType` from it introduces no cycle; check that with `grep -n "^import" lib/typeChecker/builtinGenerics.ts` before relying on it.

- [ ] **Step 4: Register the four diagnostics**

`lib/typeChecker/diagnostics.ts`, beside the other `AG2` entries:

```ts
  failureMessageNotString: {
    code: "AG2013",
    severity: "error",
    message:
      "The first argument to failure() is the message shown to a person or a model, so it must be a string. Got '{actual}'.",
  },
  failureDataNotObject: {
    code: "AG2014",
    severity: "error",
    message:
      "The second argument to failure() is its structured data, so it must be an object. Got '{actual}'.",
  },
  failureNeedsData: {
    code: "AG2015",
    severity: "error",
    message:
      "This function declares '{expected}' as its failure data, so failure() needs a second argument. To allow a failure with no data, declare the return type as 'Result<{success}, {expected} | null>'.",
  },
  resultDataNotObject: {
    code: "AG2016",
    severity: "error",
    message:
      "A Result's second type parameter is its failure data, and failure data must be an object. Got '{actual}' ({context}). A failure's message is always a string and is not named in the type.",
  },
```

Add matching entries to `diagnosticExplanations.ts` in the style of `resultBranchFieldAccess`: a paragraph, a `**How to fix:**` line, and an `agency` code block.

- [ ] **Step 5: Push the first two from `synthFailureCall`**

Task 5 put the whole of a `failure` call's typing in one function, so both checks go there:

```ts
function synthFailureCall(expr: FunctionCall, scope: Scope, ctx: TypeCheckerContext): ResultType {
  const aliases = ctx.getTypeAliases();
  const message = asPositionalArg(expr.arguments[0]);
  if (message !== undefined) {
    const messageType = synthType(message, scope, ctx);
    if (!isAnyType(messageType) && !isAssignable(messageType, STRING_T, aliases)) {
      ctx.errors.push(
        diagnostic(
          "failureMessageNotString",
          { actual: formatTypeHint(messageType) },
          expr.loc ?? null,
        ),
      );
    }
  }
  const dataArg = expr.arguments[1] === undefined ? undefined : asPositionalArg(expr.arguments[1]);
  if (dataArg === undefined) {
    return { type: "resultType", successType: ANY_T, dataType: NULL_T };
  }
  const dataType = synthType(dataArg, scope, ctx);
  if (!isDataShaped(dataType, aliases)) {
    ctx.errors.push(
      diagnostic("failureDataNotObject", { actual: formatTypeHint(dataType) }, expr.loc ?? null),
    );
  }
  return { type: "resultType", successType: ANY_T, dataType };
}
```

- [ ] **Step 6: Push the third from the assignability site**

`lib/typeChecker/utils.ts:183`. `emitAssignabilityError` is the single construction site for the generic message, so the tailored one goes in front of it. Name the condition, and resolve the target through `safeResolveType` (already imported at line 6) so a `type Outcome = Result<number, D>` alias reaches the check:

```ts
/** A one-argument `failure(msg)` synthesizes null data (see synthFailureCall).
 *  Reaching an assignability failure with one of these on the source side means
 *  the target declared real data and the failure supplied none. */
function isBareFailureResult(t: VariableType): boolean {
  return t.type === "resultType" && isNullType(t.dataType);
}
```

and inside `emitAssignabilityError`, after the two early returns:

```ts
const resolvedExpected = safeResolveType(expected, ctx.getTypeAliases());
if (isBareFailureResult(actual) && resolvedExpected.type === "resultType") {
  ctx.errors.push(
    diagnostic(
      "failureNeedsData",
      {
        expected: formatTypeHint(resolvedExpected.dataType),
        success: formatTypeHint(resolvedExpected.successType),
      },
      loc ?? null,
    ),
  );
  return;
}
```

Check `safeResolveType`'s exact name and arity in `utils.ts`'s import block before writing this.

- [ ] **Step 7: Push the fourth from the annotation walker**

`lib/typeChecker/validate.ts:85`. `validateTypeReferences` already walks every annotation with `visitTypes` and has the aliases and the error list. Add a second arm inside that visitor:

```ts
if (t.type === "resultType" && !isDataShaped(t.dataType, typeAliases)) {
  errors.push(
    diagnostic("resultDataNotObject", { actual: formatTypeHint(t.dataType), context }, loc ?? null),
  );
}
```

This is what makes `Result<number, string>` illegal. Without it the annotation stays legal and unsatisfiable: no `failure()` can produce string data, so every failure in such a function would report AG2015 telling the author to pass string data, which is not advice anyone can act on.

- [ ] **Step 8: Run everything and commit**

```bash
pnpm test:run lib/typeChecker > test-output/task6-green.txt 2>&1
make > test-output/task6-make.txt 2>&1
pnpm run agency test tests/agency/result > test-output/task6-agency.txt 2>&1
git add -A
cat > /tmp/msg6.txt <<'MSG'
four diagnostics for the failure message and its data

AG2013 and AG2014 refuse a message that is not a string and data that
is not an object. AG2016 refuses the same thing in a type annotation,
which is what makes Result<T, string> illegal rather than merely
impossible to satisfy.

AG2015 is the interesting one. A bare failure(msg) synthesizes null
data, so the covariant Result check already rejected it against a
declared data type. What it said was that Result<any, null> is not
assignable to Result<Policy, ParsePolicyFailure>, which does not tell
anyone what to do. AG2015 names the second argument and the | null
alternative instead.
MSG
git commit -F /tmp/msg6.txt
```

---

### Task 7: The generated Zod schema for a Result

**Files:**

- Modify: `lib/backends/typescriptGenerator/typeToZodSchema.ts:283-300`
- Test: `lib/backends/typescriptGenerator/typeToZodSchema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("validates a failure's error as a string and carries data", () => {
  const schema = mapTypeToValidationSchema(
    { type: "resultType", successType: NUMBER_T, dataType: ANY_T },
    {},
  );
  expect(schema).toContain("error: z.string()");
  expect(schema).toContain("data:");
});
```

Match the import style the file's existing tests use.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:run lib/backends/typescriptGenerator/typeToZodSchema.test.ts > test-output/task7-red.txt 2>&1`

- [ ] **Step 3: Change the generated schema**

```ts
const dataSchema = mapTypeToValidationSchema((vt as any).dataType, ta, typeAliasesFull);
return `z.union([z.object({ __type: z.literal("resultType"), success: z.literal(true), value: ${successSchema} }), z.object({ __type: z.literal("resultType"), success: z.literal(false), error: z.string(), data: ${dataSchema} })])`;
```

Update the doc comment at line 285 to describe the new failure shape.

A `Result<T, D | null>` generates `data: z.union([<D>, z.null()])`, and the runtime value when no data was passed is `{}`, which matches neither arm if `D` has required fields. That only bites when such a Result is itself validated, through a `!` return or structured output. Record it in the dev doc rather than widening the schema here; widening would stop the schema from checking `D` at all.

- [ ] **Step 4: Run, rebuild fixtures, review the diff, commit**

```bash
pnpm test:run lib/backends > test-output/task7-green.txt 2>&1
make fixtures > test-output/task7-fixtures.txt 2>&1
git diff --stat tests/typescriptGenerator
```

Read a few changed files. Every change should be the new Zod failure branch or the new `failure(msg, null, opts)` arity from Task 1.

```bash
git add -A
cat > /tmp/msg7.txt <<'MSG'
codegen: the generated Result schema knows the new failure shape

Structured-output validation builds a Zod schema from a type. Its
failure branch said error was anything and did not know about data.
MSG
git commit -F /tmp/msg7.txt
```

---

### Task 8: Documentation

**Files:**

- Modify: `docs/site/guide/error-handling.md`, `docs/site/guide/guards.md`, `stdlib/thread.agency:270`
- Create: `docs/dev/language/result-failures.md`
- Modify: `packages/agency-lang/CLAUDE.md`, the `agency-language-docs` skill

- [ ] **Step 1: Rewrite the error-handling guide's failure sections**

After the `divide` example, add the message-and-data pair:

````markdown
A failure always carries a string message. It can also carry an object of
extra detail:

```ts
def parseConfig(path: string): Result {
  return failure("Bad syntax in ${path}", { line: 4, column: 12 })
}
```

Read the message with `.error` and the detail with `.data`:

```ts
const result = parseConfig("app.json")
if (result is failure(msg)) {
  print("${msg} (line ${result.data.line})")
}
```

`.data` is an empty object when the producer passed none, so reading a field
off it gives null rather than an error.
````

Then rewrite the closing "`Result` type parameters" section: the second parameter is the data type and must be an object, `Result<T>` no longer means a string failure, and a declared data type has to be supplied on every failure unless the type includes `null`. Use the `Result<Config, ParseFailure | null>` example from the spec.

- [ ] **Step 2: Fix the guards guide**

Line 20's `printJSON(error)` becomes `print(error)`, since `error` is now the sentence and the example below it already shows the fields. Line 47 says the label shows up on `error.label`; it shows up on `data.label`, and the message names it too. Line 54 becomes `print(result.data.label)`.

- [ ] **Step 3: Say what `GuardFailureData` now describes**

`stdlib/thread.agency:270` keeps every field. Add a doc comment saying it is the failure's `data`, since that name appears in the generated stdlib reference and in two fixtures.

- [ ] **Step 4: Write the dev doc**

`docs/dev/language/result-failures.md`, in this order: the runtime shape of a failure and why `data` is `{}` rather than null; the two coercions and why they are a backstop rather than the boundary; `runtimeFailure` and the arity padding in `typescriptBuilder.ts`, and what breaks without them; why the second type parameter is the data type and why it must be an object; how the required-data rule falls out of covariant assignability plus a `null` synthesis, and where AG2015 and AG2016 are pushed; that `.data == null` is never true at runtime, so `| null` is a permission to omit; and the `Result<T, D | null>` Zod gap from Task 7.

- [ ] **Step 5: Index it, regenerate stdlib pages, tics pass**

Add the doc's line to `packages/agency-lang/CLAUDE.md` under "Language semantics and syntax features" and to the `agency-language-docs` skill. Run `make doc`. Then read `docs/dev/contributing/verbal-tics.md` and reread everything written here against it.

- [ ] **Step 6: Commit**

```bash
git add -A
cat > /tmp/msg8.txt <<'MSG'
docs: the failure message and the data type parameter

The error-handling guide gains the data argument and a rewritten
section on the type parameters. The guards guide points at data.label.
A dev note records the arity padding and the required-data rule, which
are the two things easy to break later.
MSG
git commit -F /tmp/msg8.txt
```

---

### Task 9: Verify and open the PR

- [ ] **Step 1: Add the runtime-default agency test**

`tests/agency/result/failure-data-default.agency`:

```
def noData(): Result {
  return failure("plain")
}

node main() {
  const plain = noData()
  if (isFailure(plain)) {
    return "${plain.error}|${plain.data.anything == null}"
  }
  return "unexpected success"
}
```

with `expectedOutput` of `"plain|true"` and an `exact` criterion.

- [ ] **Step 2: Run the repo-wide guards**

```bash
make > test-output/final-make.txt 2>&1
pnpm run typecheck > test-output/final-tc.txt 2>&1
pnpm run fmt:ts
pnpm run lint:structure > test-output/final-lint.txt 2>&1
pnpm test:run > test-output/final-unit.txt 2>&1
pnpm run agency test tests/agency/result > test-output/final-result.txt 2>&1
pnpm run agency test tests/agency/guards > test-output/final-guards.txt 2>&1
pnpm run agency test tests/agency/subprocess > test-output/final-sub.txt 2>&1
```

Read each once. Do not run the full agency suite locally; CI does.

- [ ] **Step 3: Audit and shrink**

Read `docs/dev/contributing/anti-patterns.md` and `docs/dev/contributing/verbal-tics.md`, then read the whole diff against both. Then reread asking what can come out.

- [ ] **Step 4: Push and open the PR, then stop**

The owner merges.

---

# PR 2: the two-name pattern

Base this on the merged PR 1, on a new branch.

### Task 10: The parser accepts a second binding

**Files:** `lib/parsers/parsers.ts:7474-7524`, `lib/types/pattern.ts:60-64`, `lib/parsers/pattern.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it("parses `failure(msg, info)` with both bindings", () => {
  const result = matchPatternParser("failure(msg, info)");
  expect(result.success).toBe(true);
  if (!result.success) return;
  expect(result.result).toMatchObject({
    type: "resultPattern",
    kind: "failure",
    binding: "msg",
    dataBinding: "info",
  });
});

it("leaves dataBinding null for the one-name form", () => {
  const result = matchPatternParser("failure(msg)");
  expect(result.success).toBe(true);
  if (!result.success) return;
  expect(result.result).toMatchObject({ binding: "msg", dataBinding: null });
});

it("refuses a second binding on success", () => {
  expect(() => matchPatternParser("success(a, b)")).toThrow(/only `failure`/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm test:run lib/parsers/pattern.test.ts > test-output/task10-red.txt 2>&1`

- [ ] **Step 3: Add `dataBinding` to the AST**

```ts
export type ResultPattern = BaseNode & {
  type: "resultPattern";
  kind: "success" | "failure";
  binding: string | null; // null = bare form (no parens), string = binding identifier
  /** The second binding in `failure(msg, data)`, which reads the failure's
   *  `data` field. Always null for `success`, which has one binding. */
  dataBinding: string | null;
};
```

- [ ] **Step 4: Parse the optional second identifier**

Add `dataBinding` to `ResultPatternBase`, return `dataBinding: null` from the bare branch, and replace the committed binding parse:

```ts
const bindingResult = parseError(
  `expected an identifier in result pattern binding (e.g. \`${kind}(name)\`, or \`failure(message, data)\`); empty parens and non-identifier expressions are not allowed`,
  char("("),
  optionalSpacesOrNewline,
  capture(variableNameParser, "binding"),
  optional(
    seqC(
      optionalSpacesOrNewline,
      char(","),
      optionalSpacesOrNewline,
      capture(variableNameParser, "dataBinding"),
    ),
  ),
  optionalSpacesOrNewline,
  char(")"),
)(kwResult.rest);
if (!bindingResult.success) return bindingResult;
const dataName = (bindingResult.result.dataBinding as { value: string } | undefined)?.value;
if (dataName !== undefined && kind === "success") {
  return parseError(
    "a second binding is only `failure`'s: it binds the message and then the data",
    fail("second binding on success"),
  )(input) as ParserResult<ResultPatternBase>;
}
return success(
  {
    type: "resultPattern",
    kind,
    binding: (bindingResult.result.binding as { value: string }).value,
    dataBinding: dataName ?? null,
  },
  bindingResult.rest,
);
```

A `success(a, b)` is already committed to the result-pattern form and cannot fall through to `variableNameParser`, so it throws rather than soft-failing, which is what the test expects. `optional` is imported at line 64 and used at line 343. Confirm `parseError`'s arity for a single wrapped parser before writing the refusal; if it does not take one, push the check after the parse and throw the same message directly.

- [ ] **Step 5: Fix every construction site, run, commit**

`pnpm run typecheck` lists the object literals that now need `dataBinding`.

```bash
pnpm test:run lib/parsers > test-output/task10-green.txt 2>&1
git add -A && git commit -F /tmp/msg10.txt
```

---

### Task 11: Bind the second name, and print it back out

**Files:** `lib/lowering/patternLowering.ts:1176-1180`, `lib/backends/agencyGenerator.ts:1015-1018`, `lib/backends/agencyGenerator.test.ts`, `tests/agency/result/failure-two-name-pattern.agency`

- [ ] **Step 1: Write the failing formatter test**

Assert a round-trip of a `match` containing `failure(msg, info)` keeps both names. Use the round-trip helper the neighbouring tests in that file use.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:run lib/backends/agencyGenerator.test.ts > test-output/task11-red.txt 2>&1`

- [ ] **Step 3: Emit the second binding in lowering**

```ts
      case "resultPattern": {
        // A pattern binds up to two names, each from a field: the value or the
        // message, then the data. The bare form binds neither. `flatMap` drops
        // the ones that are absent, the way the arrayPattern case above does.
        const valueField = pattern.kind === "success" ? "value" : "error";
        const bound = [
          { name: pattern.binding, field: valueField },
          { name: pattern.dataBinding, field: "data" },
        ];
        return bound.flatMap(({ name, field }) =>
          name === null ? [] : [makeAssign(name, fieldAccess(source, field, loc), declKind, loc)],
        );
      }
```

This also retires the `if (pattern.binding === null) return []` early return: the bare form has both names null, so `flatMap` already returns nothing.

- [ ] **Step 4: Print it in the formatter**

```ts
      case "resultPattern": {
        const rp = pattern as ResultPattern;
        const names = [rp.binding, rp.dataBinding].filter((name) => name !== null);
        if (names.length === 0) {
          return rp.kind;
        }
        return `${rp.kind}(${names.join(", ")})`;
      }
```

- [ ] **Step 5: Write the execution test**

`tests/agency/result/failure-two-name-pattern.agency` covers both positions a result pattern appears in, a `match` arm and the right-hand side of `is`:

```
def lookup(id: string): Result {
  return failure("no record for ${id}", { id: id, code: 404 })
}

node main() {
  const looked = lookup("abc")
  const fromMatch = match (looked) {
    success(found) => found
    failure(msg, info) => "${msg}/${info.code}"
  }
  let fromIs = ""
  if (looked is failure(msg2, info2)) {
    fromIs = "${msg2}/${info2.id}"
  }
  return "${fromMatch}|${fromIs}"
}
```

with `expectedOutput` of `"no record for abc/404|no record for abc/abc"` and an `exact` criterion.

- [ ] **Step 6: Run everything and commit**

```bash
pnpm test:run lib/backends lib/lowering > test-output/task11-green.txt 2>&1
make > test-output/task11-make.txt 2>&1
pnpm run agency test tests/agency/result > test-output/task11-agency.txt 2>&1
git add -A && git commit -F /tmp/msg11.txt
```

---

### Task 12: Document the pattern, verify, open PR 2

- [ ] **Step 1: Add the form to the guide**

`docs/site/guide/error-handling.md` gains the two-name example in the section Task 8 added, `docs/site/guide/pattern-matching.md` gains it wherever it lists result patterns, and `docs/dev/language/result-failures.md` records it.

- [ ] **Step 2: Run the repo-wide guards**

Same list as Task 9 step 2.

- [ ] **Step 3: Audit, shrink, push, open the PR, stop**
