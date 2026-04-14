# The Agency debugger
Agents are hard to debug, and an agent that works reliably is hard to write. Why? Because agents are non-deterministic. Let's say you make an LLM call that works 90% of the time. The other 10% it spits out the wrong answer or just gibberish. Now, let's say you have a chain of five LLM calls like this, all of them working 90% of the time. Well, guess what? That means your entire chain only returns the correct response 59% of the time!

Every LLM call is pretty opaque. It's hard to know which LLM calls went wrong and why. The system fundamentally has a lot of uncertainty.

Thankfully, Agency has an awesome debugger. Put the following code in a file called `test.agency` and then invoke the debugger using `npm run agency debug test.agency`:

```ts
node main() {
 const name = "world"
 const greeting = llm("Say hello to ${name}!")
 print(greeting)
}
```

You'll see a cool debugger show up. The line that the debugger is about to execute is highlighted. Press the down arrow to execute that line. Keep pressing down, and you'll see it execute the whole program. Cool!
Now for the actually cool part: go ahead and press the up arrow, and you'll rewind time. Agency has a time-traveling debugger, which means at every step of the debugger, it's taking a snapshot, and you can always rewind to any previous snapshot. This makes it a lot easier to debug your programs.

*This page is a stub. You can help by expanding it.*