# Interrupts (Human-in-the-loop)

Agency has support for interrupts, which you can use to implement a human-in-the-loop system. Interrupts are very simple to use and work quite well.

Here's an example. Suppose I have the following agency code:


Here is an example of me using this agent in a TypeScript file.


This code may use the `readFile` tool, and I want to make sure that there is human approval for any file that is read. To implement this, simply return an interrupt. 


Then, in your code that's using this agent, check for interrupts and respond to them.

That's it! Execution will pick up exactly where it left off, down to the statement. 

## Implementation details
Agency tracks the state of every node and function. When code is being executed, Agency knows exactly what the values for the local and global variables are. It knows what arguments were passed into a function or node, and what line (technically, what *statement*) is currently executing. It knows this for the entire call stack.

When you call an interrupt, Agency serializes all the state and sends it back to you, saved on the `__state` key on the interrupt. You can `console.log` the interrupt and look at it yourself. Every interrupt has this shape:

```ts
type Interrupt<T> = {
  type: "interrupt";
  data: T; // the data you called `interrupt()` with

  // execution state
  __state?: Record<string, any>;
};
```

When you call `approveInterrupt` or `rejectInterrupt`, you pass this interrupt object back to that function. That function then restores the execution state using the serialized data. At that point, it is able to jump to the exact line on which your interrupt was returned, and resume execution from the next line!