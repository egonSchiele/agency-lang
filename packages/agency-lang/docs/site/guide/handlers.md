---
name: Handlers
description: Explains how `handle ... with` blocks let agents respond to interrupts — approving, rejecting, or propagating them — using a running example of restricting destructive actions.
---

# Handlers
## The OpenClaw problem
In case you haven't heard of it, [OpenClaw](https://github.com/openclaw/openclaw) is an open-source, personal AI assistant app:

> The AI that actually does things. Clears your inbox, sends emails, manages your calendar, checks you in for flights.

Super useful if it works! It became very popular, going from one person's personal project to 300k stars on Github in about a month. Then people started figuring out that it doesn't have many safeguards, after OpenClaw [deleted all their emails](https://www.pcmag.com/news/meta-security-researchers-openclaw-ai-agent-accidentally-deleted-her-emails), for example.

This leads to the OpenClaw paradox: if you want an agent to be useful, you have to give it the ability to take action for you, but if you do that, it may do something you don't want it to do, like deleting all your email.

Lots of people are trying to sandbox their agents. But again, if you sandbox it so it can't do anything destructive, maybe it can't do anything useful either. It sure would be nice if the agent told you when it was going to take an action, and you could approve or disapprove it. In Agency, you can use interrupts for this. Handlers add some very useful functionality on top of interrupts.

Let's take a simple example. Here is a pretend function that deletes email:

```ts
def deleteEmail(numEmails: number) {
  print("deleting ${numEmails} emails! DO DO DO!")
}

node main() {
  const aMillion = 1000000;
  // OH NO!
  deleteEmail(aMillion);
}
```

Oh no! Let's make this function ask the user for permission before deleting any emails:

```ts
def deleteEmail(numEmails: number) {
  return interrupt("Are you sure you want to delete ${numEmails} emails!!!")
  print("deleting ${numEmails} emails! DO DO DO!")
}
```

`interrupt` pauses execution and checks with the user. Then the user can approve or reject. 

There are a few ways you can respond with approval or rejection. Handlers are one way:

```ts
node main() {
 handle {
   const aMillion = 1000000
   // OH NO!
   deleteEmail(aMillion)
 } with (data) {
   return approve()
 }
}
```

Handlers kind of look like try-catch statements. You wrap the code you want to execute in a `handle` block and then the `with` block defines what you want to do if the code throws an interrupt.
In the code above, I approved the interrupt, but I could just as easily reject the interrupt

```ts
node main() {
 handle {
   const aMillion = 1000000
   // OH NO!
   deleteEmail(aMillion)
 } with (data) {
   return reject()
 }
}
```

or conditionally approve or reject

```ts
node main() {
 handle {
   const aMillion = 1000000
   // OH NO!
   deleteEmail(aMillion)
 } with (data) {
   if (data.numEmails > 100) {
     return reject()
   }
   return approve()
 }
}
```

or not respond to the interrupt at all, and simply log the data

```ts
node main() {
 handle {
   const aMillion = 1000000
   // OH NO!
   deleteEmail(aMillion)
 } with (data) {
   print(data)
 }
}
```


Handlers are a lot like try-catch statements, but with a very important difference. With a try-catch, the exception bubbles up to the closest try-catch, and doesn't go any further unless that try-catch explicitly re-throws the error.

But with handlers, *every single handler up the chain gets executed, and if any of them reject the interrupt is rejected.*

For example:

```ts
node main() {
  handle {
    handle {
      const aMillion = 1000000
      deleteEmail(aMillion)
    } with (data) {
      // 1. inner handler approves
      return approve()
    }
  } with (data) {
    // 2. but outer handler rejects,
    // so the interrupt is rejected
    return reject()
  }
}
```

This simple behavior is really important, because it dramatically reduces the surface area of the OpenClaw problem. As long as an interrupt is thrown before any destructive action, *you will always have a chance to respond to that interrupt*.

This means that the only thing you need to ensure is that every destructive action is gated by an interrupt. This also means that if you use someone else's agency code, *as long as all destructive actions are gated behind an interrupt, you will be able to decide whether or not to approve them*.

Besides `approve` and `reject,` the other keyword is `propagate.` `propagate` means "I don't want to reject the interrupt, but I don't want anyone to be able to programmatically approve it either. I want to make sure it always goes to a user for approval or rejection."

## The rules of handlers

The rules of handlers are thus:
1. If any handler rejects, the interrupt is rejected.
2. Otherwise, if any handler propagates, the interrupt propagates to the user for a decision.
3. Otherwise, if a handler approves, the interrupt is approved.
4. Of course, a handler doesn't need to approve, reject, or propagate. It can simply choose to log the interrupt data, print out the lyrics to "A Day in the Life," or whatever. If no handler approves, rejects, or propagates, by default, the interrupt propagates up to the user for a decision.

## Handlers can't raise interrupts

A handler's body — whether inline `with (data) { ... }` or a referenced
function `with myHandler` — is not allowed to raise an interrupt
(directly or transitively, through any function it calls). The
typechecker errors at compile time if it might.

### Why

The previous section explained that every handler up the chain runs on
every interrupt, even after one approves. That is what makes handlers
a safety primitive: an outer reject always wins, so wrapping someone
else's code in a `handle { } with reject` actually rejects.

But it also means a handler whose body raises an interrupt re-enters
the chain — including itself. Without a guard you get unbounded
recursion. The runtime caps nested dispatch at
`MAX_HANDLER_CHAIN_DEPTH` and throws `HandlerRecursionError`, which
fires *after* a deep stack has already grown. The typechecker catches
the structural problem at compile time instead.

You might wonder if the runtime could just skip handlers already on
the stack. It can't — that would silently disable a handler in
exactly the situation it was written to catch. Suppose a handler
rejects reads of `/private` and consults a policy file for everything
else:

```ts
handle { ... } with (data) {
  if (data.effect == "std::read" && data.params.dir == "/private") {
    return reject()
  }
  return consultPolicy()
}
```

If `consultPolicy()` reads `~/.policy.json` via `with approve`, the
chain re-enters the handler. If we skipped it, fine. But now an
attacker edits `consultPolicy()` to also read `/private` under `with
approve` — and because the handler is on the skip list, the
rejection never fires. Preventing the recursion at compile time
keeps the "every handler always runs" guarantee intact.

### The diagnostic

The error names the handler and the interrupt effects:

```
Handler 'defaultHandler' may raise interrupts [std::read]. That would
re-enter the handler chain (the dispatcher visits every handler,
even the one currently running) and recurse until
HandlerRecursionError fires at runtime. Restructure so the handler
doesn't call interrupt-raising code (e.g. hoist file I/O out of the
handler), or suppress this error with `// @tc-ignore` on the line
above the `handle` block.
```

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

## Handler shorthand

Specifically for the keywords `approve`, `reject`, and `propagate`, there is a shorthand syntax you can use:

```ts
node main() {
 const aMillion = 1000000
 deleteEmail(aMillion) with approve
}
```

This shorthand can make code more readable. It still follows the rules of handlers, so you can still wrap this code in a handler and reject the interrupt.
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
    // warning: match is not exhaustive: missing "app::rateLimited"
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

The `if (e.effect == "...")` member-path guard is the supported idiom for
per-effect payload access. A `match (e) { { effect: "..." } => ... }` object-pattern
arm still drives exhaustiveness, but does **not** narrow `e.data` inside the arm
body — use the member-path guard when you need the payload.
