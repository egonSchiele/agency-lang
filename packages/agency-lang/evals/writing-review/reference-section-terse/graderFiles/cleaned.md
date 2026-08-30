## MUST READ: How interrupts, handlers, policies, and effects work

Interrupts are the most important feature of this language. Every task that touches them — code, review, spec, or plan — starts here. Do not reason about interrupts from grepped code fragments; an earlier review got the whole resume model wrong that way and proposed a security fix for a hole that did not exist. Read this section, then the guide pages (`docs/site/guide/interrupts.md`, `handlers.md`, `effects.md`, `policies.md`), then the dev doc for the mechanism you are changing.

### The four words

- **Effect**: the name of a kind of permission, declared with `effect std::env { name: string }` (`stdlib/system.agency:33`). Effects are what handlers and policies match on.
- **Interrupt**: one raise of an effect, with a message and data: `interrupt std::env("Are you sure…?", { name: name })`. It pauses the program until someone answers approve or reject.
- **Handler**: code that answers a raise. `handle { … } with approve`, `handle { … } with (intr) { … }`, or `someCall() with approve`.
- **Policy**: a JSON rule set (`lib/runtime/policy.ts`) that matches interrupts by effect and data globs. A policy can be used inside any handler, as a programmatic way to respond to interrupts. The benefit of policies is they allow you to specify how to respond to interrupts in a way that can be saved as pure data. You can save a policy as a JSON file and then use `agency run --policy <file>` to run some code with a specific policy.

### The lifecycle of one raise

Follow `env("FOO")` through `stdlib/system.agency:109-113`:

```
def requestEnvRead(name: string): string | null {
  return interrupt std::env("Are you sure…?", { name: name })
  return _env(name)
}
```

#### 1. Raise

The function raises an interrupt. The interrupt's effect is `std::env`. The interrupt has a message and some additional data.

#### 2. Handling programmatically

Every interrupt can be responded to programmatically or interactively. To respond to an interrupt programmatically, you wrap it in a handler like this:

```
handle {
  requestEnvRead("FOO")
} with (intr) {
  if (intr.effect == "std::env") {
    return approve()
  } else {
    return reject()
  }
}
```

An interrupt may trigger one or more handlers. Handlers nest. When an interrupt is raised, _every handler in its chain is consulted, not just the first one, and if any of those handlers returns a rejection, then the interrupt is rejected_. This is a key safety property of this language, because it means that users always have a chance to reject an action. Interrupts are usually raised before taking an action that is considered to be dangerous, destructive, or something that will mutate a value or read sensitive data: actions to read and write files or environment variables, for example. In Agency, every function is a tool that an LLM can call. Therefore, interrupts are important because they allow a user to reject an action that an agent wants to take.

#### 3.a Handling interactively

Like I said, you can respond to interrupts interactively or programmatically. If you don't respond to an interrupt programmatically, you must respond to it interactively. The interactive part happens in different ways, but the mechanism is fundamentally the same.

Suppose you are calling this agency code from TypeScript code. An interrupt has been raised and it did not get handled programmatically. What will happen is the entire execution state of the agency code will get serialized into a checkpoint. The interrupt and the checkpoint will both get surfaced to the TypeScript code, and in TypeScript, you can respond to the interrupt. When you do, you also pass in the checkpoint data, and Agency will use the serialized execution state in that checkpoint to restore execution to where it was. This is a pretty cool and important feature of Agency because it means that at any point, you can save the execution state of some agency code, and later on, you can resume that agency run at that exact line. This is an unusual feature for a language – no mainstream language lets you resume execution from an exact line across process boundaries. It's a really useful feature for agency, because it means that when an agent tries to take an action that is potentially risky, you can always choose to surface that to a human and get human approval.

#### 3.b The `--interactive` flag

I mentioned that the interactive part can happen in different ways. Here we saw the example of calling agency code from TypeScript code. But you can also run agency code on the command line and pass the --interactive flag to respond to interrupts interactively:

