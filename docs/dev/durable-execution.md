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
