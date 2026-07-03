
Interrupts are a core feature in Agency. They allow you to pause execution at any step and ask the user for input. I think it's fair to say that Agency does interrupts better than any other library. Most libraries, if they offer interrupts, can only resume execution from the start of the function where the interrupt was defined, but Agency can resume execution from the exact point that we left off. Interrupts work inside if statements, inside loops, inside tool calls. They are a very powerful feature and they're also very easy to use.

Here is what an interrupt looks like.



Before writing to this file, this function will now first confirm with the user. If the user approves, the rest of the function will continue. If the user rejects, then the function will exit immediately with a `failure` [Result value](./error-handling).

---


## `interrupt()` function parameters

The first parameter of the interrupt function is the message you want to show the user. You can also return some data as the second parameter. The data must be an object.

```ts
def writeFile(filename: string, content: string) {
  const filename = interrupt(
    "Are you sure you want to write to this file?",
    { filename: filename }
  )
  // write to file
}
```

## Responding to interrupts in TypeScript

You can respond to interrupts either in TypeScript code or in Agency code. If you're running a website, and you want to show the user a dialogue asking them to respond to an interrupt, here is how you would do it.

```ts
// call the `main` node in typescript
const result = await main();

// check if the result is an interrupt
if (hasInterrupts(result.data)) {
  const responses = [];
  for (const interrupt of result.data) {
    console.log("Please respond to this interrupt: " + interrupt.message);

    // Pretend there's a getUserResponse function that gets a y/n
    // response from the user
    const userResponse = await getUserResponse(interrupt);

    if (userResponse === "y") {
      responses.push(approve());
    } else {
      responses.push(reject());
    }
  }
  // respond to the interrupts and get the final result
  // `respondToInterrupts` takes in the original interrupts and the responses
  // and returns `newResult` after resuming execution.
  // `newResult` could have interrupts too.
  const newResult = await respondToInterrupts(result.data, responses);
}
```

A couple callouts:

- Notice that in TypeScript, you get an array of interrupts. This is because Agency supports concurrent execution, and so you might have interrupts getting thrown from multiple threads.
- The responses are always in the same order as the interrupts, so you can just loop through them together and respond to each one.

To approve or reject, call the `approve()` or `reject()` functions. If you want to approve with a response – to respond with a filename for example:

```ts
def writeFile(content: string) {
  const filename = interrupt(`Where do you want to write this content?`)
  // write to file
}
```

 You can pass that response as an argument to `approve()`, like `approve("myfile.txt")`. If you want to reject, but give a reason for the rejection, you can pass that to the reject function as a string: `reject("I don't think it's safe to write to this file")`.

## Responding to interrupts in Agency

You can also respond to interrupts in Agency code. This is done using handlers, which have their own chapter! We'll talk about them in the next chapter.

---


## In pipes

Partial application works naturally with the [pipe operator](./error-handling):

```ts
def multiply(a: number, b: number): Result {
  return success(a * b)
}

def half(x: number): Result {
  return success(x / 2)
}

const result = success(10) |> half |> multiply.partial(a: 3)
```

The piped value fills the remaining unbound parameter.

---

## Matching on the effect (exhaustiveness)

An inline handler's parameter carries the interrupt that fired:
`{ effect, message, data, origin }`. Its `effect` field is typed as the union
of the effect kinds the handled body can actually raise, so you can branch on it
with `match` and get an exhaustiveness check:

```ts
handle {
  doRiskyThings()                 // can raise app::confirm or app::rateLimited
} with (e) {
  match (e.effect) {
    "app::confirm" => approve()
    // error: match is not exhaustive: missing "app::rateLimited"
  }
}
```

Add the missing arm — or a `_` catch-all — to clear it. The check is
conservative: if the raisable set can't be determined precisely (an explicitly
annotated param, a `functionRef` handler, or a nested `handle` inside the body),
the parameter stays untyped and no check is required.

## Payload typing on `e.data`

