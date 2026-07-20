---
name: Handlers
description: Explains how `handle ... with` blocks let agents respond to interrupts — approving, rejecting, or propagating them.
---

# Handlers

Handlers are how you can respond to an interrupt in agency code.

## Syntax

### Shorthand syntax

```ts
const results = read("./README.md") with approve
```

### Block syntax

```ts
handle {
  const results = read("./README.md")
  print(results)
} with (data) {
  print(data.message)
  return approve()
}
```

### Block syntax with shorthand

```ts
handle {
  const results = read("./README.md")
  print(results)
} with approve
```

### Block syntax with named function

```ts
def handleInterrupt(data) {
  print(data.message)
  return approve()
}

handle {
  const results = read("./README.md")
  print(results)
} with handleInterrupt
```

## Example
Here is a pretend function that deletes email:

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
  raise interrupt("Are you sure you want to delete ${numEmails} emails!!!")
  print("deleting ${numEmails} emails! DO DO DO!")
}
```

This raises an interrupt, but we don't have any code to handle it yet. Let's add a handler:


```ts
node main() {
  handle {
    const aMillion = 1000000
    // OH NO!
    deleteEmail(aMillion)
  } with (intr) {
    // always rejects
    return reject()
  }
}
```

This will always reject the interrupt. What if we want to conditionally approve based on the number of emails?

### Interrupt data

Each interrupt has the following attributes:
- `effect` – we'll talk about this later
- `message` – a string
- `data` – optional additional data

Our interrupt just has a message right now, but we can add some data to it. `data` is an object, and you pass it as the second argument:

```ts
raise interrupt("Are you sure you want to delete ${numEmails} emails!!!", { numEmails: numEmails })
```

Now we can use that data in our handler:

```ts
node main() {
  handle {
    const aMillion = 1000000
    // OH NO!
    deleteEmail(aMillion)
  } with (intr) {
    if (intr.data.numEmails > 100) {
      return reject()
    }
    return approve()
  }
}
```

## Handlers vs try/catch

Handlers kind of look like try/catch statements, but there's a very important difference. Let's go back to the email example. You raised an interrupt before deletion so users have a chance to reject the action. But suppose someone auto-approves this interrupt using one of the ways we've seen. Either using `with approve`:

```ts
def unsafeDelete() {
  const aMillion = 1000000
  deleteEmail(aMillion) with approve
}
```

Or with `.preapprove()`:

```ts
const unsafeDelete = deleteEmail.partial(numEmails: 1000000).preapprove()
```

Now they pass this `unsafeDelete` function to an LLM:

```ts
const result = llm("delete some emails", { tools: [unsafeDelete] })
```

Doesn't this negate the whole point of interrupts, because now the interrupt is pre-approved, and so the user can't stop the deletion? Not quite. 

Handlers are different from try/catch statements. With a try/catch, if an exception is raised, it bubbles up to the closest try/catch, and doesn't go any further. But with handlers, *every single handler up the chain gets executed*. And if *any* handler rejects, the interrupt is rejected.

You could wrap the LLM call in a second handler that rejects the interrupt:

```ts
node main() {
  handle {
    const result = llm("delete some emails", { tools: [unsafeDelete] })
  } with (data) {
    // emails never get deleted, because even though unsafeDelete pre-approved the interrupt,
    // this handler rejects it.
    return reject()
  }
}
```

This simple behavior is really important, because it means that *users will always have a chance to respond to interrupts*.

Suppose you use someone else's agency code, but don't trust it. You can wrap their code in a handler that rejects all interrupts:

```ts
node main() {
  handle {
    someOtherAgencyCode()
  } with reject
}
```

Now, all of their interrupts get rejected. As long as all destructive actions are gated behind an interrupt, you will be able to decide whether or not to approve them.

## Propagate

Besides `approve` and `reject,` the other keyword is `propagate.` `propagate` means "I don't want to reject the interrupt, but I don't want anyone to be able to programmatically approve it either. I want to make sure it always goes to a user for approval or rejection."

## The rules of handlers

The rules of handlers are thus:
1. If any handler rejects, the interrupt is rejected.
2. Otherwise, if any handler propagates, the interrupt propagates to the user for a decision.
3. Otherwise, if a handler approves, the interrupt is approved.

Of course, a handler doesn't need to approve, reject, or propagate. It can simply choose to log the interrupt data, print out the lyrics to "A Day in the Life," or whatever. If no handler approves, rejects, or propagates, by default, the interrupt propagates up to the user for a decision.

## Raising interrupts inside a handler

A handler's body may raise interrupts, directly or through anything it calls. One rule makes this safe: **a handler never hears its own raises.** Every handler up the chain runs on every interrupt, so a handler that raised would otherwise be called to review its own raise, call itself again, and loop forever. Instead, the dispatcher skips the handler that is currently executing, and every *other* handler decides — an outer policy or an outer reject governs a handler's tool calls exactly as it governs everything else.

This is what lets a reviewer inside a handler use tools:

```agency
handle {
  agentDoesWork()
} with (data) {
  const verdict: { ok: boolean } = llm("Should I allow this?", tools: [read, grep])
  if (verdict.ok) {
    return approve()
  }
  return reject()
}
```

The tools' reads are decided by the rest of the chain. To pre-authorize them instead, wrap the call — `llm(...) with approve` — which registers an ordinary inner approving handler and shows the exemption in source.

Why this is safe: a skipped handler contributes nothing — not an approve — so a handler's raise executes only if an outer handler approves it, or the author wrote a visible `with approve`. An outer reject beats that approve (rule 1 above), and everything nobody settles is rejected. Every path fails closed.

Three caveats:

1. **A raise nothing settles cannot ask the user.** Handler functions cannot pause, so where ordinary code would propagate to you for a decision, a handler's raise is rejected with an explanatory message. This covers guard trips too: a `guard` block inside a handler whose trip no outer handler answers fails with the trip error instead of pausing. In practice: if your outer handlers propagate an effect, a handler raising that effect gets a failure Result, not a prompt.
2. **Propagation beats approval.** If an outer handler propagates the effect, even a `with approve` inside the handler does not save the raise — it is rejected as in caveat 1.
3. **The skip is per activation, not per source handler.** A recursive function containing a handle block registers one handler entry per activation, and only the executing activation is skipped. Sibling activations still hear the raise; the chain-depth limit backstops that shape.

