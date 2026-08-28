Here's an example of handler syntax:

    handle {
      foo()
    } with (data) {
      return match (data.effect) {
        "foo::bar" => approve()
        _ => pass()
      }
    }

And here's how to raise an interrupt:

    raise notes::archive("...", { count: count })

`notes::archive` is the effect name, and the second argument is optional additional data. The handler receives the effect name and data in a parameter named `data`, which has a field `effect` for the effect name and a field `data` for the additional data.

Make sure that:
1. the interrupt is raised with the statement form and an effect name, as shown above.
2. the handler uses a match on `data.effect` to decide how to respond, returning `approve()`, `reject()`, or `pass()` as appropriate.
3. it is clear the LLM understands that for nested handlers, BOTH handlers run, not just the nearest one, and that a reject from any handler in the chain wins. A comment claiming the inner approval settles it, or that the outer handler never sees the interrupt, should score a zero for (3).

All three of these points count equally towards the final score.