The parameter is typed as a discriminated union — one member per raisable
effect kind — so `e.data` carries **that effect's declared payload** once you
narrow on `e.effect`. Guard with `if (e.effect == "...")` (a member-path guard)
and the payload becomes concrete inside the branch:

```ts
effect app::confirm { question: string }
effect app::rateLimited { retryAfter: number }

handle {
  doRiskyThings()
} with (e) {
  if (e.effect == "app::confirm") {
    ask(e.data.question)          // e.data.question : string
  }
  if (e.effect == "app::rateLimited") {
    waitFor(e.data.retryAfter)    // e.data.retryAfter : number
    // ask(e.data.question)       // error: `question` is not on this effect's payload
  }
}
```

An effect declared with no payload (`effect ping { }`) gives `e.data` an empty
object, so reading a field off it is an error. An effect with no declaration, or
one dropped because its declarations conflict, leaves `e.data` untyped (`any`).

Two idioms narrow `e.data` per effect. Both are equivalent:

```ts
// member-path guard
if (e.effect == "app::confirm") { ask(e.data.question) }

// match on the effect field
match (e.effect) {
  "app::confirm"     => ask(e.data.question)      // e.data is the confirm payload
  "app::rateLimited" => waitFor(e.data.retryAfter)
}
```

Only the **object-pattern** form does not narrow the payload: a
`match (e) { { effect: "..." } => ... }` arm still drives exhaustiveness, but does
**not** narrow `e.data` inside the arm body. Use `if (e.effect == "...")` or
`match (e.effect)` when you need the payload.

---

Unfortunately, there are times when you *need* to call a function inside of a handler that raises an interrupt.


### Fixing it

Two patterns cover almost every real case.

**Pattern 1: hoist the interrupt-raising work out of the handler.** If
the handler needs a value it can compute once at startup, do the
compute *before* installing the handler:

```ts
// Before — handler reads the policy file every time, which itself
// raises a std::read interrupt the chain wants to dispatch.
def myHandler(data) {
  const policy = read("policy.json") with approve   // ← re-enters
  return checkPolicy(policy, data)
}
node main() {
  handle { ... } with myHandler
}
```

```ts
// After — read once outside the handler, close over the value.
let policy: Policy = {}
node main() {
  policy = read("policy.json") with approve
  handle { ... } with myHandler   // myHandler now just reads `policy`
}
```

**Pattern 2: flip a sentinel flag *before* the interrupting call, not
after.** If the handler genuinely has to do something once that may
itself interrupt — say, lazy-load on first use — guard the re-entry
explicitly:

```ts
let loaded: boolean = false
def ensureLoaded() {
  if (!loaded) {
    loaded = true                              // ← flip FIRST
    policy = read("policy.json") with approve  // re-enters, but the
                                               // guard short-circuits
  }
}
def myHandler(data) {
  ensureLoaded()
  return checkPolicy(policy, data)
}
```

The order matters: if you flip `loaded` *after* the read, the
re-entered call sees `loaded == false`, raises another interrupt, and
recurses. Flipping first makes the re-entry a no-op.

### The escape hatch

If neither pattern fits — e.g. you're forwarding the interrupt to a
remote process and the network call genuinely has to happen inside
the handler — add `// @tc-ignore` on the line directly above the
`handle` block to silence this one error:

```ts
node main() {
  // @tc-ignore
  handle { ... } with myUnavoidableHandler
}
```

A few things to know:

- `@tc-ignore` only suppresses errors whose source location is on the
  *very next line*. It only silences the handler-recursion error at
  this `handle` site. Errors inside the handle body or the handler
  function continue to fire normally.
- The suppression has to live at the `handle` call site, not at the
  handler function's definition. If `myUnavoidableHandler` is defined
  in another file, the comment still goes above the `handle` that
  references it. The error names the handler, so search for the
  definition from there.
- The whole-file `// @tc-nocheck` directive also turns this rule off
  along with everything else, but prefer the per-site `@tc-ignore` so
  you don't lose unrelated diagnostics.


