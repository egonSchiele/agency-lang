Here's an example of handler syntax:

    handle {
      foo()
    } with (data) {
      return match (data.effect) {
        "std::read" => approve()
        "std::write" if (data.data.dir == ".") => approve()
        _ => reject()
      }
    }

The handler receives a parameter named `data`. `data` has an `effect` field for the effect name and a `data` field for the interrupt's additional data. Note that you can set guards on match arms. See the `"std::write"` arm for an example. The `_` arm rejects every other effect.

Make sure that:
1. the handler uses one match on `data.effect` to decide.
2. a write to any directory other than "." is rejected.
3. every other effect is rejected by the `_` arm.

All three points count equally towards the final score.
