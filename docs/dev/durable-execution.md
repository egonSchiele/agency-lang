  Durable execution: a comparison

  Here's the full spectrum from most explicit to most transparent:

  ┌─────────────────────────┬───────────────────────────────────┬──────────────────────────────┐
  │        Platform         │         How you write it          │   Explicit step wrapping?    │
  ├─────────────────────────┼───────────────────────────────────┼──────────────────────────────┤
  │ AWS Step Functions      │ JSON state machine                │ Yes, fully declarative       │
  ├─────────────────────────┼───────────────────────────────────┼──────────────────────────────┤
  │ Azure Durable Functions │ Orchestrator + activity functions │ Yes, separate function types │
  ├─────────────────────────┼───────────────────────────────────┼──────────────────────────────┤
  │ Cloudflare Workflows    │ await ctx.step.do('my-step', fn)  │ Yes, named steps             │
  ├─────────────────────────┼───────────────────────────────────┼──────────────────────────────┤
  │ Inngest                 │ await step.run('my-step', fn)     │ Yes, named steps             │
  ├─────────────────────────┼───────────────────────────────────┼──────────────────────────────┤
  │ Trigger.dev             │ await io.runTask('my-step', fn)   │ Yes, named steps             │
  ├─────────────────────────┼───────────────────────────────────┼──────────────────────────────┤
  │ Restate                 │ await ctx.run('my-step', fn)      │ Yes, named steps             │
  ├─────────────────────────┼───────────────────────────────────┼──────────────────────────────┤
  │ Temporal                │ result = await myActivity(args)   │ No — write normal async code │
  ├─────────────────────────┼───────────────────────────────────┼──────────────────────────────┤
  │ Agency (current)        │ result = interrupt("msg")         │ No — compiler tracks it      │
  └─────────────────────────┴───────────────────────────────────┴──────────────────────────────┘

a good explainer https://temporal.io/blog/what-is-durable-execution

Alternative approach would be event log replay:

  Instead of serializing a position in the code, serialize a log of what happened — specifically the results of all external calls:

  {
    "events": [
      { "type": "llm", "input": "Say hi", "result": "Hello!" },
      { "type": "tool-call", "tool": "readFile", "args": {"file": "foo.txt"}, "result": "..." },
      { "type": "interrupt", "data": "Approve?", "response": { "type": "approve" } }
    ]
  }

  On resume, Agency re-runs the code from the beginning but short-circuits every external call: when it hits llm(...) and there's a cached event with matching input, it returns the cached result instantly (no API call). When
  it reaches the event that has no cached result (the failure point), it actually executes — either retrying the failed operation or continuing with the next one.

  How this handles code changes: Because matching is by content (input/output of each call) rather than position, adding or removing unrelated statements doesn't break the log. Only changing the actual operations (different prompts, different tool arguments) would cause a mismatch.