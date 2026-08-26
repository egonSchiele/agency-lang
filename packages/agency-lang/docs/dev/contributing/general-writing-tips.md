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

It turns out that there is something called a "name list", which partitions something in the catalog. Avoid sentences like this, because they make the reader realize halfway through reading the sentence that the words don't mean what the reader thought they meant, and they have to re-read the sentence to take into account the information they gained in the second half of the sentence. A classic garden path sentence begins with the words "the old man". What do you think it's going to tell us about the old man? Actually, the full sentence is "the old man the boat". Notice how the first half of the sentence makes you think it's talking about an old man, and it's not until you read the second half that you realize that it's talking about elderly people as a group.

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
Good: "The subprocess is metered in real time by enclosing guard(cost:) budgets."

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

## Structural rules

The rules above are about sentences. A text can pass all of them and still be hard to read, because its shape is wrong. These rules are about shape. Each example comes from a grading rubric that was rewritten by hand.

6. Write for the person who reads this later.

The reader is not the reviewer today, and it is not you. Anything that records your process does not belong: what you tried, what went wrong, why you added a rule. Git history keeps that.

Bad:

```
That handler approves reads of the packaged docs and rejects every other interrupt. Before it, the nodes used `with reject`, which also rejected the docs-tool reads: the coding agent asked for `handlers.md`, got "interrupt rejected", and invented a handler syntax from memory. Reads and greps of the working directory are still rejected.
```

Good:

```
That handler approves reads of the packaged docs and rejects every other interrupt.
```

The second and third sentences are the story of how the bug was found and a note for a follow-up. A future maintainer needs neither.

7. Show the example first, then describe it.

When the subject is code, put the code in a block before the prose. Then say one thing about it. Never put a code fragment inside a clause of a sentence.

Bad:

```
Handlers use the real syntax: `handle { ... } with (data) { ... }`, the outer handle block wraps the inner one, and each handler returns its verdict with approve(), reject(), or pass().
```

Good:

```
Here's an example of handler syntax:

    handle {
      foo()
    } with (data) {
      return match (data.effect) {
        "foo::bar" => approve()
        _ => pass()
      }
    }

The handler receives a parameter named `data`. `data` has an `effect` field for the effect name.
```

8. One kind of thing per paragraph.

An example, an explanation, a checklist, and a scoring rule are four kinds of thing. Give each its own paragraph, and number a checklist. A reader should never have to work out which sentence is which.

Bad: one paragraph that starts "Four things, each worth a quarter. (1) The interrupt is raised with...", describes syntax in the middle, and ends with two sentences about what scores zero.

Good:

```
<code example>

<one or two sentences explaining the example>

Make sure that:
1. ...
2. ...
3. ...

All three of these points count equally towards the final score.
```

9. One fact per sentence.

Rules 3 and 5 say when a sentence is too full. This rule is the target: split until each sentence carries one fact. A parenthetical is either a second sentence or it is nothing.

Bad:

```
It calls archiveNotes inside an inner handler that approves `notes::archive`, and that inner handler sits inside an outer handler that rejects `notes::archive` when the count is greater than 10 and otherwise expresses no opinion.
```

Good:

```
This function calls archiveNotes inside an inner handler that approves `notes::archive`, but that inner handler sits inside an outer handler. The outer handler rejects `notes::archive` when the count is greater than 10, and passes on it otherwise.
```

10. Say it plainly, and make the reader the actor.

Do not name a scheme cleverly, and do not write about code as if it were a person doing something. Tell the reader what they can do, and point them at the example.

Bad: "Four things, each worth a quarter."
Good: "All four of these points count equally towards the final score."

Bad: "A match arm can carry a condition, as the `std::write` arm does."
Good: "You can set guards on match arms. See the `"std::write"` arm for an example."

Bad: "The reject arm has the last word: anything the earlier arms let through, it turns away."
Good: "The `_` arm rejects every other effect."

In the first bad example the match arm is the actor. In the second, the phrase "has the last word" is a metaphor standing in for a fact.
