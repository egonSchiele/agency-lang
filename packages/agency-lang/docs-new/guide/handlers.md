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

## Handler shorthand

Specifically for the keywords `approve`, `reject`, and `propagate`, there is a shorthand syntax you can use:

```ts
node main() {
 const aMillion = 1000000
 deleteEmail(aMillion) with approve
}
```

This shorthand can make code more readable. It still follows the rules of handlers, so you can still wrap this code in a handler and reject the interrupt.