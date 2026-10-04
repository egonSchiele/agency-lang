# TypeScript helpers that use `agency.*` after an `await`

**Status:** the issue is real and is in the code today. The solution is
proposed. It is not built or tested.

## Background

Agency does not use Node's `AsyncLocalStorage`. The runtime keeps its context
with `PromiseContextStorage`, which only works in code whose `await`s a build
step rewrote into `.then` calls. `docs/dev/runtime/running-without-node.md`
records that decision. `docs/dev/runtime/promise-context-storage.md` explains
the mechanism.

That decision costs something for one kind of TypeScript code. This doc
describes the cost and proposes a fix.

## Two kinds of TypeScript function

Agency code can import and call a TypeScript function. There are two kinds,
and only the second is affected.

**A function that returns a value.**

```ts
// db.ts
export async function findUser(id: string) {
  return await db.users.get(id);
}
```

```agency
import { findUser } from "./db.js"

node main(id: string) {
  const user = findUser(id)
  print(user.name)
}
```

This is how an Agency program uses a database, an API, or a library. It is
not affected. `findUser` can use `async` and `await` freely, in a `.ts` or a
`.js` file, under any command.

**A function that takes part in the run.**

```ts
import { agency } from "agency-lang/runtime";

export async function summarize(text: string) {
  const draft = await agency.llm(`Summarize: ${text}`);
  return agency.llm(`Tighten this: ${draft}`);
}
```

This function uses the `agency.*` functions that
`docs/site/guide/ts-helpers.md` describes. It makes model calls. Other
functions of this kind take checkpoints, raise interrupts, or add to the
thread. This is the kind the issue is about.

TypeScript that calls an exported node, such as an app that runs an agent, is
also not affected. Each call to a node sets up its own context.

## The issue

In the `summarize` example, the first `agency.llm` call works and the second
one can fail.

`agency.*` finds its run through the current context. When Agency calls the
helper, the context is set. After a real `await`, the helper wakes up with an
empty context, and the next `agency.*` call throws:

```
getRuntimeContext() called outside an Agency execution frame.
```

The same happens when a helper awaits something and then calls an Agency
function it was handed.

Whether a helper hits this depends on who built its file.

| How the helper is built | `agency.*` after an `await` |
| --- | --- |
| A `.ts` file, under `agency run`, `agency debug`, `agency test`, or `agency eval` | Works. Agency builds the file and rewrites it. |
| A `.ts` file, under `agency serve` or `agency pack` | Fails. esbuild bundles the file and does not rewrite it. |
| A `.ts` file, with `agency compile` | Fails, unless the user's build uses `"target": "ES2016"` or lower. |
| A `.ts` file, under `agency test js` | Same as `agency compile`. |
| A hand-written `.js` file, under any command | Fails. |
| Any of the above, when a `helper.js` already sits beside `helper.ts` | Agency uses the existing `.js` as it is. |

So the same helper can work under `agency run` and fail under `agency serve`.
A user cannot be expected to track this table. Without a fix, the only safe
advice is to never use `agency.*` after an `await`, and that removes most of
what this kind of helper is for.

### What was checked

- A `.ts` helper under `agency run` reads `agency.ctx()` after an `await`.
  Tested by hand.
- The same helper as a hand-written `.js` file throws the error above. Tested
  by hand.
- `tests/agency-js/agent-session-resume` has a `.js` helper that called an
  Agency callback after an `await`. It failed until the helper was changed to
  chain with `.then`.
- The rows for `agency serve`, `agency pack`, `agency compile`, and
  `agency test js` come from reading `lib/importStrategy.ts`,
  `lib/cli/serve.ts`, and `lib/cli/pack.ts`. They were not tested.
- A `--ts` build with a target of ES2016 ran a small program correctly. That
  program had no helper.

### What a user can do today

1. Call `agency.*` before the helper's first `await`.
2. Chain with `.then` in place of `await`:

```js
export function summarize(text) {
  return agency
    .llm(`Summarize: ${text}`)
    .then((draft) => agency.llm(`Tighten this: ${draft}`));
}
```

Both work in any file. Neither is something a user would guess.

## Proposed solution: a handle

```ts
export async function summarize(text: string) {
  const run = agency.current();
  const draft = await run.llm(`Summarize: ${text}`);
  return run.llm(`Tighten this: ${draft}`);
}
```

`agency.current()` returns a handle. The handle has the same functions as
`agency`. The helper calls it once, before its first `await`, and uses the
handle from then on.