```
agency run --interactive <script.agency>
```

You can also approve or reject specific effects on the command line:

```
agency run --approve std::read --reject std::write <script.agency>
```

#### 3.c Serving agents interactively

Finally, another way users can respond to interrupts interactively is when your agent is being served. Agency has a serve feature that lets you serve your agent as an HTTP or MCP server. In that case, all of your exported nodes and functions become endpoints that can be hit on the server.
In that case, if something raises an interrupt, and it is not handled programmatically, it gets returned to the user along with a checkpoint for interactive response, and then the user needs to hit a specific `/resume` endpoint with the interrupts (each carries its checkpoint) and one approve or reject response per interrupt in order to resume from there.

#### 3.d When interrupts go to a human

Note that the interrupt only goes to a human for interactive approval in two cases:

1. No handler was able to give an adequate response for this interrupt. If any handler rejects the interrupt, the interrupt is immediately rejected. If any handler approves the interrupt, we still run all of the handlers to make sure that none of them reject. Then if all the handlers have been run, and there is at least one approval, the interrupt is approved. If no handler approved, then the interrupt goes to a human for interactive approval.
2. If any handler explicitly returned "propagate" for this interrupt, the interrupt will go to a human for interactive approval (unless it gets rejected, in which case it will be immediately rejected).

#### 4. Resume

When we resume from an interrupt, what happens depends on the response to the interrupt. If the interrupt was rejected, the function that the interrupt was raised in exits immediately with the failure. If the function was called as a tool by an LLM, we return a clear message to the LLM saying that the call was rejected.
If the interrupt was approved, then the function resumes from after the exact line where the interrupt was raised. Note it's important to understand that none of the data tied with the interrupt is used for anything except giving users information about the interrupt. For example, let's go back to the interrupt that was raised for reading an environment variable. You can see the data contains the name of the variable being read:

```
return interrupt std::env("Are you sure…?", { name: name })
```

We expose the name of the environment variable so that users can write code that responds to the interrupt programmatically based on the name. Or if they're responding to the interrupt interactively, they'll want to see the name to see environment variable we're trying to read, in order to decide whether to approve the read or not. That interrupt data is not used for anything else. In particular, it is never used when you resume from the interrupt. For example, a user could not choose to approve this interrupt, but pass in a name of a different environment variable.

There is a separate way to raise an interrupt where we do seek feedback from the user. That way looks like this, where the interrupt is used in an assignment:

```
let userResponse = raise std::getEnvName("What environment variable should I read?")
```

In this way, the user approves with some data. Even in this case, the interrupt data itself is not used for anything after we resume. The interrupt data is only used to give the user more information about what the interrupt is for.

### The checkpoint _is_ the program.

Like I said, the checkpoint is the serialized execution state of the program, which means it contains everything about the program: What line the user is on, what the call stack is, what the local and global variables are, etc. This means that someone could modify the checkpoint state to change the data we resume with. In the code to read an environment variable that we have been discussing, a user could change the value of the `name` variable in the `requestEnvRead` function before resuming the checkpoint, and that would mean that now the checkpoint is going to read a different environment variable instead. This is a potential attack vector that we must guard against.

We have a lot more documentation containing implementation details in docs/dev/:

- How a program resumes mid-block is `docs/dev/runtime/interrupts.md`.
- We've been talking about one interrupt, but actually, Agency supports multiple interrupts being raised concurrently from multiple threads, and it can pause and resume multiple threads. Information for this feature is in `docs/dev/runtime/concurrent-interrupts.md`.
- Details about the checkpoint format are in `docs/dev/runtime/checkpointing.md`.
- More info about policies is in `docs/dev/agents/approval-policies.md`.
- The HTTP round trip is `docs/dev/hosting/how-hosted-serving-works.md`.
- The `with approve` shorthand is `docs/dev/language/with-approve.md`.
- How effects propagate through function signatures is `docs/dev/compiler/effect-propagation.md`.
