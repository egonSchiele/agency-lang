## The OpenClaw problem
In case you haven't heard of it, [OpenClaw](https://github.com/openclaw/openclaw) is an open-source, personal AI assistant app:

> The AI that actually does things. Clears your inbox, sends emails, manages your calendar, checks you in for flights.

Super useful if it works! It became very popular, going from one person's personal project to 300k stars on Github in about a month. Then people started figuring out that it doesn't have many safeguards, after OpenClaw [deleted all their emails](https://www.pcmag.com/news/meta-security-researchers-openclaw-ai-agent-accidentally-deleted-her-emails), for example.

This leads to the OpenClaw paradox: if you want an agent to be useful, you have to give it the ability to take action for you, but if you do that, it may do something you don't want it to do, like deleting all your email.

Lots of people are trying to sandbox their agents. But again, if you sandbox it so it can't do anything destructive, maybe it can't do anything useful either. It sure would be nice if the agent told you when it was going to take an action, and you could approve or disapprove it. Enter Agency!

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

`interrupt` pauses execution and checks with the user. Then the user can approve or reject. There are many ways you can respond with approval or rejection. Handlers are one way:

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

That example always approves. You could also look at the number of emails about to be deleted and decide whether to approve or reject.

```ts
def deleteEmail(numEmails: number) {
 // explicitly return the number of emails to be deleted
 return interrupt({ 
 message: "Are you sure you want to delete ${numEmails} emails!!!",
 numEmails: numEmails
 })
 print("deleting ${numEmails} emails! DO DO DO!")
}

node main() {
 handle {
 const aMillion = 1000000
 // OH NO!
 deleteEmail(aMillion)
 } with (data) {
 // reject if the number of emails to be deleted is greater than 100
 if (data.numEmails > 100) {
 return reject()
 }
 return approve()
 }
}
```

If you approve, execution starts right where it left off. If you reject, the delete email returns immediately with the failure response. Cool, right? Let me also show you a shorthand:

```ts
node main() {
 const aMillion = 1000000
  // always approve!
 deleteEmail(aMillion) with approve
}
```

This means that when you build an agent with Agency code, as long as any destructive action is gated behind an interrupt, you can always choose to reject it. If you read someone else's agency code, and you can confirm that every destructive action has an interrupt in front of it, then you *always* have a chance to respond to that interrupt and reject it.


Now you're saying, "Well, that's not true. What if they just approve their own function, and you never get a chance to see it?" To which I say, "get out of your exception-focused thinking!" Because handlers are different. It's not first handler wins; every handler enclosing a piece of code always gets run. And if any handler rejects,
 the interrupt is rejected.

Let's look at the shorthand again. "deleteEmail" will always get approved, right? The comment says so!

Nope!

```ts
node main() {
 // oh snap this handler ALSO runs!
 handle {
 const aMillion = 1000000
 deleteEmail(aMillion) with approve
 } with (data) {
 // and it rejects!!
 return reject()
 }
}
```

Even though the inner handler approves, the outer handler rejects, and so, this interrupt gets rejected, and the email deletion does not continue. Which just goes to show that you shouldn't trust comments too much!

If *any* handler rejects the interact, it gets rejected. As long as the agency code you're using has an interrupt before destructive actions, you'll be able to decide what happens. Heck, you could just wrap the entire body of your agent in a handler and reject every single interrupt:

```ts
node main() {
 handle {
 // do stuff
 } with (data) {
 // reject all interrupts
 return reject()
 }
}
```

Besides `approve` and `reject,` the other keyword is `propagate.` `propagate` means "I don't want to reject the interrupt, but I don't want anyone to be able to programmatically approve it either. I want to make sure it always goes to a user for approval or rejection."

### The rules of handlers are thus:
1. If any handler rejects, the interrupt is rejected.
2. Otherwise, if any handler propagates, the interrupt propagates to the user for a decision.
3. Otherwise, if a handler approves, the interrupt is approved.
4. Of course, a handler doesn't need to approve, reject, or propagate. It can simply choose to log the interrupt data, print out the lyrics to "A Day in the Life," or whatever. If no handler approves, rejects, or propagates, by default, the interrupt propagates up to the user for a decision.

Oh by the way, can I just say that interrupts work in tool calls too. Every function in Agency is also automatically a tool. That means an agent can use `deleteEmail` as a tool, and before it deletes the email, it will check with the user, following the rules of handlers.