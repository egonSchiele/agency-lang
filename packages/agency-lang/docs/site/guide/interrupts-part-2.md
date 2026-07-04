---
name: Interrupts, Part 2
description: Continues the discussion on Agency's interrupt feature, focusing on advanced usage and scenarios.
---

# Interrupts, Part 2

As we've discussed, when you raise an interrupt, it pauses program execution. You might think the pause is similar to how the program pauses when it waits for user input. But interrupts pause in a different and much more powerful way. 

As we've discussed, when you raise an interrupt, it pauses program execution. You might think the pause is similar to how the program pauses when it waits for user input. But interrupts pause in a different and much more powerful way.

When you raise an interrupt – and it surfaces to the user, not handled by a handler – it actually creates a checkpoint, exits the agent, and surfaces the interrupt *and the checkpoint* up to the user. When you resume from the interrupt, we actually resume the agent using the check point.

Lets see an example where this matters. Take this simple code:

```ts
type Mood = "happy" | "sad"

node main() {
  const msg = input("How do you feel?")
  const prompt = "Please categorize the following message: ${msg}"
  const mood: Mood = llm(prompt)
  return mood
}
```

This asks the user how they feel, takes their input, and categorizes it. Easy. This works on the command line. 

How would you write an agent to do the same thing, but in a web server context? It's fine to call `input` on the command line... the program just hangs and waits for a user response. But in a web server, you cannot have threads just hanging and waiting for a user response forever.

Let's rewrite the same thing for a web server using interrupts:

```ts
type Mood = "happy" | "sad"

node main() {
  const msg = raise interrupt("How do you feel?")
  const prompt = "Please categorize the following message: ${msg}"
  const mood: Mood = llm(prompt)
  return mood
}
```

Notice this is the only change:

```ts
// before
const msg = input("How do you feel?")

// after
const msg = raise interrupt("How do you feel?")
```

This just works. There are no threads hanging on a user response, because when you raise the interrupt, we exit the agent and save a checkpoint. Even if it takes the user a year to respond, we'll be able to pick up where we left off (as long as the code hasn't changed).

Each run of the agent also gets full state isolation. Read more about that [here](/guide/state-isolation).