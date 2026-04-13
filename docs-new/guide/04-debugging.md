## The debugger problem
Agents are hard to debug, and an agent that works reliably is hard to write. Why? Because agents are non-deterministic. Let's say you make an LLM call that works 90% of the time. The other 10% it spits out the wrong answer or just gibberish. Now, let's say you have a chain of five LLM calls like this, all of them working 90% of the time. Well, guess what? That means your entire chain only returns the correct response 59% of the time!
We also love letting our agents make tool calls, giving them the ability to do things. Let's say you have a chain of five LLM calls. All of them might be able to call tools, and if you get an incorrect response, which as we have seen, can happen a lot of the time, it is a huge pain to debug. Every LLM call is pretty opaque. It's hard to know which LLM calls went wrong and why. The system fundamentally has a lot of uncertainty.

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

Now you're saying, "Well, that's all well and good, but what happens when users complain that the agent isn't working as expected? I can't exactly debug their interaction with the agent using a time travel debugger, can I? ...Can I?"

## Yeah, you totally can

Now go ahead and run the program using `trace`:

```
npm run agency trace test.agency
```

You'll see the output, and you'll also see a new file named `test.trace` in the directory.

Load it into the debugger along with the source file:

```
npm run agency debug test.agency --trace test.trace
```

The trace contains the entire execution trace of your agent run. Every step of the execution has been saved, creating a series of checkpoints. Use the up and down arrow keys to highlight different ones, and you'll see the code highlight different lines of the source. You can now rewind to any part of the execution and see exactly what the current state was, what actions were taken, et cetera. With Agency, you can debug every single user interaction like you're stepping through it with a time travel debugger, and see exactly what happened at every step.