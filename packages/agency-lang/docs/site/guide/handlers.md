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

## Raising interrupts inside a handler function

Lets start with some terminology:

```ts
handle {
  // this is the "handler body"
} with (data) {
  // this is the "handler function"
}
```

You can raise interrupts inside a handler body – that is the entire purpose of the handler. You can also raise interrupts inside the handler function. That is the part where you would catch and handle an interrupt, but you can raise interrupts there as well. Any interrupt raised in the handler function needs to be handled by an outer handler wrapping the inner handler:

```ts
// outer handler
handle {
  // inner handler
  handle {
    // this is the "handler body"
  } with (data) {
    // this is the "handler function"
    raise interrupt("This is an interrupt raised inside the handler function")
  }
} with (data) {
  // That interrupt can get handled here.
}
```

A handler function never triggers for an interrupt raised in itself because that could go into an infinite loop.

::: warning
One important note about interrupts raised inside handler functions: *you have to respond to them in code*. You cannot propagate them to a user. If any interrupt raised in the handler function gets propagated to a user, either using the `propagate` keyword or because that interrupt was simply not responded to, that would be an error.
:::