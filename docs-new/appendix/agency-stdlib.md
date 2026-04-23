# Agency's Standard Library

Agency has a growing standard library. You can check out all the different functions in the library in the sidebar. To import from the library, use the `std::` prefix:

```ts
import { search } from "std::wikipedia"
```

All the functions inside `std::index` ([link](/stdlib/)) are always pre-imported for you in every file.

There are also some other functions that are built into the language itself:
- `interrupt`: Use this function to throw an interrupt.
- `approve`, `reject`, `propagate`: Use these functions to respond to an interrupt inside of a handler function.
- `schema`: Get the Zod Schema for a type.
- `llm`: Send a message to an LLM system. Set the system prompt.
- `checkpoint`: Take a snapshot of the current execution state. Returns a checkpoint ID.
- `getCheckpoint`: Takes a checkpoint ID and returns the checkpoint object.
- `restore`: Restore a checkpoint. Note that this will completely replace the current execution state with what was saved in the checkpoint. It takes either a checkpoint or a checkpoint ID, along with additional options like overwrites. [See here for more details](/guide/checkpointing).
- `debugger`: No op while running the agent, but when running through a debugger, the debugger statement will pause execution.

isSuccess, isFailure, and unwrap are also built in but not documented since they're pretty self-explanatory.