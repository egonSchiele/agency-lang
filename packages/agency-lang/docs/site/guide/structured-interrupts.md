---
name: Structured Interrupts
description: Explains the structured interrupt syntax for tagging interrupts with an `effect`, letting handlers dispatch on different kinds of interrupts.
---

# Structured Interrupts

All interrupts contain three fields:
- message,
- data, and
- effect.

We've already seen how you can pass the message and data as the first and second parameters to the `interrupt()` function. To pass in the effect, use the structured interrupt format.

```ts
return interrupt foo::write(
  "Are you sure you want to write to this file?",
  { filename: filename }
)
```

In this example, `foo::write` is the effect of the interrupt. You can set this to anything you want. Interrupts in the standard library are prefixed with `std::`.

What are effects good for? They're useful if you want specific responses for different kinds of interrupts in handlers:

```ts
def deleteEmail(numEmails: number) {
  return interrupt foo::deleteEmail(
    "Are you sure you want to delete ${numEmails} emails!!!",
    { numEmails: numEmails }
  )
  print("deleting ${numEmails} emails! DO DO DO!")
}

handle {
  deleteEmail(aMillion)
} with (data) {
  // Reject any interrupt for deleting email.
  // Approve all other interrupts.
  if (data.effect == "foo::deleteEmail") {
    return reject()
  }
  return approve()
}
```

Effects give you a way to programmatically identify and handle different interrupts in handler blocks. If you don't specify the effect, it is automatically set to `"unknown"`.

Effects are also useful if you want to write [policies](./policies) that apply to specific kinds of interrupts.