The rule for a user is one sentence: in a helper that awaits, call
`agency.current()` first and use what it returns.

### Why it works

`agency.current()` reads the current context while it is still set, and keeps
it inside the handle. Each function on the handle does three things:

1. Puts the saved context back.
2. Calls the normal function, such as `agency.llm`.
3. Restores what was there before.

So `run.llm()` starts in the right context however many `await`s came before
it. The model call itself runs inside the runtime, which is rewritten, so the
context holds for the rest of that call.

The handle does not depend on how the helper's file was built. It works in
`.ts` and `.js`, under every command, with any build. It behaves the same on
Node and in a browser, so it adds no branch between the targets.

### How to build it

The runtime already has the operation. `bindToCurrentFrame` in
`lib/runtime/promiseContextStorage.ts` wraps a function so it runs in the
frame that was current when it was wrapped.

1. Add `captureFrame()` beside `bindToCurrentFrame`. It returns a function
   that runs any callback inside the captured frame.
2. In `lib/runtime/agency.ts`, move the namespace's functions into one object.
   Add `current()`, which calls `getRuntimeContext()` so it throws the usual
   error outside a frame, then returns a copy of that object with every
   function wrapped. The copy covers the nested groups: `thread`, `threads`,
   and `memory`.
3. Export the handle's type.

### Callbacks

Some `agency.*` functions take a function, such as
`agency.withHandler(handler, body)`. If `body` awaits and then uses Agency, it
has the same issue one level down.

The same rule covers it. `body` starts inside the right context, so it calls
`agency.current()` first:

```ts
await run.withHandler(handler, async () => {
  const inner = agency.current();
  await somethingSlow();
  return inner.interrupt({ kind: "ask", message: "?", data: null });
});
```

No second API is needed for callbacks.

### Costs and limits

- **`agency.current()` must come before the helper's first `await`.** Called
  later, it throws the "outside an Agency frame" error.
- **The handle is good only during the helper's call.** A helper that stores
  the handle and uses it after returning acts on a run that has moved on.
  There is no cheap way to catch this.
- **There are two ways to call the same thing**, `agency.llm()` and
  `run.llm()`. The guide has to say which to use. The simplest rule is to use
  the handle in any helper that awaits.
- **The handle does not help a plain function that Agency hands to
  third-party code.** That case needs `bindToCurrentFrame`.

### Tests to write

1. A unit test in `lib/runtime/agency.test.ts`. After a real `await`,
   `agency.ctx()` throws and `handle.ctx()` returns the context. The real
   `await` has to be built with `new Function`, because vitest rewrites the
   test file. `promiseContextStorage.test.ts` shows how.
2. A unit test with two frames running at once. Each handle keeps its own
   context.
3. A unit test that `agency.current()` throws outside a frame.
4. An Agency test under `tests/agency/ts-helpers/`. A hand-written `.js`
   helper awaits a timer, then raises an interrupt through the handle. A
   `handle` block in the Agency file approves it.
5. A test for a helper under `agency serve` or `agency pack`, since no test
   covers a helper there today.

### Docs to change

- `docs/site/guide/ts-helpers.md`: lead the "Helpers that `await`" section
  with the handle, and move the `.then` advice below it.
- `docs/dev/runtime/promise-context-storage.md`: add the handle to "Code that
  is not rewritten".

## Other options

- **Leave it as it is and document the limit.** This removes most of what a
  helper that takes part in the run is for.
- **Make Agency rewrite `.ts` helpers under every command.** For `agency
  serve` and `agency pack` this is one setting on two esbuild calls. It makes
  a `.ts` helper work in more places with no change to the helper. It cannot
  cover `agency compile`, where the user's own build produces the file, or a
  hand-written `.js` helper. It can be done as well as the handle. It does
  not replace it.
- **Use Node's promise hooks to carry the context across a real `await`.**
  Node has them and browsers do not, so this is a branch between the targets.
  `running-without-node.md` rules that out.
- **Tell users to set `"target": "ES2016"`.** This makes TypeScript do the
  rewrite. It applies to every file that shares the `tsconfig.json`, so the
  user's own code gets slower `async` functions and worse stack traces. It
  does nothing for `.js`.

## Open questions

- Should `agency.*` used after an `await` point the user at
  `agency.current()` in its error message? The error is the first thing a
  user sees.
- Should the load-time error for a `--ts` build mention the ES2016 target?
  Today it says to compile with the Agency compiler, which is the wrong
  advice for someone who chose `--ts`.
- Do the `serve`, `pack`, and `test js` rows in the table hold when tested?
