## General writing tips

1. Avoid garden path sentences.

Bad: a sentence that begins like this:

```
The name lists partition
```

When you read the sentence, what do you think it means? I think it means that a name lists some partitions. Here is the full sentence:

```
The name lists partition the catalog's managed (`source:"remote"`) entries by what changed.
```

It turns out that there is something called a "name list", which partitions something in the catalog. Avoid sentences like this, because they make the reader realize halfway through reading the sentence that it doesn't that the words don't mean what the reader thought they meant, and they have to re-read the sentence to take into account the information they gained in the second half of the sentence. A classic garden path sentence begins with the words "the old man". What do you think it's going to tell us about the old man? Actually, the full sentence is "the old man the boat". Notice how the first half of the sentence makes you think it's talking about an old man, and it's not until you read the second half that you realize that it's talking about elderly people as a group.

Good: 

```
The catalog's entries are partitioned by name lists.
```

2. Use active voice, avoid passive voice.

Bad: "The man was bitten by the dog."
Good: "The dog bit the man."

Passive voice makes you focus on the person or object receiving the action, rather than the person or object performing it. Passive voice is typically harder to read and less interesting.

Other examples:

Bad: "Enclosing guard(cost:) budgets meter the subprocess in real time"
Good "The subprocess is metered in real time by enclosing guard(cost:) budgets."

3. Avoid introducing too many concepts in a single sentence.

If you find yourself using multiple commas, semicolons, or conjunctions in a sentence, consider breaking it up into multiple sentences.

Bad:
```
The name lists partition the catalog's managed (`source:"remote"`) entries by what changed.
```

Notice how the sentence tries to squeeze in the `source:"remote"` qualifier to an already complicated sentence. If you need to parenthesize something in your sentence, consider whether it would be clearer as two sentences instead.

```
Parse command-line flags with strict number coercion, required flags and defaults, mutually-exclusive groups, and auto-generated `--help` / `--version`.
```

This sentence introduces so many things that by the time the reader has reached the end of the sentence, they have already forgotten the beginning of the sentence.

```
any interrupt no handler resolves surfaces to the user; responding resumes the subprocess exactly where it paused.
```

Here is an example where two sentences would have been clearer than one with a semicolon.

4. Emdash overuse

An emdash used sparingly can make the text more lively, but used all the time, it becomes jarring. If you are using an emdash, consider using a comma instead.

Bad: "The AST shape is the parser output, which matches what the formatter consumes — so an AST round-tripped through writeAST() produces canonical Agency source."
Good: "The AST shape is the parser output, which matches what the formatter consumes, so an AST round-tripped through writeAST() produces canonical Agency source."

Or use a conjunction instead of an emdash:
Bad: "Read and write happen inside the same interrupt — approving it approves both."
Good: "Read and write happen inside the same interrupt, so approving it approves both."

5. Consider whether this level of detail is actually required in the sentence.

You have a habit of trying to add more information in parentheses. Often, it's not needed, and actually hinders understanding by making the sentence longer.

Bad: "Exceeding a resource limit (wallClock, memory, ipcPayload, or stdout) kills the subprocess and returns a limit_exceeded failure."
Good: "Exceeding a resource limit kills the subprocess and returns a limit_exceeded failure."

Every time you add something in parentheses, consider that the user's brain is going to need to pause and add a new frame to their mental "stack" to capture this new information. Is that speed bump worth the information you're trying to convey?

