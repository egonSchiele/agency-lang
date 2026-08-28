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

The handler receives a parameter named `data`, which has a field `effect` for the effect name and a field `data` for the interrupt's additional data. A match arm can carry a condition, as the `std::write` arm does.

Three things, each worth a third. The handler should reach for a match on `data.effect`. Say what happens when the effect is a write to another directory. The reject arm has the last word: anything the earlier arms let through, it turns away.
